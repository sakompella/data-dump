// Cloudflare Access answers an expired session with a redirect to its own
// login page, which a cross-origin fetch cannot follow. Treat that, and any
// reply that is not JSON where JSON is expected, as an expired session.
export class SessionExpired extends Error {
	constructor() {
		super('session expired');
	}
}

interface Reply {
	readonly type: string;
	readonly redirected: boolean;
	readonly ok: boolean;
	readonly headers: { get(name: string): string | null };
}

export function sessionAwareFetch<Answer extends Reply>(
	fetchFn: (input: Request | string | URL, init?: RequestInit) => Promise<Answer>,
	onExpired: () => void
): (input: Request | string | URL, init?: RequestInit) => Promise<Answer> {
	return async (input, init) => {
		const answer = await fetchFn(input, { ...init, redirect: 'manual' });
		const isJson = answer.headers.get('content-type')?.includes('application/json') ?? false;

		if (answer.type === 'opaqueredirect' || answer.redirected || (answer.ok && !isJson)) {
			onExpired();
			throw new SessionExpired();
		}

		return answer;
	};
}
