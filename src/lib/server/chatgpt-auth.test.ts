import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createChatGPTAuth,
	parseCallbackUrl,
	PENDING_LOGIN_TTL_MS,
	type PendingLogin
} from './chatgpt-auth';

const AUTH = 'https://auth.test';

const REDIRECT = 'http://127.0.0.1:1455/auth/callback';

const HOUR_S = 3600;

const pending: PendingLogin = {
	verifier: 'verifier',
	state: 'the-state',
	nonce: 'nonce',
	redirectUri: REDIRECT,
	createdAt: new Date('2026-01-01T00:00:00Z')
};

const justAfter = new Date(pending.createdAt.getTime() + 1000);

const callback = (params: Record<string, string>, base = REDIRECT) =>
	`${base}?${new URLSearchParams(params)}`;

const goodParams = { code: 'the-code', state: 'the-state', client_id: 'issued-client' };

describe('parseCallbackUrl', () => {
	it('accepts the exact redirect address with the stored state', () => {
		expect(parseCallbackUrl(callback(goodParams), pending, justAfter)).toEqual({
			ok: true,
			code: 'the-code',
			clientId: 'issued-client'
		});
	});

	it.each([
		['localhost instead of 127.0.0.1', 'http://localhost:1455/auth/callback'],
		['another port', 'http://127.0.0.1:1456/auth/callback'],
		['https', 'https://127.0.0.1:1455/auth/callback'],
		['another path', 'http://127.0.0.1:1455/auth/callback/extra'],
		['another host', 'https://evil.test/auth/callback']
	])('rejects %s', (_name, base) => {
		expect(parseCallbackUrl(callback(goodParams, base), pending, justAfter).ok).toBe(false);
	});

	it('rejects any address whose origin or path differs from the stored one', () => {
		fc.assert(
			fc.property(fc.webUrl(), (url) => {
				const parsed = new URL(url);
				fc.pre(parsed.origin + parsed.pathname !== REDIRECT);
				parsed.search = new URLSearchParams(goodParams).toString();
				expect(parseCallbackUrl(parsed.toString(), pending, justAfter).ok).toBe(false);
			})
		);
	});

	it.each([
		['a wrong state', { ...goodParams, state: 'other' }],
		['no state', { code: 'the-code', client_id: 'issued-client' }],
		['an error param', { ...goodParams, error: 'access_denied' }],
		['no code', { state: 'the-state', client_id: 'issued-client' }],
		['no issued client id', { code: 'the-code', state: 'the-state' }]
	])('rejects %s', (_name, params: Record<string, string>) => {
		expect(parseCallbackUrl(callback(params), pending, justAfter).ok).toBe(false);
	});

	it('rejects text that is not an address', () => {
		expect(parseCallbackUrl('the-code', pending, justAfter).ok).toBe(false);
	});

	it('rejects a pending login older than ten minutes', () => {
		const late = new Date(pending.createdAt.getTime() + PENDING_LOGIN_TTL_MS + 1);
		expect(parseCallbackUrl(callback(goodParams), pending, late).ok).toBe(false);
		const inTime = new Date(pending.createdAt.getTime() + PENDING_LOGIN_TTL_MS);
		expect(parseCallbackUrl(callback(goodParams), pending, inTime).ok).toBe(true);
	});
});

type TokenReply = { status: number; json?: unknown };

// Fake token endpoint. Each request takes the next reply; fields are recorded.
function fakeTokenServer(replies: TokenReply[]) {
	const requests: URLSearchParams[] = [];

	const fetch: typeof globalThis.fetch = async (input, init) => {
		expect(String(input)).toBe(`${AUTH}/api/accounts/oauth/token`);
		requests.push(new URLSearchParams(String(init?.body)));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const reply = replies.shift();

		if (!reply) throw new Error('unexpected token request');

		return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status });
	};

	return { fetch, requests };
}

const grant = (n: number, extra: { id_token?: string; scope?: string } = {}): TokenReply => ({
	status: 200,
	json: {
		access_token: `access-${n}`,
		refresh_token: `refresh-${n}`,
		expires_in: HOUR_S,
		scope: 'openid offline_access chatgpt.tokens.use.direct',
		...extra
	}
});

let dir: string;

let clock: Date;

const now = () => clock;

const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), 'data-dump-auth-')), 'auth');
	clock = new Date('2026-01-01T00:00:00Z');
});

afterEach(() => rm(join(dir, '..'), { recursive: true, force: true }));

async function connect(replies: TokenReply[]) {
	const server = fakeTokenServer([grant(1, { id_token: 'id' }), ...replies]);
	const auth = createChatGPTAuth({ dir, fetch: server.fetch, now, authBaseUrl: AUTH });
	const url = await auth.startLogin();
	const state = url.searchParams.get('state') ?? '';
	const result = await auth.completeLogin(callback({ ...goodParams, state }));
	expect(result).toEqual({ ok: true });

	return { auth, server, url };
}

const readTokenFile = async () => JSON.parse(await readFile(join(dir, 'chatgpt.json'), 'utf8'));

describe('login', () => {
	it('builds the authorize address with PKCE and a stable device id', async () => {
		const auth = createChatGPTAuth({ dir, now, authBaseUrl: AUTH });
		const first = await auth.startLogin();
		const second = await auth.startLogin();
		const stored = JSON.parse(await readFile(join(dir, 'pending.json'), 'utf8'));

		expect(first.origin + first.pathname).toBe(`${AUTH}/api/accounts/authorize`);
		const params = Object.fromEntries(second.searchParams);
		expect(params).toMatchObject({
			client_id: 'dynamic_agent_client',
			response_type: 'code',
			redirect_uri: REDIRECT,
			resource: 'https://api.openai.com/v1',
			scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
			code_challenge_method: 'S256',
			state: stored.state,
			nonce: stored.nonce
		});
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stored.verifier));
		expect(params.code_challenge).toBe(Buffer.from(digest).toString('base64url'));
		expect(params.ext_agent_host_id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
		expect(first.searchParams.get('ext_agent_host_id')).toBe(params.ext_agent_host_id);
		expect(first.searchParams.get('state')).not.toBe(params.state);
	});

	it('exchanges the code with the issued client id and stores the tokens', async () => {
		const { auth, server } = await connect([]);
		const stored = JSON.parse(await readFile(join(dir, 'device.json'), 'utf8'));
		expect(stored.deviceId).toBeTruthy();
		expect(Object.fromEntries(server.requests[0])).toMatchObject({
			grant_type: 'authorization_code',
			client_id: 'issued-client',
			code: 'the-code',
			redirect_uri: REDIRECT,
			resource: 'https://api.openai.com/v1'
		});
		expect(server.requests[0].get('code_verifier')).toBeTruthy();
		expect(await auth.status()).toBe('connected');
		await expect(stat(join(dir, 'pending.json'))).rejects.toThrow();
	});

	it('round-trips the token file with mode 0600', async () => {
		const { auth } = await connect([]);
		expect(await readTokenFile()).toEqual({
			accessToken: 'access-1',
			refreshToken: 'refresh-1',
			expiresAt: new Date(clock.getTime() + HOUR_S * 1000 - 3 * 60 * 1000).toISOString(),
			clientId: 'issued-client',
			scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct']
		});
		expect((await stat(join(dir, 'chatgpt.json'))).mode & 0o777).toBe(0o600);
		const reread = createChatGPTAuth({ dir, now, authBaseUrl: AUTH });
		expect(await reread.accessToken()).toBe('access-1');
	});

	it('refuses a grant without the direct-use scope', async () => {
		const server = fakeTokenServer([grant(1, { id_token: 'id', scope: 'openid' })]);
		const auth = createChatGPTAuth({ dir, fetch: server.fetch, now, authBaseUrl: AUTH });
		const state = (await auth.startLogin()).searchParams.get('state') ?? '';
		expect((await auth.completeLogin(callback({ ...goodParams, state }))).ok).toBe(false);
		expect(await auth.status()).toBe('not-connected');
	});

	it('refuses a pasted address after the pending login expired', async () => {
		const auth = createChatGPTAuth({ dir, now, authBaseUrl: AUTH });
		const state = (await auth.startLogin()).searchParams.get('state') ?? '';
		advance(PENDING_LOGIN_TTL_MS + 1);
		expect((await auth.completeLogin(callback({ ...goodParams, state }))).ok).toBe(false);
	});

	it('shows the pending sign-in address until it expires or completes', async () => {
		const auth = createChatGPTAuth({ dir, now, authBaseUrl: AUTH });
		expect(await auth.pendingLogin()).toBeNull();
		const url = await auth.startLogin();
		expect((await auth.pendingLogin())?.toString()).toBe(url.toString());
		advance(PENDING_LOGIN_TTL_MS + 1);
		expect(await auth.pendingLogin()).toBeNull();

		const { auth: connected } = await connect([]);
		expect(await connected.pendingLogin()).toBeNull();
	});

	it('disconnect deletes the token file', async () => {
		const { auth } = await connect([]);
		await auth.disconnect();
		expect(await auth.status()).toBe('not-connected');
		await expect(stat(join(dir, 'chatgpt.json'))).rejects.toThrow();
	});
});

describe('refresh', () => {
	const untilRefresh = HOUR_S * 1000 - 3 * 60 * 1000 - 5 * 60 * 1000;

	it('keeps the token until it is within five minutes of the stored expiry', async () => {
		const { auth, server } = await connect([grant(2)]);
		advance(untilRefresh - 1);
		expect(await auth.accessToken()).toBe('access-1');
		expect(server.requests).toHaveLength(1);
		advance(1);
		expect(await auth.accessToken()).toBe('access-2');
		expect(Object.fromEntries(server.requests[1])).toEqual({
			grant_type: 'refresh_token',
			client_id: 'issued-client',
			refresh_token: 'refresh-1',
			resource: 'https://api.openai.com/v1'
		});
		expect(await readTokenFile()).toMatchObject({
			accessToken: 'access-2',
			refreshToken: 'refresh-2'
		});
	});

	it('refreshes once for concurrent callers', async () => {
		const { auth, server } = await connect([grant(2)]);
		advance(untilRefresh);
		const tokens = await Promise.all(Array.from({ length: 5 }, () => auth.accessToken()));
		expect(tokens).toEqual(Array(5).fill('access-2'));
		expect(server.requests).toHaveLength(2);
	});

	it('refreshes once after concurrent rejections of the same token', async () => {
		const { auth, server } = await connect([grant(2)]);

		const tokens = await Promise.all(
			Array.from({ length: 3 }, () => auth.accessTokenAfterRejection('access-1'))
		);

		expect(tokens).toEqual(Array(3).fill('access-2'));
		expect(server.requests).toHaveLength(2);
	});

	it('marks the connection as needing reconnect when the refresh is refused', async () => {
		const { auth, server } = await connect([{ status: 400, json: { error: 'invalid_grant' } }]);
		advance(untilRefresh);
		await expect(auth.accessToken()).rejects.toThrow();
		expect(await auth.status()).toBe('needs-reconnect');
		await expect(auth.accessToken()).rejects.toThrow();
		expect(server.requests).toHaveLength(2);
		expect(await readTokenFile()).toMatchObject({ refreshToken: 'refresh-1' });
	});

	it('stays connected when the token server is down', async () => {
		const { auth } = await connect([{ status: 503 }, grant(2)]);
		advance(untilRefresh);
		await expect(auth.accessToken()).rejects.toThrow();
		expect(await auth.status()).toBe('connected');
		expect(await auth.accessToken()).toBe('access-2');
	});

	it('a new login clears needs-reconnect', async () => {
		const { auth } = await connect([{ status: 400 }, grant(3, { id_token: 'id' })]);
		advance(untilRefresh);
		await expect(auth.accessToken()).rejects.toThrow();
		const state = (await auth.startLogin()).searchParams.get('state') ?? '';
		expect(await auth.completeLogin(callback({ ...goodParams, state }))).toEqual({ ok: true });
		expect(await auth.status()).toBe('connected');
		expect(await auth.accessToken()).toBe('access-3');
	});
});
