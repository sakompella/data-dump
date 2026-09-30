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

	it.each([
		['a raw 302', { ok: false, status: 302, headers: new Headers() }],
		['a 403', { ok: false, status: 403, headers: new Headers({ 'content-type': 'text/html' }) }]
	])('reports an expired session for %s', async (_name, overrides) => {
		const gate = askWith(answer(overrides));
		await expect(gate.call('/api/home')).rejects.toBeInstanceOf(SessionExpired);

		expect(gate.expired()).toBe(1);
	});

	it.each([
		['a 500 HTML page', 500, 'text/html'],
		['a 502 without a type', 502, ''],
		['a 503 HTML page', 503, 'text/html'],
		['a 404 HTML page', 404, 'text/html'],
		['a 204 without a body', 204, '']
	])('leaves %s to the caller as an ordinary reply', async (_name, status, type) => {
		const headers = type === '' ? new Headers() : new Headers({ 'content-type': type });
		const gate = askWith(answer({ ok: status < 300, status, headers }));

		expect((await gate.call('/api/home')).status).toBe(status);
		expect(gate.expired()).toBe(0);
	});

	it('reports an expired session for an HTML page where JSON was expected', async () => {
		const html = askWith(answer({ headers: new Headers({ 'content-type': 'text/html' }) }));
		await expect(html.call('/api/home')).rejects.toBeInstanceOf(SessionExpired);

		expect(html.expired()).toBe(1);
	});
});
