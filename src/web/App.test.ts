// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLockManager, createServedApp, settle } from './testing/browser';

// api.ts binds fetch when it loads, so a stand-in must be in place before
// any import; each test then points it at its own fake.
const network = vi.hoisted(() => {
	let current: typeof globalThis.fetch = () => Promise.reject(new Error('no fake fetch'));

	globalThis.fetch = (input, init) => current(input, init);

	return { use: (fake: typeof globalThis.fetch) => void (current = fake) };
});

const SAVE_DELAY_MS = 800;

const BACKUP_PREFIX = 'data-dump:draft:';

const ACCESS_LOGIN = 'https://team.cloudflareaccess.com/cdn-cgi/access/login';

// What a browser sees once the Access cookie has expired and Access answers
// an API call with a redirect to its login page.
type ExpiredReply = 'opaque redirect' | 'login page' | 'raw redirect' | 'JSON 401';

function expiredReply(kind: ExpiredReply, init: RequestInit | undefined): Response {
	switch (kind) {
		case 'opaque redirect': {
			// Following the redirect fails on CORS; only `redirect: 'manual'` sees it.
			if (init?.redirect !== 'manual') throw new TypeError('Failed to fetch');
			const response = new Response(null, { status: 500 });
			Object.defineProperties(response, {
				type: { value: 'opaqueredirect' },
				status: { value: 0 }
			});

			return response;
		}

		case 'login page':
			return new Response('<!doctype html><title>Cloudflare Access</title>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			});
		case 'raw redirect':
			return new Response(null, { status: 302, headers: { location: ACCESS_LOGIN } });
		// What the Worker itself answers when the Access token is missing or expired.
		case 'JSON 401':
			return Response.json({ error: 'unauthorized' }, { status: 401 });
	}
}

let server: ReturnType<typeof createServedApp>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	server = createServedApp();
	Object.defineProperty(navigator, 'locks', {
		value: createFakeLockManager(),
		configurable: true
	});
	localStorage.clear();
});

afterEach(() => {
	document.body.replaceChildren();
	server.close();
	vi.useRealTimers();
});

describe('an expired Access session', () => {
	it.each<ExpiredReply>(['opaque redirect', 'login page', 'raw redirect', 'JSON 401'])(
		'is shown as signed out, and the text stays in the box and the backup (%s)',
		async (kind) => {
			let expired = false;
			network.use((input, init) =>
				expired ? Promise.resolve(expiredReply(kind, init)) : server.fetch(input, init)
			);
			// A fresh page load: module state such as the session flag starts over.
			vi.resetModules();
			const { flushSync, mount } = await import('svelte');
			const { default: App } = await import('./App.svelte');
			mount(App, { target: document.body });
			await settle();
			expect(document.body.textContent).not.toMatch(/signed out/i);
			const box = document.querySelector('textarea');

			if (!box) throw new Error('the home page shows no capture box');

			expired = true;
			box.value = 'typed after the session ended';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
			await settle();

			expect(document.body.textContent).toMatch(/signed out|sign in/i);
			expect(box.value).toBe('typed after the session ended');
			const backups = Object.keys(localStorage).filter((key) => key.startsWith(BACKUP_PREFIX));
			expect(backups.map((key) => localStorage.getItem(key))).toEqual([
				expect.stringContaining('typed after the session ended')
			]);
		}
	);
});
