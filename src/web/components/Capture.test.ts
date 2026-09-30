// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import { newRambleId, parseRambleId } from '../../shared/ids';
import {
	createFakeLockManager,
	createFlakyStorage,
	createServedApp,
	settle
} from '../testing/browser';
import Capture from './Capture.svelte';

// api.ts binds fetch when it loads, so a stand-in must be in place before
// any import; each test then points it at its own fake.
const network = vi.hoisted(() => {
	let current: typeof globalThis.fetch = () => Promise.reject(new Error('no fake fetch'));

	globalThis.fetch = (input, init) => current(input, init);

	return { use: (fake: typeof globalThis.fetch) => void (current = fake) };
});

// Capture waits this long after the last keystroke before saving.
const SAVE_DELAY_MS = 800;

const BACKUP_PREFIX = 'data-dump:draft:';

let server: ReturnType<typeof createServedApp>;

let locks: ReturnType<typeof createFakeLockManager>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	server = createServedApp();
	locks = createFakeLockManager();
	network.use(server.fetch);
	Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
	localStorage.clear();
});

afterEach(() => {
	document.body.replaceChildren();
	server.close();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function mountCapture() {
	const component = mount(Capture, {
		target: document.body,
		props: { draft: null, model: null, onchange: () => {} }
	});

	const box = document.querySelector('textarea');

	if (!box) throw new Error('Capture rendered no textarea');

	return { component, box };
}

function type(box: HTMLTextAreaElement, value: string) {
	box.value = value;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

const backupBodies = () =>
	Object.keys(localStorage)
		.filter((key) => key.startsWith(BACKUP_PREFIX))
		.map((key) => localStorage.getItem(key));

describe('leaving the page', () => {
	it('saves text typed within the save delay and leaves no backup or lock behind', async () => {
		const { component, box } = mountCapture();
		await settle();
		type(box, 'one');
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		await settle();
		type(box, 'one two');

		await unmount(component);
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		await settle();

		expect((await server.data().home()).draft?.body).toBe('one two');
		expect(backupBodies()).toEqual([]);
		expect(locks.held()).toEqual([]);
	});
});

describe('saving', () => {
	it('sends text typed during a slow save in the next save to the same ramble', async () => {
		let answer = () => {};

		const held = new Promise<void>((resolve) => (answer = resolve));
		server.setAfterReply(({ method }) => (method === 'PUT' ? held : Promise.resolve()));
		const { box } = mountCapture();
		await settle();
		type(box, 'one');
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		type(box, 'one two');
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);

		answer();
		await settle();

		const { draft } = await server.data().home();
		expect(draft).toMatchObject({ body: 'one two', revision: 2 });
		expect(document.body.textContent).toContain('saved');
	});

	it('ends the ramble on New ramble and, without ChatGPT, keeps it whole as one thought', async () => {
		const { box } = mountCapture();
		await settle();
		type(box, 'a whole thought');

		const newRamble = [...document.querySelectorAll('button')].find(
			(button) => button.textContent === 'New ramble'
		);

		newRamble?.click();
		await settle();

		expect(box.value).toBe('');
		const { thoughts, draft, pending } = await server.data().home();
		expect(thoughts.map((thought) => thought.body)).toEqual(['a whole thought']);
		expect({ draft, pending }).toEqual({ draft: null, pending: [] });
		expect(backupBodies()).toEqual([]);
	});
});

describe('restoring a backup', () => {
	it('keeps text typed while the restore is still checking backups', async () => {
		const backupId = newRambleId();
		localStorage.setItem(
			`${BACKUP_PREFIX}closed-tab`,
			JSON.stringify({ id: backupId, body: 'from backup', revision: null })
		);
		const releaseProbes = locks.pauseProbes();
		const { box } = mountCapture();
		await settle();

		type(box, 'typed now');
		releaseProbes();
		await settle();
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		await settle();

		expect(box.value).toBe('typed now');
		const backupOnServer = (await server.data().ramble(backupId))?.ramble.body;

		const backupKept =
			backupOnServer === 'from backup' ||
			backupBodies().some((raw) => raw?.includes('from backup'));

		expect(backupKept, 'the backup text is on the server or still backed up').toBe(true);
	});

	it('restores a backup with a numeric revision into the same ramble', async () => {
		const id = newRambleId();
		await server.data().saveDraft({ id, body: 'from', base: null });
		localStorage.setItem(
			`${BACKUP_PREFIX}closed-tab`,
			JSON.stringify({ id, body: 'from backup', revision: 1 })
		);
		const { box } = mountCapture();
		await settle();

		expect(box.value).toBe('from backup');
		expect((await server.data().ramble(id))?.ramble.body).toBe('from backup');
	});

	it('ignores malformed backups and still restores a good one', async () => {
		const id = newRambleId();

		const malformed = [
			'not json',
			'null',
			JSON.stringify({ id: 'not-an-id', body: 'bad id', revision: null }),
			JSON.stringify({ id: newRambleId(), body: 5, revision: null }),
			JSON.stringify({ id: newRambleId(), body: 'text revision', revision: '1' })
		];

		malformed.forEach((raw, index) => localStorage.setItem(`${BACKUP_PREFIX}bad-${index}`, raw));
		localStorage.setItem(
			`${BACKUP_PREFIX}good`,
			JSON.stringify({ id, body: 'the good one', revision: null })
		);
		const { box } = mountCapture();
		await settle();

		expect(box.value).toBe('the good one');
		expect((await server.data().ramble(id))?.ramble.body).toBe('the good one');
		expect((await server.data().home()).draft?.id).toBe(id);
	});
});

describe('when local storage fails', () => {
	it('still saves typed text to the server and says the backup is not working', async () => {
		const fail = () => {
			throw new DOMException('quota exceeded', 'QuotaExceededError');
		};

		const broken = {
			getItem: fail,
			setItem: fail,
			removeItem: fail,
			key: fail,
			clear: fail,
			length: 0
		};

		const working = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', { value: broken, configurable: true });

		try {
			const { box } = mountCapture();
			await settle();
			type(box, 'kept on the server');
			await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
			await settle();

			expect((await server.data().home()).draft?.body).toBe('kept on the server');
			expect(document.body.textContent).toMatch(/backup|local cop|storage/i);
		} finally {
			if (working) Object.defineProperty(window, 'localStorage', working);
		}
	});
});

// Two New ramble clicks with typing in between, while the server answers
// late and in order. Each word is typed once and is unique.
type EndOp = { kind: 'type' } | { kind: 'end' } | { kind: 'answer' } | { kind: 'wait' };

const endOp: fc.Arbitrary<EndOp> = fc.constantFrom<EndOp>(
	{ kind: 'type' },
	{ kind: 'end' },
	{ kind: 'answer' },
	{ kind: 'wait' }
);

const sentId = z.object({ id: z.string() });

describe('ending rambles while replies are late', () => {
	it('ends only rambles saved from an ended snapshot, and keeps each typed word exactly once', async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(endOp, { minLength: 1, maxLength: 14 }), async (ops) => {
				server.close();
				server = createServedApp();
				network.use(server.fetch);
				localStorage.clear();
				document.body.replaceChildren();

				const late: (() => void)[] = [];
				const ids = new Set<string>();
				// Each end request, with the body it ended and the clicks made so far.
				const ends: { body: string | undefined; clicks: number }[] = [];

				server.setAfterReply(async ({ method, path, sent, answered }) => {
					for (const raw of [sent, answered]) {
						const parsed = sentId.safeParse(raw === '' ? null : JSON.parse(raw));

						if (parsed.success) ids.add(parsed.data.id);
					}

					if (method === 'POST' && path === '/api/ramble/end') {
						const id = sentId.parse(JSON.parse(sent)).id;
						const rambleId = parseRambleId(id);
						const body = rambleId ? (await server.data().ramble(rambleId))?.ramble.body : undefined;
						ends.push({ body, clicks: snapshots.length });
					}

					await new Promise<void>((resolve) => late.push(resolve));
				});

				const { component, box } = mountCapture();

				const newRamble = [...document.querySelectorAll('button')].find(
					(button) => button.textContent === 'New ramble'
				);

				const snapshots: string[] = [];
				const words: string[] = [];
				await settle();

				for (const op of ops) {
					if (op.kind === 'type') {
						const word = `w${words.length}x`;
						words.push(word);
						type(box, `${box.value} ${word}`);
					}

					if (op.kind === 'end') {
						snapshots.push(box.value);
						newRamble?.click();
					}

					if (op.kind === 'answer') late.shift()?.();

					if (op.kind === 'wait') await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
					await settle(3);
				}

				for (let round = 0; round < 20; round += 1) {
					while (late.length > 0) late.shift()?.();
					await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
					await settle();
				}

				await unmount(component);
				await settle();

				// An ended ramble holds only text that was in the box at a click before its end.
				for (const { body, clicks } of ends) {
					expect(body?.trim(), 'an ended ramble exists and has text').toBeTruthy();
					expect(
						snapshots.slice(0, clicks).some((snapshot) => snapshot.includes(body ?? '')),
						`ended "${body}"`
					).toBe(true);
				}

				const stored = await Promise.all(
					[...ids].map(async (raw) => {
						const id = parseRambleId(raw);

						return id ? ((await server.data().ramble(id))?.ramble.body ?? '') : '';
					})
				);

				const counts = stored
					.join(' ')
					.split(/\s+/)
					.filter((token) => token !== '');

				for (const word of words) {
					expect(
						counts.filter((token) => token === word),
						word
					).toHaveLength(1);
				}
			}),
			{
				numRuns: 100,
				// Found by this property: a click, then typing that the debounced save picks up.
				examples: [[[{ kind: 'type' }, { kind: 'end' }, { kind: 'type' }, { kind: 'wait' }]]]
			}
		);
	});
});

describe('recovering capture backups', () => {
	const PUT_FAILS: typeof globalThis.fetch = (input, init) =>
		init?.method === 'PUT'
			? Promise.reject(new TypeError('Failed to fetch'))
			: server.fetch(input, init);

	const backupOf = (id: string, body: string) => JSON.stringify({ id, body, revision: null });

	it('keeps every distinct backup of one ramble until the server has it', async () => {
		network.use(PUT_FAILS);
		const id = newRambleId();
		localStorage.setItem(`${BACKUP_PREFIX}gone-a`, backupOf(id, 'one'));
		localStorage.setItem(`${BACKUP_PREFIX}gone-b`, backupOf(id, 'one two'));
		mountCapture();
		await settle();
		await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
		await settle();

		const kept = backupBodies().join('\n');
		expect(kept).toContain('"one"');
		expect(kept).toContain('"one two"');
	});

	it('keeps a backup it cannot copy into this tab, and says the backup failed', async () => {
		network.use(PUT_FAILS);
		const flaky = createFlakyStorage();
		vi.stubGlobal('localStorage', flaky.storage);
		flaky.items.set(`${BACKUP_PREFIX}gone`, backupOf(newRambleId(), 'left behind'));
		flaky.failWrites(() => true);
		mountCapture();
		await settle();

		expect([...flaky.items.values()].join('\n')).toContain('left behind');
		expect(document.body.textContent).toMatch(/backup unavailable/i);
	});

	it('keeps a backup it cannot read, and says the backup failed', async () => {
		const flaky = createFlakyStorage();
		vi.stubGlobal('localStorage', flaky.storage);
		flaky.items.set(`${BACKUP_PREFIX}gone`, backupOf(newRambleId(), 'left behind'));
		flaky.failReads((key) => key.startsWith(BACKUP_PREFIX));
		mountCapture();
		await settle();

		expect([...flaky.items.values()].join('\n')).toContain('left behind');
		expect(document.body.textContent).toMatch(/backup unavailable/i);
	});
});
