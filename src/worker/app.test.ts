import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from './app';
import { createFakeNamespace } from './testing/fake-namespace';

const TEAM = 'https://team.cloudflareaccess.com';

const AUD = 'app-audience';

const BODY = 'Rev keeps stalling. maybe email Michael about Friday';

let privateKey: CryptoKey;

let keys: () => ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	privateKey = pair.privateKey;

	const jwks = createLocalJWKSet({
		keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }]
	});

	keys = () => jwks;
});

const tokenFor = (sub: string) =>
	new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
		.setIssuer(TEAM)
		.setAudience(AUD)
		.setSubject(sub)
		.setExpirationTime('10m')
		.sign(privateKey);

let namespace: ReturnType<typeof createFakeNamespace>;

beforeEach(() => {
	namespace = createFakeNamespace();
});

afterEach(() => namespace.close());

const env = () => ({
	USER_DATA: namespace,
	ACCESS_TEAM_DOMAIN: TEAM,
	ACCESS_AUD: AUD,
	CHATGPT_MODEL: 'test-model'
});

// A signed-in user's requests to the production app (no dev shortcut).
function user(sub: string) {
	const app = createApp({ dev: false, keys });

	return async (method: string, path: string, json?: z.output<ReturnType<typeof z.json>>) => {
		const headers = new Headers({ 'cf-access-jwt-assertion': await tokenFor(sub) });

		if (json !== undefined) headers.set('content-type', 'application/json');

		return app.request(
			path,
			{ method, headers, body: json === undefined ? null : JSON.stringify(json) },
			env()
		);
	};
}

const idReply = z.object({ id: z.string() });

const rambleReply = z.object({ ramble: z.object({ body: z.string() }) });

const thoughtReply = z.object({
	id: z.string(),
	revision: z.number(),
	body: z.string(),
	todo: z.string()
});

const homeReply = z.object({
	pending: z.array(z.unknown()),
	thoughts: z.array(thoughtReply)
});

async function read<Schema extends z.ZodType>(
	res: Response,
	schema: Schema
): Promise<z.output<Schema>> {
	return schema.parse(await res.json());
}

const ID = '0abcdefgh-abcdefgh';

const OTHER_ID = '0abcdefgh-ijklmnop';

describe('access', () => {
	it('answers 401 without a token, with a bad token, and without configuration', async () => {
		const app = createApp({ dev: false, keys });
		expect((await app.request('/api/home', {}, env())).status).toBe(401);

		const bad = { headers: { 'cf-access-jwt-assertion': 'a.b.c' } };
		expect((await app.request('/api/home', bad, env())).status).toBe(401);

		const signed = { headers: { 'cf-access-jwt-assertion': await tokenFor('me') } };
		const unconfigured = { USER_DATA: namespace };
		expect((await app.request('/api/home', signed, unconfigured)).status).toBe(401);
	});

	it('ignores DEV_USER_ID outside dev and honors it in dev', async () => {
		const devEnv = { USER_DATA: namespace, DEV_USER_ID: 'me' };
		expect((await createApp({ dev: false, keys }).request('/api/home', {}, devEnv)).status).toBe(
			401
		);
		expect((await createApp({ dev: true, keys }).request('/api/home', {}, devEnv)).status).toBe(
			200
		);
	});

	it('protects every route', async () => {
		const app = createApp({ dev: false, keys });

		for (const [method, path] of [
			['GET', '/api/config'],
			['PUT', '/api/ramble'],
			['POST', '/api/ramble/end'],
			['POST', '/api/ramble/split'],
			['GET', `/api/ramble/${ID}`],
			['PUT', `/api/ramble/${ID}`],
			['GET', `/api/thought/${ID}`],
			['PUT', `/api/thought/${ID}`],
			['DELETE', `/api/thought/${ID}`],
			['GET', '/api/unknown']
		]) {
			expect((await app.request(path, { method }, env())).status, `${method} ${path}`).toBe(401);
		}
	});
});

describe('config', () => {
	it('gives the model name and nothing secret', async () => {
		const res = await user('me')('GET', '/api/config');
		expect(await res.json()).toEqual({ chatgptModel: 'test-model' });
	});
});

describe('validation', () => {
	it('answers 400 with a JSON error for malformed input', async () => {
		const me = user('me');

		for (const [method, path, body] of [
			['PUT', '/api/ramble', { id: 'nope', body: 'x', base: null }],
			['PUT', '/api/ramble', { id: ID, body: 'x', base: 0 }],
			['PUT', '/api/ramble', { id: ID }],
			['POST', '/api/ramble/end', {}],
			['POST', '/api/ramble/split', { id: ID, revision: 2, proposals: 'none' }],
			['PUT', '/api/thought/not-an-id', { revision: 1 }],
			['PUT', `/api/thought/${ID}`, { revision: 1, todo: 'someday' }],
			['DELETE', `/api/thought/${ID}`, {}]
		] as const) {
			const res = await me(method, path, body);
			expect(res.status, `${method} ${path}`).toBe(400);
			expect(await res.json()).toEqual({ error: 'invalid request' });
		}
	});

	it('refuses more proposals than the limit and oversized requests', async () => {
		const me = user('me');
		const proposal = { label: 'l', text: 'x', todo: false };
		const tooMany = Array.from({ length: 101 }, () => proposal);
		expect(
			(await me('POST', '/api/ramble/split', { id: ID, revision: 2, proposals: tooMany })).status
		).toBe(400);
		expect(
			(await me('PUT', '/api/ramble', { id: ID, body: 'x'.repeat(2_100_000), base: null })).status
		).toBe(413);
	});

	it('answers unknown API paths with a JSON 404', async () => {
		const res = await user('me')('GET', '/api/unknown');
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not found' });
	});
});

describe('ramble lifecycle', () => {
	it('saves, ends, splits, and shows the thoughts', async () => {
		const me = user('me');
		const saved = await me('PUT', '/api/ramble', { id: ID, body: BODY, base: null });
		expect(await saved.json()).toEqual({ id: ID, revision: 1 });

		const ended = await me('POST', '/api/ramble/end', { id: ID });
		expect(await ended.json()).toEqual({ toSplit: { id: ID, body: BODY, revision: 2 } });

		const home = await read(await me('GET', '/api/home'), homeReply);
		expect(home.pending).toEqual([{ id: ID, body: BODY, revision: 2 }]);

		const proposals = [{ label: 'Rev', text: 'Rev keeps stalling.', todo: true }];
		const split = await me('POST', '/api/ramble/split', { id: ID, revision: 2, proposals });
		expect(split.status).toBe(200);

		const after = await read(await me('GET', '/api/home'), homeReply);
		expect(after.pending).toEqual([]);
		expect(after.thoughts).toHaveLength(1);
		expect(after.thoughts[0]).toMatchObject({ body: 'Rev keeps stalling.', todo: 'open' });
	});

	it('turns the whole ramble into one thought when no proposals arrive', async () => {
		const me = user('me');
		await me('PUT', '/api/ramble', { id: ID, body: BODY, base: null });
		await me('POST', '/api/ramble/end', { id: ID });
		await me('POST', '/api/ramble/split', { id: ID, revision: 2, proposals: [] });
		const home = await read(await me('GET', '/api/home'), homeReply);
		expect(home.thoughts.map((thought) => thought.body)).toEqual([BODY]);
	});

	it('puts a stale save into a replacement ramble', async () => {
		const me = user('me');
		await me('PUT', '/api/ramble', { id: ID, body: 'first', base: null });
		await me('PUT', '/api/ramble', { id: ID, body: 'first, then A', base: 1 });

		const late = await read(
			await me('PUT', '/api/ramble', { id: ID, body: 'first, then B', base: 1 }),
			idReply
		);

		expect(late.id).not.toBe(ID);
		const kept = await read(await me('GET', `/api/ramble/${ID}`), rambleReply);
		expect(kept.ramble.body).toBe('first, then A');
		const replacement = await read(await me('GET', `/api/ramble/${late.id}`), rambleReply);
		expect(replacement.ramble.body).toBe('first, then B');
	});

	it('answers 409 when a split is based on an edited ramble, and 404 for a missing one', async () => {
		const me = user('me');
		await me('PUT', '/api/ramble', { id: ID, body: BODY, base: null });
		await me('POST', '/api/ramble/end', { id: ID });
		expect((await me('PUT', `/api/ramble/${ID}`, { body: 'edited', revision: 2 })).status).toBe(
			200
		);

		const stale = await me('POST', '/api/ramble/split', { id: ID, revision: 2, proposals: [] });
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({ error: 'changed elsewhere' });
		expect(
			(await me('POST', '/api/ramble/split', { id: OTHER_ID, revision: 2, proposals: [] })).status
		).toBe(404);
	});

	it('answers 409 for a split of a ramble that is still open', async () => {
		const me = user('me');
		await me('PUT', '/api/ramble', { id: ID, body: BODY, base: null });
		expect(
			(await me('POST', '/api/ramble/split', { id: ID, revision: 1, proposals: [] })).status
		).toBe(409);
	});

	it('edits a ramble with its revision and answers 409 or 404 otherwise', async () => {
		const me = user('me');
		await me('PUT', '/api/ramble', { id: ID, body: BODY, base: null });
		expect((await me('PUT', `/api/ramble/${ID}`, { body: 'new', revision: 1 })).status).toBe(200);
		expect((await me('PUT', `/api/ramble/${ID}`, { body: 'again', revision: 1 })).status).toBe(409);
		expect((await me('PUT', `/api/ramble/${OTHER_ID}`, { body: 'x', revision: 1 })).status).toBe(
			404
		);
		expect((await me('GET', `/api/ramble/${OTHER_ID}`)).status).toBe(404);
	});
});

describe('thoughts', () => {
	async function firstThought(me: ReturnType<typeof user>) {
		await me('PUT', '/api/ramble', { id: ID, body: BODY, base: null });
		await me('POST', '/api/ramble/end', { id: ID });
		await me('POST', '/api/ramble/split', { id: ID, revision: 2, proposals: [] });
		const { thoughts } = await read(await me('GET', '/api/home'), homeReply);
		const [first] = thoughts;

		if (!first) throw new Error('the split published no thought');

		return first;
	}

	it('edits with a fresh revision and refuses a stale one', async () => {
		const me = user('me');

		const thought = await firstThought(me);
		const path = `/api/thought/${thought.id}`;
		expect((await me('PUT', path, { revision: thought.revision, todo: 'done' })).status).toBe(200);

		const stale = await me('PUT', path, { revision: thought.revision, label: 'x' });
		expect(stale.status).toBe(409);
		expect((await read(await me('GET', path), thoughtReply)).todo).toBe('done');
	});

	it('deletes with a fresh revision, refuses a stale one, and then finds nothing', async () => {
		const me = user('me');
		const thought = await firstThought(me);
		const path = `/api/thought/${thought.id}`;
		await me('PUT', path, { revision: thought.revision, todo: 'done' });

		expect((await me('DELETE', path, { revision: thought.revision })).status).toBe(409);
		expect((await me('DELETE', path, { revision: thought.revision + 1 })).status).toBe(200);
		expect((await me('GET', path)).status).toBe(404);
		expect((await me('DELETE', path, { revision: 1 })).status).toBe(404);
	});
});

describe('isolation', () => {
	it('never shows one user the data of another', async () => {
		const alice = user('alice');
		const bob = user('bob');
		await alice('PUT', '/api/ramble', { id: ID, body: BODY, base: null });
		await alice('POST', '/api/ramble/end', { id: ID });
		await alice('POST', '/api/ramble/split', { id: ID, revision: 2, proposals: [] });
		const { thoughts } = await read(await alice('GET', '/api/home'), homeReply);
		const thoughtPath = `/api/thought/${thoughts[0]?.id}`;

		expect(await (await bob('GET', '/api/home')).json()).toEqual({
			draft: null,
			thoughts: [],
			pending: []
		});
		expect((await bob('GET', `/api/ramble/${ID}`)).status).toBe(404);
		expect((await bob('GET', thoughtPath)).status).toBe(404);
		expect((await bob('PUT', thoughtPath, { revision: 1, label: 'mine now' })).status).toBe(404);
		expect((await bob('DELETE', thoughtPath, { revision: 1 })).status).toBe(404);
		expect((await alice('GET', thoughtPath)).status).toBe(200);
	});
});
