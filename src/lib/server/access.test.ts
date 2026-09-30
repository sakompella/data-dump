import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type CryptoKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { identify, parseAccessConfig, parseUserId } from './access';

const TEAM = 'https://team.cloudflareaccess.com';

const AUD = 'app-audience';

const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

let privateKey: CryptoKey;

let otherKey: CryptoKey;

let keys: () => ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
	const pair = await generateKeyPair('RS256');
	privateKey = pair.privateKey;
	otherKey = (await generateKeyPair('RS256')).privateKey;
	const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
	const jwks = createLocalJWKSet({ keys: [jwk] });
	keys = () => jwks;
});

type Claims = { iss?: string; aud?: string; sub?: string; exp?: number };

const nowS = () => Math.floor(Date.now() / 1000);

async function token(claims: Claims, key = privateKey) {
	const jwt = new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt();

	if (claims.iss !== undefined) jwt.setIssuer(claims.iss);

	if (claims.aud !== undefined) jwt.setAudience(claims.aud);

	if (claims.sub !== undefined) jwt.setSubject(claims.sub);

	if (claims.exp !== undefined) jwt.setExpirationTime(claims.exp);

	return jwt.sign(key);
}

const good: Claims = { iss: TEAM, aud: AUD, sub: 'user-1', exp: nowS() + 600 };

describe('identify in production', () => {
	it('accepts a valid token and uses its subject', async () => {
		expect(await identify({ dev: false, env, token: await token(good), keys })).toEqual({
			ok: true,
			userId: 'user-1'
		});
	});

	it.each<[string, Claims]>([
		['a wrong audience', { ...good, aud: 'other' }],
		['a wrong issuer', { ...good, iss: 'https://evil.cloudflareaccess.com' }],
		['an expired token', { ...good, exp: nowS() - 600 }],
		['no expiry', { iss: TEAM, aud: AUD, sub: 'user-1' }],
		['no subject', { iss: TEAM, aud: AUD, exp: nowS() + 600 }],
		['a subject that is not filename-safe', { ...good, sub: '../other-user' }]
	])('rejects %s', async (_name, claims) => {
		expect((await identify({ dev: false, env, token: await token(claims), keys })).ok).toBe(false);
	});

	it('rejects a token signed by another key', async () => {
		const forged = await token(good, otherKey);
		expect((await identify({ dev: false, env, token: forged, keys })).ok).toBe(false);
	});

	it('rejects a missing or garbled token', async () => {
		expect((await identify({ dev: false, env, token: null, keys })).ok).toBe(false);
		expect((await identify({ dev: false, env, token: 'a.b.c', keys })).ok).toBe(false);
	});

	it('fails closed without configuration, even with a valid token', async () => {
		const valid = await token(good);

		for (const partial of [{}, { ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: AUD }]) {
			expect((await identify({ dev: false, env: partial, token: valid, keys })).ok).toBe(false);
		}
	});

	it('ignores DEV_USER_ID outside dev', async () => {
		const result = await identify({ dev: false, env: { DEV_USER_ID: 'me' }, token: null, keys });
		expect(result.ok).toBe(false);
	});
});

describe('identify in dev', () => {
	it('uses DEV_USER_ID without a token', async () => {
		expect(await identify({ dev: true, env: { DEV_USER_ID: 'me' }, token: null, keys })).toEqual({
			ok: true,
			userId: 'me'
		});
	});

	it('still verifies tokens when DEV_USER_ID is unset', async () => {
		expect((await identify({ dev: true, env, token: null, keys })).ok).toBe(false);
		expect((await identify({ dev: true, env, token: await token(good), keys })).ok).toBe(true);
	});
});

describe('parsing', () => {
	it('requires an https team domain origin', () => {
		expect(parseAccessConfig({ teamDomain: `${TEAM}/`, audience: AUD })?.teamDomain).toBe(TEAM);
		expect(parseAccessConfig({ teamDomain: 'http://team.test', audience: AUD })).toBeNull();
		expect(parseAccessConfig({ teamDomain: `${TEAM}/path`, audience: AUD })).toBeNull();
		expect(parseAccessConfig({ teamDomain: TEAM, audience: '' })).toBeNull();
	});

	it('keeps user ids filename-safe', () => {
		expect(parseUserId('7335d417-61da-459d-899c-0a01c76a0da1')).not.toBeNull();

		for (const bad of ['', '..', 'a/b', 'a b', 'x'.repeat(129)])
			expect(parseUserId(bad)).toBeNull();
	});
});
