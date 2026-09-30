import fc from 'fast-check';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newRambleId, parseRambleId } from '../shared/ids';
import { createApp } from './app';
import type { UserDataNamespace } from './env';
import { createFakeNamespace } from './testing/fake-namespace';

const TEAM = 'https://team.cloudflareaccess.com';

const AUD = 'app-audience';

let privateKey: CryptoKey;

let strangerKey: CryptoKey;

let keys: () => ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	privateKey = pair.privateKey;
	strangerKey = (await generateKeyPair('RS256')).privateKey;

	const jwks = createLocalJWKSet({
		keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }]
	});

	keys = () => jwks;
});

type Claims = { issuer?: string; audience?: string; subject?: string; expires?: string | number };

const sign = (
	{ issuer = TEAM, audience = AUD, subject, expires = '10m' }: Claims,
	key = privateKey
) => {
	const jwt = new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
		.setIssuer(issuer)
		.setAudience(audience)
		.setExpirationTime(expires);

	return (subject === undefined ? jwt : jwt.setSubject(subject)).sign(key);
};

let namespace: ReturnType<typeof createFakeNamespace>;

// Every user whose data a request reached.
let reached: string[];

beforeEach(() => {
	namespace = createFakeNamespace();
	reached = [];
});

afterEach(() => namespace.close());

const watched: UserDataNamespace = {
	getByName(name) {
		reached.push(name);

		return namespace.getByName(name);
	}
};

const env = (extra: { DEV_USER_ID?: string } = {}) => ({
	USER_DATA: watched,
	ACCESS_TEAM_DOMAIN: TEAM,
	ACCESS_AUD: AUD,
	...extra
});

type Json = z.output<ReturnType<typeof z.json>>;

async function send({
	token,
	method,
	path,
	json,
	dev = false
}: {
	token: string | null;
	method: string;
	path: string;
	json?: Json;
	dev?: boolean;
}) {
	const headers = new Headers();

	if (token !== null) headers.set('cf-access-jwt-assertion', token);

	if (json !== undefined) headers.set('content-type', 'application/json');

	return createApp({ dev, keys }).request(
		path,
		{ method, headers, body: json === undefined ? null : JSON.stringify(json) },
		env(dev ? { DEV_USER_ID: 'dev' } : {})
	);
}

const as = (sub: string) => async (method: string, path: string, json?: Json) =>
	send({ token: await sign({ subject: sub }), method, path, json });

const ID = '0abcdefgh-abcdefgh';

const API_ROUTES = [
	['GET', '/api/config'],
	['GET', '/api/home'],
	['PUT', '/api/ramble'],
	['POST', '/api/ramble/end'],
	['POST', '/api/ramble/split'],
	['GET', `/api/ramble/${ID}`],
	['PUT', `/api/ramble/${ID}`],
	['GET', `/api/thought/${ID}`],
	['PUT', `/api/thought/${ID}`],
	['DELETE', `/api/thought/${ID}`]
] as const;

describe('access', () => {
	it.each<[string, () => Promise<string | null>]>([
		['no token', async () => null],
		[
			'an expired token',
			() => sign({ subject: 'me', expires: Math.floor(Date.now() / 1000) - 60 })
		],
		['another audience', () => sign({ subject: 'me', audience: 'other-app' })],
		['another issuer', () => sign({ subject: 'me', issuer: 'https://evil.cloudflareaccess.com' })],
		['no subject', () => sign({})],
		['an empty subject', () => sign({ subject: '' })],
		['a stranger’s signature', () => sign({ subject: 'me' }, strangerKey)]
	])('refuses %s on every API route and reaches no data', async (_name, token) => {
		for (const [method, path] of API_ROUTES) {
			const json = method === 'GET' ? undefined : {};
			const res = await send({ token: await token(), method, path, json });
			expect(res.status, `${method} ${path}`).toBe(401);
		}

		expect(reached).toEqual([]);
	});

	it('never reaches user data without a token, whatever the path', async () => {
		const path = fc.oneof(
			fc.constantFrom('/api', '/api/', '/api//home', '/api/home/', '/%61pi/home', '/api/%68ome'),
			fc.webPath(),
			fc.webPath().map((rest) => `/api${rest}`)
		);

		await fc.assert(
			fc.asyncProperty(path, fc.constantFrom('GET', 'PUT', 'POST', 'DELETE'), async (p, method) => {
				await send({ token: null, method, path: p, json: method === 'GET' ? undefined : {} });
				expect(reached, `${method} ${p}`).toEqual([]);
			}),
			{ numRuns: 200 }
		);
	});

	it('serves no user data outside /api, even when signed in', async () => {
		const token = await sign({ subject: 'me' });

		for (const path of ['/', '/home', `/ramble/${ID}`, `/thought/${ID}`, '/apihome', '/API/home']) {
			for (const dev of [false, true]) {
				const res = await send({ token, method: 'GET', path, dev });
				expect(res.status, path).toBe(404);
			}
		}

		expect(reached).toEqual([]);
	});

	it('ignores DEV_USER_ID in the production app, with or without a token', async () => {
		const app = createApp({ dev: false, keys });
		const devEnv = env({ DEV_USER_ID: 'dev' });
		expect((await app.request('/api/home', {}, devEnv)).status).toBe(401);

		const signed = { headers: { 'cf-access-jwt-assertion': await sign({ subject: 'alice' }) } };
		expect((await app.request('/api/home', signed, devEnv)).status).toBe(200);
		expect(reached).toEqual(['alice']);
	});
});

const homeReply = z.object({
	draft: z.object({ id: z.string(), body: z.string() }).nullable(),
	thoughts: z.array(z.object({ id: z.string(), body: z.string(), revision: z.number() })),
	pending: z.array(z.object({ id: z.string(), body: z.string() }))
});

const revisionReply = z.object({ revision: z.number() });

describe('an edit through the API answers with the new revision', () => {
	it('for a ramble, so a write from elsewhere between two saves gives 409', async () => {
		const me = as('me');
		await me('PUT', '/api/ramble', { id: ID, body: 'first', base: null });
		const path = `/api/ramble/${ID}`;

		const stored = async () =>
			z
				.object({ ramble: z.object({ revision: z.number(), body: z.string() }) })
				.parse(await (await me('GET', path)).json()).ramble;

		const mine = await (await me('PUT', path, { body: 'mine', revision: 1 })).json();
		expect(mine).toEqual({ revision: (await stored()).revision });
		await me('PUT', path, { body: 'theirs', revision: (await stored()).revision });

		const again = await me('PUT', path, {
			body: 'again',
			revision: revisionReply.parse(mine).revision
		});

		expect(again.status).toBe(409);
		expect((await stored()).body).toBe('theirs');
	});

	it('for a thought, so a write from elsewhere between two saves gives 409', async () => {
		const me = as('me');
		await me('PUT', '/api/ramble', { id: ID, body: 'a ramble', base: null });
		await me('POST', '/api/ramble/end', { id: ID });
		await me('POST', '/api/ramble/split', { id: ID, revision: 2, proposals: [] });
		const [thought] = homeReply.parse(await (await me('GET', '/api/home')).json()).thoughts;

		if (!thought) throw new Error('the split published no thought');
		const path = `/api/thought/${thought.id}`;

		const stored = async () =>
			z
				.object({ revision: z.number(), body: z.string() })
				.parse(await (await me('GET', path)).json());

		const mine = await (await me('PUT', path, { revision: thought.revision, body: 'mine' })).json();
		expect(mine).toEqual({ revision: (await stored()).revision });
		await me('PUT', path, { revision: (await stored()).revision, body: 'theirs' });

		const again = await me('PUT', path, {
			revision: revisionReply.parse(mine).revision,
			body: 'again'
		});

		expect(again.status).toBe(409);
		expect((await stored()).body).toBe('theirs');
	});
});

describe('a save resent after a lost reply', () => {
	it('answers with the same ramble, whether unchanged or typed further', async () => {
		const me = as('me');
		const id = newRambleId();
		await me('PUT', '/api/ramble', { id, body: 'first', base: null });

		expect(
			await (await me('PUT', '/api/ramble', { id, body: 'first', base: null })).json()
		).toEqual({
			id,
			revision: 1
		});
		expect(
			await (await me('PUT', '/api/ramble', { id, body: 'first and more', base: null })).json()
		).toEqual({ id, revision: 2 });
	});
});

const savedReply = z.object({
	id: z.string().transform((raw) => parseRambleId(raw) ?? newRambleId())
});

type UserOp = { user: 0 | 1; kind: 'save' | 'end' | 'split' };

describe('isolation', () => {
	it('never shows one user another user’s rambles or thoughts, in any order of use', async () => {
		const op = fc.record({
			user: fc.constantFrom(0 as const, 1 as const),
			kind: fc.constantFrom('save' as const, 'end' as const, 'split' as const)
		});

		await fc.assert(
			fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops: UserOp[]) => {
				// Upper case, so a marker never turns up inside a lower-case id by chance.
				const names = ['ALICE', 'BOB'] as const;
				const users = names.map((name) => ({ name, send: as(name), id: newRambleId(), text: '' }));

				for (const { user, kind } of ops) {
					const u = users[user];

					if (kind === 'save') {
						u.text += `${u.name} `;

						const saved = await u.send('PUT', '/api/ramble', {
							id: u.id,
							body: u.text,
							base: null
						});

						u.id = savedReply.parse(await saved.json()).id;
					}

					if (kind === 'end') await u.send('POST', '/api/ramble/end', { id: u.id });

					if (kind === 'split')
						await u.send('POST', '/api/ramble/split', { id: u.id, revision: 2, proposals: [] });
				}

				for (const [index, u] of users.entries()) {
					const other = users[1 - index];
					const home = await (await u.send('GET', '/api/home')).text();
					expect(home).not.toContain(other.name);
					expect((await u.send('GET', `/api/ramble/${other.id}`)).status).not.toBe(200);
				}
			}),
			{ numRuns: 40 }
		);
	});
});
