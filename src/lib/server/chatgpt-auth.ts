// Sign in with ChatGPT, the direct token-sharing flow as Pi implements it
// (badlogic/pi-mono packages/ai/src/auth/oauth/openai-chatgpt.ts @ 1b347794).
// The redirect goes to the user's own loopback address, which a hosted
// server cannot receive, so the user pastes the final URL back instead.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createKeyedMutex } from './keyed-mutex';

export const CHATGPT_AUTH_BASE_URL = 'https://auth.openai.com';
// Every login registers a new client under this id; the callback carries the issued one.
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME_HINT = 'data-dump';
const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Stored expiry is pulled in by this much, and a token is refreshed once it is
// within the validity window of that stored expiry. Both values are Pi's.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;
const MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

const isoDate = z.iso.datetime().transform((raw) => new Date(raw));

const credentialFile = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	expiresAt: isoDate,
	clientId: z.string().min(1),
	scopes: z.array(z.string()).refine((scopes) => scopes.includes(DIRECT_TOKEN_SCOPE))
});
export type Credential = z.output<typeof credentialFile>;

const pendingFile = z.object({
	verifier: z.string().min(1),
	state: z.string().min(1),
	nonce: z.string().min(1),
	redirectUri: z.url(),
	createdAt: isoDate
});
export type PendingLogin = z.output<typeof pendingFile>;

const deviceFile = z.object({ deviceId: z.uuid() });

const tokenResponse = z.object({
	access_token: z.string().trim().min(1),
	refresh_token: z.string().trim().min(1),
	expires_in: z.number().positive().finite(),
	scope: z.string().trim().min(1)
});
const exchangeResponse = tokenResponse.extend({ id_token: z.string().trim().min(1) });

export type ConnectionStatus = 'not-connected' | 'connected' | 'needs-reconnect';

// Rejects a split without marking the connection broken: the auth server was
// unreachable or failed, so a later retry may work.
export class TokenServerUnavailable extends Error {}
export class NotConnected extends Error {}

export type CallbackResult = { ok: true; code: string; clientId: string } | { ok: false; error: string };

export function parseCallbackUrl(input: string, pending: PendingLogin, now: Date): CallbackResult {
	if (now.getTime() - pending.createdAt.getTime() > PENDING_LOGIN_TTL_MS) {
		return { ok: false, error: 'This sign-in link has expired. Start again.' };
	}
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		return { ok: false, error: 'Paste the full address from the browser.' };
	}
	const expected = new URL(pending.redirectUri);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
		return { ok: false, error: `The address must start with ${pending.redirectUri}` };
	}
	const error = url.searchParams.get('error');
	if (error) return { ok: false, error: `ChatGPT sign-in failed: ${error}` };
	const code = url.searchParams.get('code');
	if (!code) return { ok: false, error: 'The address has no authorization code.' };
	if (url.searchParams.get('state') !== pending.state) {
		return { ok: false, error: 'The address belongs to a different sign-in. Start again.' };
	}
	const clientId = url.searchParams.get('client_id')?.trim();
	if (!clientId) return { ok: false, error: 'The address has no issued client id.' };
	return { ok: true, code, clientId };
}

const randomValue = () => randomBytes(32).toString('base64url');

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return Buffer.from(digest).toString('base64url');
}

export type ChatGPTAuth = ReturnType<typeof createChatGPTAuth>;

export function createChatGPTAuth({
	dir,
	fetch = globalThis.fetch,
	now = () => new Date(),
	authBaseUrl = CHATGPT_AUTH_BASE_URL
}: {
	dir: string;
	fetch?: typeof globalThis.fetch;
	now?: () => Date;
	authBaseUrl?: string;
}) {
	const withLock = createKeyedMutex();
	const credentialPath = join(dir, 'chatgpt.json');
	const pendingPath = join(dir, 'pending.json');
	const devicePath = join(dir, 'device.json');
	// Kept in memory: after a restart the next refresh attempt finds out again.
	let needsReconnect = false;

	async function writeSecret(path: string, value: unknown): Promise<void> {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const temp = `${path}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify(value, null, '\t'), { encoding: 'utf8', mode: 0o600 });
		await rename(temp, path);
	}

	async function readJson<T>(path: string, schema: z.ZodType<T, unknown>): Promise<T | null> {
		let text: string;
		try {
			text = await readFile(path, 'utf8');
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
			throw error;
		}
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			json = undefined;
		}
		const parsed = schema.safeParse(json);
		if (!parsed.success) console.warn(`chatgpt: ignoring malformed file ${path}`);
		return parsed.success ? parsed.data : null;
	}

	const readCredential = () => readJson(credentialPath, credentialFile);
	const writeCredential = (credential: Credential) =>
		writeSecret(credentialPath, { ...credential, expiresAt: credential.expiresAt.toISOString() });

	async function deviceId(): Promise<string> {
		const stored = await readJson(devicePath, deviceFile);
		if (stored) return stored.deviceId;
		const created = randomUUID();
		await writeSecret(devicePath, { deviceId: created });
		return created;
	}

	async function requestToken(
		fields: Record<string, string> & { client_id: string },
		schema: z.ZodType<z.output<typeof tokenResponse>>
	): Promise<Credential> {
		let response: Response;
		try {
			response = await fetch(`${authBaseUrl}/api/accounts/oauth/token`, {
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/x-www-form-urlencoded'
				},
				body: new URLSearchParams({ ...fields, resource: RESOURCE })
			});
		} catch (error) {
			throw new TokenServerUnavailable(`token request failed: ${String(error)}`);
		}
		if (response.status >= 500) {
			throw new TokenServerUnavailable(`token endpoint returned ${response.status}`);
		}
		if (!response.ok) {
			throw new Error(`token endpoint returned ${response.status}: ${await response.text()}`);
		}
		const token = schema.safeParse(await response.json().catch(() => null));
		if (!token.success) throw new Error('token response is missing required fields');
		const scopes = token.data.scope.split(/\s+/).filter(Boolean);
		if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
			throw new Error(`the grant did not include ${DIRECT_TOKEN_SCOPE}`);
		}
		return {
			accessToken: token.data.access_token,
			refreshToken: token.data.refresh_token,
			expiresAt: new Date(now().getTime() + token.data.expires_in * 1000 - EXPIRY_MARGIN_MS),
			clientId: fields.client_id,
			scopes
		};
	}

	// Caller holds the lock. The rotated refresh token is on disk before the
	// new access token is handed out.
	async function refresh(current: Credential): Promise<string> {
		let next: Credential;
		try {
			next = await requestToken(
				{
					grant_type: 'refresh_token',
					client_id: current.clientId,
					refresh_token: current.refreshToken
				},
				tokenResponse
			);
		} catch (error) {
			if (!(error instanceof TokenServerUnavailable)) needsReconnect = true;
			throw error;
		}
		await writeCredential(next);
		return next.accessToken;
	}

	const expiresSoon = (credential: Credential) =>
		now().getTime() + MINIMUM_VALIDITY_MS >= credential.expiresAt.getTime();

	// All token-file writes share one lock so concurrent splits refresh once.
	function withCredential<T>(work: (current: Credential) => Promise<T>): Promise<T> {
		return withLock('credential', async () => {
			if (needsReconnect) throw new Error('ChatGPT needs to be reconnected');
			const current = await readCredential();
			if (!current) throw new NotConnected('ChatGPT is not connected');
			return work(current);
		});
	}

	return {
		redirectUri: REDIRECT_URI,

		async status(): Promise<ConnectionStatus> {
			if (!(await readCredential())) return 'not-connected';
			return needsReconnect ? 'needs-reconnect' : 'connected';
		},

		isConnected: async (): Promise<boolean> => (await readCredential()) !== null,

		// Returns the address the user opens to sign in.
		async startLogin(): Promise<URL> {
			const verifier = randomValue();
			const pending: PendingLogin = {
				verifier,
				state: randomValue(),
				nonce: randomValue(),
				redirectUri: REDIRECT_URI,
				createdAt: now()
			};
			const url = new URL(`${authBaseUrl}/api/accounts/authorize`);
			url.search = new URLSearchParams({
				client_id: DYNAMIC_CLIENT_ID,
				agent_name_hint: AGENT_NAME_HINT,
				ext_agent_host_id: `urn:uuid:${(await deviceId()).toLowerCase()}`,
				response_type: 'code',
				redirect_uri: pending.redirectUri,
				resource: RESOURCE,
				scope: SCOPE,
				state: pending.state,
				code_challenge: await pkceChallenge(verifier),
				code_challenge_method: 'S256',
				nonce: pending.nonce
			}).toString();
			await writeSecret(pendingPath, { ...pending, createdAt: pending.createdAt.toISOString() });
			return url;
		},

		async completeLogin(pastedUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
			return withLock('credential', async () => {
				const pending = await readJson(pendingPath, pendingFile);
				if (!pending) return { ok: false, error: 'No sign-in is in progress. Start again.' };
				const callback = parseCallbackUrl(pastedUrl, pending, now());
				if (!callback.ok) return callback;
				let credential: Credential;
				try {
					credential = await requestToken(
						{
							grant_type: 'authorization_code',
							client_id: callback.clientId,
							code: callback.code,
							code_verifier: pending.verifier,
							redirect_uri: pending.redirectUri
						},
						exchangeResponse
					);
				} catch (error) {
					console.error('chatgpt: code exchange failed', error);
					return { ok: false, error: 'ChatGPT did not accept the sign-in. Start again.' };
				}
				await writeCredential(credential);
				await rm(pendingPath, { force: true });
				needsReconnect = false;
				return { ok: true };
			});
		},

		disconnect(): Promise<void> {
			return withLock('credential', async () => {
				await rm(credentialPath, { force: true });
				needsReconnect = false;
			});
		},

		// A token valid for at least the next few minutes, refreshed if needed.
		accessToken(): Promise<string> {
			return withCredential(async (current) =>
				expiresSoon(current) ? refresh(current) : current.accessToken
			);
		},

		// After a 401. If another caller already replaced the rejected token,
		// that newer token is used instead of refreshing again.
		accessTokenAfterRejection(rejected: string): Promise<string> {
			return withCredential(async (current) =>
				current.accessToken === rejected ? refresh(current) : current.accessToken
			);
		}
	};
}
