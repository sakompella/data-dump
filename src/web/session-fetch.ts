// Cloudflare Access answers an expired session with a redirect to its own
// login page, which a cross-origin fetch cannot follow. Treat that, and any
// success that is not JSON, as an expired session.
export class SessionExpired extends Error {
	constructor() {
		super('session expired');
	}
}

interface Reply {
	readonly type: string;
	readonly redirected: boolean;
	readonly ok: boolean;
	readonly status: number;
	readonly headers: { get(name: string): string | null };
}

// An Access login redirect (seen as an opaque redirect, or a 3xx), a refusal
// (401, 403), or a success that is not JSON (the login page). Other failures,
// such as a 5xx page, are ordinary errors: the caller keeps the text and says so.
function signedOut(answer: Reply): boolean {
	const isJson = answer.headers.get('content-type')?.includes('application/json') ?? false;

	if (answer.type === 'opaqueredirect' || answer.redirected) return true;

	if (answer.status >= 300 && answer.status < 400) return true;

	if (answer.status === 401 || answer.status === 403) return true;

	return answer.ok && !isJson;
}

export function sessionAwareFetch<Answer extends Reply>(
	fetchFn: (input: Request | string | URL, init?: RequestInit) => Promise<Answer>,
	onExpired: () => void
): (input: Request | string | URL, init?: RequestInit) => Promise<Answer> {
	return async (input, init) => {
		const answer = await fetchFn(input, { ...init, redirect: 'manual' });

		if (answer.status !== 204 && signedOut(answer)) {
			onExpired();
			throw new SessionExpired();
		}

		return answer;
	};
}
