import { describe, expect, it } from 'vitest';
import { SessionExpired, sessionAwareFetch } from './session-fetch';

interface Answer {
	type: string;
	ok: boolean;
	status: number;
	redirected: boolean;
	headers: Headers;
}

const JSON_HEADERS = new Headers({ 'content-type': 'application/json' });

const answer = (overrides: Partial<Answer>): Answer => ({
	type: 'basic',
	ok: true,
	status: 200,
	redirected: false,
	headers: JSON_HEADERS,
	...overrides
});

function askWith(reply: Answer) {
	let expired = 0;

	const call = sessionAwareFetch(
		async () => reply,
		() => (expired += 1)
	);

	return { call, expired: () => expired };
}

describe('sessionAwareFetch', () => {
	it('passes JSON replies through, including error statuses', async () => {
		const ok = askWith(answer({}));
		expect((await ok.call('/api/home')).status).toBe(200);

		const conflict = askWith(answer({ ok: false, status: 409 }));
		expect((await conflict.call('/api/home')).status).toBe(409);

		expect(ok.expired() + conflict.expired()).toBe(0);
	});

	it('reports an expired session for a login redirect', async () => {
		const redirected = askWith(answer({ type: 'opaqueredirect', ok: false, status: 0 }));
		await expect(redirected.call('/api/home')).rejects.toBeInstanceOf(SessionExpired);

		expect(redirected.expired()).toBe(1);
	});

	it('reports an expired session for a JSON 401', async () => {
		const unauthorized = askWith(answer({ ok: false, status: 401 }));
		await expect(unauthorized.call('/api/home')).rejects.toBeInstanceOf(SessionExpired);

		expect(unauthorized.expired()).toBe(1);
	});

	it('reports an expired session for a raw redirect or an HTML error that is not JSON', async () => {
		const raw = askWith(answer({ ok: false, status: 302, headers: new Headers() }));
		await expect(raw.call('/api/home')).rejects.toBeInstanceOf(SessionExpired);

		const login = askWith(
			answer({ ok: false, status: 403, headers: new Headers({ 'content-type': 'text/html' }) })
		);

		await expect(login.call('/api/home')).rejects.toBeInstanceOf(SessionExpired);
	});

	it('reports an expired session for an HTML page where JSON was expected', async () => {
		const html = askWith(answer({ headers: new Headers({ 'content-type': 'text/html' }) }));
		await expect(html.call('/api/home')).rejects.toBeInstanceOf(SessionExpired);

		expect(html.expired()).toBe(1);
	});
});
