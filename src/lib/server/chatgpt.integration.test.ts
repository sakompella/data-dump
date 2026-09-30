import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { newRambleId } from '$lib/ids';
import { createChatGPTAuth } from './chatgpt-auth';
import { createRambleService } from './rambles';
import { createSplitter } from './splitter';
import { createStore } from './store';

const BODY = 'Rev keeps stalling. maybe email Michael about Friday';

const ANSWER = JSON.stringify({
	thoughts: [
		{ label: 'Rev', text: 'Rev keeps stalling.', todo: false },
		{ label: 'Michael', text: 'maybe email Michael about Friday', todo: true }
	]
});

// One local server playing both auth.openai.com and api.openai.com.
function fakeOpenAI() {
	const challenges = new Map<string, string>();

	const apiTokens: string[] = [];

	const state = {
		issued: 0,
		refreshRefused: false,
		rejectNextApiCall: false,
		apiTokens
	};

	const readBody = async (request: IncomingMessage) => {
		let text = '';

		for await (const chunk of request) text += chunk;

		return text;
	};

	const grant = () => {
		state.issued += 1;

		return {
			access_token: `access-${state.issued}`,
			refresh_token: `refresh-${state.issued}`,
			id_token: 'id',
			expires_in: 3600,
			scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct'
		};
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://fake');

		if (url.pathname === '/api/accounts/authorize') {
			const code = `code-${challenges.size}`;
			challenges.set(code, url.searchParams.get('code_challenge') ?? '');
			const back = new URL(url.searchParams.get('redirect_uri') ?? '');
			back.search = new URLSearchParams({
				code,
				state: url.searchParams.get('state') ?? '',
				client_id: 'issued-client'
			}).toString();
			response.writeHead(302, { location: back.toString() }).end();

			return;
		}

		if (url.pathname === '/api/accounts/oauth/token') {
			const form = new URLSearchParams(await readBody(request));

			const ok =
				form.get('client_id') === 'issued-client' &&
				form.get('resource') === 'https://api.openai.com/v1' &&
				(form.get('grant_type') === 'authorization_code'
					? createHash('sha256')
							.update(form.get('code_verifier') ?? '')
							.digest('base64url') === challenges.get(form.get('code') ?? '')
					: form.get('refresh_token') === `refresh-${state.issued}` && !state.refreshRefused);

			response.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
			response.end(JSON.stringify(ok ? grant() : { error: 'invalid_grant' }));

			return;
		}

		if (url.pathname === '/v1/responses') {
			await readBody(request);
			const token = request.headers.authorization ?? '';
			state.apiTokens.push(token);

			if (state.rejectNextApiCall || token !== `Bearer access-${state.issued}`) {
				state.rejectNextApiCall = false;
				response.writeHead(401).end();

				return;
			}

			response.writeHead(200, { 'content-type': 'text/event-stream' });

			const events = [
				...ANSWER.match(/.{1,9}/gs)!.map((delta) => ({
					type: 'response.output_text.delta',
					delta
				})),
				{ type: 'response.completed', response: {} }
			];

			const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');

			for (let i = 0; i < text.length; i += 17) response.write(text.slice(i, i + 17));
			response.end('data: [DONE]\r\n\r\n');

			return;
		}

		response.writeHead(404).end();
	});

	return { server, state };
}

let dataDir: string;

let server: Server;

let fake: ReturnType<typeof fakeOpenAI>;

let base: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'data-dump-chatgpt-'));
	fake = fakeOpenAI();
	server = fake.server;
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(dataDir, { recursive: true, force: true });
});

it('connects, splits, refreshes, and waits when ChatGPT needs a reconnect', async () => {
	let clock = new Date('2026-01-01T00:00:00Z');

	const auth = createChatGPTAuth({
		dir: join(dataDir, 'auth'),
		now: () => clock,
		authBaseUrl: base
	});

	const store = createStore(dataDir);
	await store.init();

	const split = createSplitter({
		env: { CHATGPT_MODEL: 'gpt-test' },
		chatgpt: auth,
		chatgptApiBaseUrl: `${base}/v1`
	});

	const service = createRambleService({ store, split });

	const signIn = await auth.startLogin();
	const landing = await fetch(signIn, { redirect: 'manual' });
	const pasted = landing.headers.get('location') ?? '';
	expect(pasted.startsWith('http://127.0.0.1:1455/auth/callback?')).toBe(true);
	expect(await auth.completeLogin(pasted)).toEqual({ ok: true });

	const first = newRambleId();
	await service.saveDraft({ id: first, body: BODY });
	await service.endRamble(first);
	expect(await store.readRamble(first)).toMatchObject({ status: 'split' });
	expect((await store.listThoughts()).map((t) => t.body).sort()).toEqual([
		'Rev keeps stalling.',
		'maybe email Michael about Friday'
	]);

	clock = new Date(clock.getTime() + 60 * 60 * 1000);
	const second = newRambleId();
	await service.saveDraft({ id: second, body: BODY });
	await service.endRamble(second);
	expect(await store.readRamble(second)).toMatchObject({ status: 'split' });
	expect(fake.state.apiTokens.at(-1)).toBe('Bearer access-2');

	fake.state.rejectNextApiCall = true;
	fake.state.refreshRefused = true;
	const third = newRambleId();
	await service.saveDraft({ id: third, body: BODY });
	await service.endRamble(third);
	expect(await store.readRamble(third)).toMatchObject({ status: 'ended' });
	expect(await auth.status()).toBe('needs-reconnect');
});
