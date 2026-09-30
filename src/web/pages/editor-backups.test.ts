// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newRambleId, type RambleId, type ThoughtId } from '../../shared/ids';
import {
	createFakeLockManager,
	createFlakyStorage,
	createServedApp,
	settle
} from '../testing/browser';

// api.ts binds fetch when it loads, so a stand-in must be in place before
// any import; each test then points it at its own fake.
const network = vi.hoisted(() => {
	let current: typeof globalThis.fetch = () => Promise.reject(new Error('no fake fetch'));

	globalThis.fetch = (input, init) => current(input, init);

	return { use: (fake: typeof globalThis.fetch) => void (current = fake) };
});

let server: ReturnType<typeof createServedApp>;

let locks: ReturnType<typeof createFakeLockManager>;

// While set, every PUT fails as if the network were down.
let offline = false;

beforeEach(() => {
	server = createServedApp();
	offline = false;
	network.use((input, init) =>
		offline && init?.method === 'PUT'
			? Promise.reject(new TypeError('Failed to fetch'))
			: server.fetch(input, init)
	);
	// Each test is a fresh page load: module state, such as a tab's lock, starts over.
	vi.resetModules();
	locks = createFakeLockManager();
	Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
	localStorage.clear();
});

afterEach(() => {
	document.body.replaceChildren();
	server.close();
	vi.unstubAllGlobals();
});

type Editor = 'thought' | 'ramble';

async function publishedThought(
	body: string
): Promise<{ rambleId: RambleId; thoughtId: ThoughtId }> {
	const rambleId = newRambleId();
	const data = server.data();
	await data.saveDraft({ id: rambleId, body, base: null });
	const pending = await data.endRamble(rambleId);

	if (!pending) throw new Error('the ramble did not end');
	await data.finishSplit({ id: rambleId, revision: pending.revision, proposals: [] });
	const thought = (await data.home()).thoughts.find((t) => t.rambleId === rambleId);

	if (!thought) throw new Error('the split published no thought');

	return { rambleId, thoughtId: thought.id };
}

// How the editor is opened: in the same tab as before, in another tab (its
// own modules, same browser locks), or by reloading (fresh modules, and the
// old tab's locks are gone).
type Opening = 'same tab' | 'new tab' | 'reload';

// Opens the editor in its own container. With `holdRecovery`, checks for
// backups of other tabs wait until `finishRecovery` is called.
async function openEditor(
	editor: Editor,
	id: string,
	opening: Opening = 'same tab',
	{ holdRecovery = false } = {}
) {
	if (opening !== 'same tab') vi.resetModules();

	if (opening === 'reload') {
		locks = createFakeLockManager();
		Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
	}

	const finishRecovery = holdRecovery ? locks.pauseProbes() : () => {};

	const { mount, unmount, flushSync } = await import('svelte');

	const page =
		editor === 'thought'
			? (await import('./ThoughtPage.svelte')).default
			: (await import('./RamblePage.svelte')).default;

	const target = document.body.appendChild(document.createElement('div'));
	const component = mount(page, { target, props: { id } });
	await settle();

	const box = () => {
		const found = target.querySelector('textarea');

		if (!found) throw new Error('the editor has no text box');

		return found;
	};

	function type(text: string) {
		box().value = text;
		box().dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	}

	return {
		target,
		finishRecovery,
		box,
		type,
		async save(text: string) {
			const button = [...target.querySelectorAll('button')].find((b) => b.textContent === 'Save');

			if (!button) throw new Error('the editor has no Save button');
			type(text);
			button.click();
			await settle();
		},
		// Anything the user can read: text, and the values of fields.
		shown: () =>
			[
				target.textContent ?? '',
				...[...target.querySelectorAll('textarea, input')].map((field) =>
					field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement
						? field.value
						: ''
				)
			].join('\n'),
		async close() {
			await unmount(component);
			target.remove();
			await settle();
		}
	};
}

const storedValues = () =>
	Object.keys(localStorage)
		.map((key) => localStorage.getItem(key) ?? '')
		.join('\n');

async function serverBody(editor: Editor, ids: { rambleId: RambleId; thoughtId: ThoughtId }) {
	return editor === 'thought'
		? (await server.data().thought(ids.thoughtId))?.body
		: (await server.data().ramble(ids.rambleId))?.ramble.body;
}

async function writeElsewhere(
	editor: Editor,
	ids: { rambleId: RambleId; thoughtId: ThoughtId },
	body: string
) {
	const data = server.data();

	if (editor === 'thought') {
		const thought = await data.thought(ids.thoughtId);

		if (thought)
			await data.editThought({ id: ids.thoughtId, base: thought.revision, edit: { body } });
	} else {
		const ramble = await data.ramble(ids.rambleId);

		if (ramble) await data.editRamble({ id: ids.rambleId, base: ramble.ramble.revision, body });
	}
}

// Shows the server copy if the editor keeps it behind a toggle.
function revealServerCopy(target: HTMLElement) {
	for (const details of target.querySelectorAll('details')) details.open = true;

	for (const button of target.querySelectorAll('button')) {
		if (/server|latest|saved version|theirs|original/i.test(button.textContent ?? ''))
			button.click();
	}
}

const editors: Editor[] = ['thought', 'ramble'];

const failures = ['a conflict', 'a network failure'] as const;

describe.each(editors)('the %s editor', (editor) => {
	const idOf = (ids: { rambleId: RambleId; thoughtId: ThoughtId }) =>
		editor === 'thought' ? ids.thoughtId : ids.rambleId;

	it.each(failures)(
		'keeps text from a save refused by %s across leaving, coming back, and a reload, without overwriting the server copy',
		async (failure) => {
			const ids = await publishedThought('the server copy');
			const first = await openEditor(editor, idOf(ids));

			if (failure === 'a conflict') await writeElsewhere(editor, ids, 'written elsewhere');
			offline = failure === 'a network failure';
			await first.save('my unsaved words');
			offline = false;
			const onServer = await serverBody(editor, ids);
			expect(onServer).not.toBe('my unsaved words');
			await first.close();

			for (const reload of [false, true]) {
				const again = await openEditor(editor, idOf(ids), reload ? 'reload' : 'same tab');
				const context = reload ? 'after a reload' : 'after coming back';
				expect(again.shown(), context).toContain('my unsaved words');
				expect(again.target.textContent, context).toMatch(/restored/i);
				expect(await serverBody(editor, ids), context).toBe(onServer);
				revealServerCopy(again.target);
				await settle();
				expect(again.shown(), context).toContain(onServer ?? '');
				await again.close();
			}
		}
	);

	it('saves restored stale text on the latest version once the user keeps it and saves', async () => {
		const ids = await publishedThought('the server copy');
		const first = await openEditor(editor, idOf(ids));
		await writeElsewhere(editor, ids, 'written elsewhere');
		await first.save('my unsaved words');
		await first.close();

		const again = await openEditor(editor, idOf(ids), 'reload');
		// The restored edits are stale, so saving them is refused first.
		await again.save('my unsaved words');
		expect(await serverBody(editor, ids)).toBe('written elsewhere');

		const keep = [...again.target.querySelectorAll('button')].find((button) =>
			/keep my text on the latest/i.test(button.textContent ?? '')
		);

		if (!keep) throw new Error('no "Keep my text on the latest version" button');
		keep.click();
		await settle();
		// Choosing to keep the text moves its base; the save is still the user's own click.
		expect(await serverBody(editor, ids)).toBe('written elsewhere');
		await again.save('my unsaved words');

		expect(await serverBody(editor, ids)).toBe('my unsaved words');
		expect(again.shown()).toContain('my unsaved words');
		expect(storedValues()).not.toContain('my unsaved words');

		await again.save('my unsaved words, then more');
		expect(await serverBody(editor, ids)).toBe('my unsaved words, then more');
		expect(again.target.textContent).not.toMatch(/changed elsewhere/i);
	});

	it('leaves no backup once a save is acknowledged', async () => {
		const ids = await publishedThought('the server copy');
		const page = await openEditor(editor, idOf(ids));
		offline = true;
		await page.save('first try');
		offline = false;
		await page.save('saved words');

		expect(await serverBody(editor, ids)).toBe('saved words');
		expect(storedValues()).not.toContain('first try');
		expect(storedValues()).not.toContain('saved words');
	});

	it('leaves the backups of other documents, other tabs, and the capture box as they are', async () => {
		const mine = await publishedThought('mine on the server');
		const other = await publishedThought('other on the server');
		localStorage.setItem(
			'data-dump:draft:some-tab',
			JSON.stringify({ id: newRambleId(), body: 'capture text', revision: null })
		);

		const otherPage = await openEditor(editor, idOf(other));
		offline = true;
		await otherPage.save('other unsaved');
		offline = false;
		await otherPage.close();

		const otherTab = await openEditor(editor, idOf(mine));
		offline = true;
		await otherTab.save('other tab unsaved');
		offline = false;
		const before = { ...localStorage };

		const page = await openEditor(editor, idOf(mine), 'new tab');
		await page.save('saved here');
		offline = true;
		await page.save('then not saved');
		offline = false;
		await page.close();

		for (const [key, value] of Object.entries(before)) {
			if (
				value.includes('other unsaved') ||
				value.includes('other tab unsaved') ||
				value.includes('capture text')
			) {
				expect(localStorage.getItem(key), key).toBe(value);
			}
		}

		expect(storedValues()).toContain('other unsaved');
		expect(storedValues()).toContain('other tab unsaved');
		expect(storedValues()).toContain('capture text');
	});
});

// A tab that tried to save `text`, failed because the network was down, and
// is still open. After a reload, its backup belongs to a tab that is gone.
async function leaveBackup(editor: Editor, id: string, text: string) {
	const tab = await openEditor(editor, id, 'new tab');
	offline = true;
	await tab.save(text);
	offline = false;
}

const discardButton = (target: HTMLElement) =>
	[...target.querySelectorAll('button')].find((b) => /discard/i.test(b.textContent ?? ''));

describe.each(editors)('recovery in the %s editor', (editor) => {
	const idOf = (ids: { rambleId: RambleId; thoughtId: ThoughtId }) =>
		editor === 'thought' ? ids.thoughtId : ids.rambleId;

	it('keeps every other backup of the document until it is saved or discarded', async () => {
		const ids = await publishedThought('the server copy');
		await leaveBackup(editor, idOf(ids), 'from tab A');
		await leaveBackup(editor, idOf(ids), 'from tab B');

		const page = await openEditor(editor, idOf(ids), 'reload');
		const restored = page.box().value;
		const other = restored === 'from tab A' ? 'from tab B' : 'from tab A';
		expect(['from tab A', 'from tab B']).toContain(restored);
		expect(storedValues()).toContain(other);

		await page.save(restored);
		expect(await serverBody(editor, ids)).toBe(restored);
		expect(storedValues()).toContain(other);
		await page.close();

		const next = await openEditor(editor, idOf(ids), 'reload');
		expect(next.shown()).toContain(other);
		discardButton(next.target)?.click();
		await settle();
		expect(storedValues()).not.toContain(other);
	});

	it('keeps a backup it cannot copy into this tab, and says the backup failed', async () => {
		const flaky = createFlakyStorage();
		vi.stubGlobal('localStorage', flaky.storage);
		const ids = await publishedThought('the server copy');
		await leaveBackup(editor, idOf(ids), 'left behind');

		flaky.failWrites(() => true);
		const page = await openEditor(editor, idOf(ids), 'reload');

		expect([...flaky.items.values()].join('\n')).toContain('left behind');
		expect(page.target.textContent).toMatch(/backup unavailable/i);
	});

	it('treats a backup it cannot read as still there, not as missing', async () => {
		const flaky = createFlakyStorage();
		vi.stubGlobal('localStorage', flaky.storage);
		const ids = await publishedThought('the server copy');
		await leaveBackup(editor, idOf(ids), 'left behind');

		flaky.failReads((key) => key.startsWith('data-dump:edit:'));
		const blocked = await openEditor(editor, idOf(ids), 'reload');
		expect(blocked.target.textContent).toMatch(/backup unavailable/i);
		await blocked.close();
		expect([...flaky.items.values()].join('\n')).toContain('left behind');

		flaky.failReads(() => false);
		const later = await openEditor(editor, idOf(ids), 'reload');
		expect(later.shown()).toContain('left behind');
	});

	it('never overwrites text typed while recovery is still checking backups', async () => {
		const ids = await publishedThought('the server copy');
		await leaveBackup(editor, idOf(ids), 'left behind');

		const page = await openEditor(editor, idOf(ids), 'reload', { holdRecovery: true });
		const box = page.target.querySelector('textarea');
		const writable = box !== null && !box.readOnly && !box.disabled;

		if (writable) page.type('typed early');
		page.finishRecovery();
		await settle();

		if (writable) {
			expect(page.box().value).toBe('typed early');
			expect(storedValues()).toContain('typed early');
		} else {
			expect(page.box().readOnly || page.box().disabled, 'writable once recovery is done').toBe(
				false
			);
		}

		expect(storedValues()).toContain('left behind');
	});
});
