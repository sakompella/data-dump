import { describe, expect, it } from 'vitest';
import { SessionExpired, sessionAwareFetch } from './session-fetch';

const ACCESS_LOGIN = 'https://team.cloudflareaccess.com/cdn-cgi/access/login';

const html = (status: number) =>
	new Response(status === 204 ? null : '<!doctype html><title>page</title>', {
		status,
		headers: { 'content-type': 'text/html' }
	});

function opaqueRedirect() {
	const response = new Response(null, { status: 500 });
	Object.defineProperties(response, { type: { value: 'opaqueredirect' }, status: { value: 0 } });

	return response;
}

// Runs one reply through the wrapper: did it report a signed-out session,
// and what did the caller get?
async function classify(reply: Response) {
	let expired = false;
	const fetchFn = async () => reply;

	const outcome = await sessionAwareFetch(
		fetchFn,
		() => (expired = true)
	)('/api/home').then(
		(answer) => ({ answer, error: null }),
		(error: Error) => ({ answer: null, error })
	);

	return { expired, ...outcome };
}

describe('classifying API replies', () => {
	it.each<[string, () => Response]>([
		['an opaque redirect', opaqueRedirect],
		[
			'a 302 to the login page',
			() => new Response(null, { status: 302, headers: { location: ACCESS_LOGIN } })
		],
		['a 303', () => new Response(null, { status: 303, headers: { location: ACCESS_LOGIN } })],
		['a JSON 401', () => Response.json({ error: 'unauthorized' }, { status: 401 })],
		['an HTML 403', () => html(403)],
		['a 200 login page', () => html(200)]
	])('treats %s as signed out', async (_name, reply) => {
		const { expired, error } = await classify(reply());
		expect(expired).toBe(true);
		expect(error).toBeInstanceOf(SessionExpired);
	});

	it.each<[string, () => Response]>([
		['an HTML 500', () => html(500)],
		['an HTML 502', () => html(502)],
		['an HTML 503', () => html(503)],
		[
			'a plain-text 504',
			() => new Response('timeout', { status: 504, headers: { 'content-type': 'text/plain' } })
		],
		['an HTML 404', () => html(404)],
		['a JSON 500', () => Response.json({ error: 'server error' }, { status: 500 })]
	])('treats %s as a server error, not as signed out', async (_name, reply) => {
		const { expired, error } = await classify(reply());
		expect(expired).toBe(false);
		expect(error).not.toBeInstanceOf(SessionExpired);
	});

	it('passes a 204 through as a success', async () => {
		const { expired, answer } = await classify(new Response(null, { status: 204 }));
		expect(expired).toBe(false);
		expect(answer?.status).toBe(204);
	});
});
