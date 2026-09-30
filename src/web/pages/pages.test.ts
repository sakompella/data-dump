// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newRambleId, type RambleId, type ThoughtId } from '../../shared/ids';
import { createFakeLockManager, createServedApp, settle } from '../testing/browser';

// api.ts binds fetch when it loads, so a stand-in must be in place before
// any import; each test then points it at its own fake.
const network = vi.hoisted(() => {
	let current: typeof globalThis.fetch = () => Promise.reject(new Error('no fake fetch'));

	globalThis.fetch = (input, init) => current(input, init);

	return { use: (fake: typeof globalThis.fetch) => void (current = fake) };
});

let server: ReturnType<typeof createServedApp>;

beforeEach(() => {
	server = createServedApp();
	network.use(server.fetch);
	localStorage.clear();
});

let flushSync = () => {};

// The editors take a tab lock as soon as they load, so each page is loaded
// afresh after fake locks are in place, as on a new page load.
async function openPage(page: 'thought' | 'ramble', id: string) {
	vi.resetModules();
	Object.defineProperty(navigator, 'locks', { value: createFakeLockManager(), configurable: true });
	const svelte = await import('svelte');

	const component =
		page === 'thought'
			? (await import('./ThoughtPage.svelte')).default
			: (await import('./RamblePage.svelte')).default;

	svelte.mount(component, { target: document.body, props: { id } });
	flushSync = svelte.flushSync;
	await settle();
}

afterEach(() => {
	document.body.replaceChildren();
	server.close();
});

async function publishedThought(): Promise<{ rambleId: RambleId; thoughtId: ThoughtId }> {
	const rambleId = newRambleId();
	const data = server.data();
	await data.saveDraft({ id: rambleId, body: 'a ramble', base: null });
	const pending = await data.endRamble(rambleId);

	if (!pending) throw new Error('the ramble did not end');
	await data.finishSplit({ id: rambleId, revision: pending.revision, proposals: [] });
	const [thought] = (await data.home()).thoughts;

	if (!thought) throw new Error('the split published no thought');

	return { rambleId, thoughtId: thought.id };
}

async function saveText(text: string) {
	const box = document.querySelector('textarea');
	const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save');

	if (!box || !save) throw new Error('the page has no text box or Save button');
	box.value = text;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	save.click();
	await settle();
}

// Another tab writes right after this page's first save is answered, before
// the page can do anything else.
function writeElsewhereAfterFirstPut(write: () => Promise<void>) {
	let done = false;
	server.setAfterReply(async ({ method }) => {
		if (method !== 'PUT' || done) return;
		done = true;
		await write();
	});
}

describe('a write from elsewhere between two saves', () => {
	it('is not overwritten by the thought page', async () => {
		const { thoughtId } = await publishedThought();
		await openPage('thought', thoughtId);
		writeElsewhereAfterFirstPut(async () => {
			const current = await server.data().thought(thoughtId);

			if (current) {
				await server
					.data()
					.editThought({ id: thoughtId, base: current.revision, edit: { body: 'theirs' } });
			}
		});

		await saveText('mine, first');
		await saveText('mine, second');

		expect((await server.data().thought(thoughtId))?.body).toBe('theirs');
		expect(document.body.textContent).toMatch(/changed elsewhere/i);
	});

	it('is not overwritten by the ramble page', async () => {
		const { rambleId } = await publishedThought();
		await openPage('ramble', rambleId);
		writeElsewhereAfterFirstPut(async () => {
			const current = await server.data().ramble(rambleId);

			if (current) {
				await server
					.data()
					.editRamble({ id: rambleId, base: current.ramble.revision, body: 'theirs' });
			}
		});

		await saveText('mine, first');
		await saveText('mine, second');

		expect((await server.data().ramble(rambleId))?.ramble.body).toBe('theirs');
		expect(document.body.textContent).toMatch(/changed elsewhere/i);
	});
});
