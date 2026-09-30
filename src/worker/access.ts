// Cloudflare Access puts a signed JWT on every request it lets through. The
// Worker verifies it itself so a request that bypasses Access gets nothing.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

declare const brand: unique symbol;

// Filename-safe: it becomes part of every storage key.
export type UserId = string & { readonly [brand]: 'UserId' };

const USER_ID_PATTERN = /^[0-9A-Za-z_-]{1,128}$/;

export const parseUserId = (raw: string): UserId | null =>
	// SAFETY: the brand is applied only after raw matches USER_ID_PATTERN.
	USER_ID_PATTERN.test(raw) ? (raw as UserId) : null;

export interface AccessConfig {
	readonly teamDomain: string;
	readonly audience: string;
}

// Returns null unless both values are set and the team domain is an https origin.
export function parseAccessConfig({
	teamDomain,
	audience
}: {
	teamDomain: string | undefined;
	audience: string | undefined;
}): AccessConfig | null {
	if (!teamDomain || !audience) return null;
	let url: URL;

	try {
		url = new URL(teamDomain);
	} catch {
		return null;
	}

	if (url.protocol !== 'https:' || url.origin !== teamDomain.replace(/\/+$/, '')) return null;

	return { teamDomain: url.origin, audience };
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

// jose caches fetched keys inside each key set, so one set per team domain is kept.
export function accessKeys(config: AccessConfig): JWTVerifyGetKey {
	const url = `${config.teamDomain}/cdn-cgi/access/certs`;
	const existing = remoteKeySets.get(url);

	if (existing) return existing;
	const created = createRemoteJWKSet(new URL(url));
	remoteKeySets.set(url, created);

	return created;
}

// Null for a missing, unsigned, expired, or foreign token, or one without a usable subject.
export async function verifyAccessToken({
	token,
	config,
	keys
}: {
	token: string | null;
	config: AccessConfig;
	keys: JWTVerifyGetKey;
}): Promise<UserId | null> {
	if (!token) return null;

	try {
		const { payload } = await jwtVerify(token, keys, {
			issuer: config.teamDomain,
			audience: config.audience,
			requiredClaims: ['exp', 'sub']
		});

		return payload.sub ? parseUserId(payload.sub) : null;
	} catch {
		return null;
	}
}

export type Identity = { ok: true; userId: UserId } | { ok: false; reason: string };

// In dev a DEV_USER_ID stands in for Access. Anywhere else a verified token is
// the only way in; missing configuration shuts the site rather than opening it.
export async function identify({
	dev,
	env,
	token,
	keys = accessKeys
}: {
	dev: boolean;
	env: {
		ACCESS_TEAM_DOMAIN?: string;
		ACCESS_AUD?: string;
		DEV_USER_ID?: string;
	};
	token: string | null;
	keys?: (config: AccessConfig) => JWTVerifyGetKey;
}): Promise<Identity> {
	if (dev && env.DEV_USER_ID) {
		const userId = parseUserId(env.DEV_USER_ID);

		return userId
			? { ok: true, userId }
			: { ok: false, reason: 'DEV_USER_ID is not filename-safe' };
	}

	const config = parseAccessConfig({
		teamDomain: env.ACCESS_TEAM_DOMAIN,
		audience: env.ACCESS_AUD
	});

	if (!config)
		return { ok: false, reason: 'ACCESS_TEAM_DOMAIN or ACCESS_AUD is missing or invalid' };
	const userId = await verifyAccessToken({ token, config, keys: keys(config) });

	return userId ? { ok: true, userId } : { ok: false, reason: 'no valid Access token' };
}
