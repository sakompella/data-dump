import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEditorBackups } from './editor-backup';
import { guardStore, type KeyedStorage } from './safe-storage';
import { createFakeStorage } from './testing/fakes';

const draftSchema = z.object({ label: z.string(), body: z.string() });

const SERVER = { label: 'l', body: 'server text' };

const MINE = { label: 'l', body: 'my unsaved text' };

const refuse = () => {
	throw new Error('blocked');
};

// Tabs of one browser share storage; `gone` lists the tabs whose lock is free.
function browser() {
	const storage = createFakeStorage();
	const gone = new Set<string>();

	const tab = (tabId: string, shared: KeyedStorage = storage) =>
		createEditorBackups({
			store: guardStore(shared, () => {}),
			tabId,
			isTabGone: async (other) => gone.has(other),
			draftSchema
		});

	const texts = () =>
		[...storage.items.values()].map(
			(raw) => z.object({ draft: draftSchema }).parse(JSON.parse(raw)).draft.body
		);

	return { storage, gone, tab, texts };
}

describe('restoring', () => {
	it('restores after navigating away and coming back in the same tab', async () => {
		const { tab } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);

		// The page is left and mounted again: a new backups object, the same tab.
		expect(await tab('A').restore('thought:1', SERVER)).toMatchObject({ draft: MINE, revision: 3 });
	});

	it('restores after a reload, when the old tab is gone, and keeps the base revision', async () => {
		const { tab, gone } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		gone.add('A');

		expect(await tab('B').restore('thought:1', SERVER)).toMatchObject({ draft: MINE, revision: 3 });
		// It now belongs to the new tab, so it survives another reload.
		gone.add('B');
		expect(await tab('C').restore('thought:1', SERVER)).toMatchObject({ draft: MINE, revision: 3 });
	});

	it('leaves another live tab and another document alone', async () => {
		const { tab, storage } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		tab('A').sync('thought:2', { label: 'x', body: 'other' }, SERVER, 1);

		expect(await tab('B').restore('thought:1', SERVER)).toBeNull();
		expect(storage.items.size).toBe(2);

		tab('B').remove('thought:1');
		expect(storage.items.size).toBe(2);
	});

	it('removes a backup equal to the server copy, and keeps one it cannot parse', async () => {
		const { tab, storage, gone } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		storage.setItem('data-dump:edit:thought:1:Z', '{not json');
		gone.add('A');
		gone.add('Z');

		expect(await tab('B').restore('thought:1', MINE)).toBeNull();
		expect([...storage.items.keys()]).toEqual(['data-dump:edit:thought:1:Z']);
	});
});

describe('backups that are not restored', () => {
	const A = { label: 'l', body: 'unique A' };

	const B = { label: 'l', body: 'unique B' };

	it('keeps every distinct draft of gone tabs; the one restored is copied, not the rest removed', async () => {
		const { tab, gone, texts } = browser();
		tab('A').sync('thought:1', A, SERVER, 1);
		tab('B').sync('thought:1', B, SERVER, 1);
		gone.add('A');
		gone.add('B');

		const c = tab('C');
		const chosen = await c.restore('thought:1', SERVER);
		const others = await c.others('thought:1', SERVER, chosen?.draft ?? SERVER);

		expect(others).toHaveLength(1);
		expect([chosen?.draft.body, others[0]?.draft.body].sort()).toEqual(['unique A', 'unique B']);
		expect(texts().sort()).toEqual(['unique A', 'unique B']);
	});

	it('swaps another draft in without losing what was in the editor, and removes only the swapped one', async () => {
		const { tab, gone, texts } = browser();
		tab('A').sync('thought:1', A, SERVER, 1);
		gone.add('A');

		const c = tab('C');
		expect(await c.restore('thought:1', SERVER)).toMatchObject({ draft: A });

		gone.add('B');
		tab('B').sync('thought:1', B, SERVER, 1);
		const [other] = await c.others('thought:1', SERVER, A);

		expect(other?.draft).toEqual(B);
		expect(other && c.swapIn('thought:1', other, { draft: A, revision: 1 }, SERVER)).toBe(true);
		expect(texts().sort()).toEqual(['unique A', 'unique B']);
		expect((await c.others('thought:1', SERVER, B)).map((o) => o.draft.body)).toEqual(['unique A']);
	});

	it('removes a draft only when the user discards it', async () => {
		const { tab, gone, texts } = browser();
		tab('A').sync('thought:1', A, SERVER, 1);
		gone.add('A');

		const c = tab('C');
		const [other] = await c.others('thought:1', SERVER, SERVER);
		expect(texts()).toEqual(['unique A']);

		if (other) c.discard(other);
		expect(texts()).toEqual([]);
	});
});

describe('when storage fails', () => {
	it('keeps the source when the copy cannot be written', async () => {
		const { storage, gone, tab } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		gone.add('A');

		const noWrites: KeyedStorage = { ...storage, setItem: refuse };
		const restored = await tab('B', noWrites).restore('thought:1', SERVER);

		expect(restored?.draft).toEqual(MINE);
		expect(storage.items.size).toBe(1);
	});

	it('keeps the source when the copy is written but cannot be read back', async () => {
		const { storage, gone, tab } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		gone.add('A');

		// Reads fail only for the new tab's key.
		const blind: KeyedStorage = {
			...storage,
			getItem: (key) => (key.endsWith(':B') ? refuse() : storage.getItem(key))
		};

		await tab('B', blind).restore('thought:1', SERVER);
		expect([...storage.items.keys()].some((key) => key.endsWith(':A'))).toBe(true);
	});

	it('does not treat a failed read as empty or as corrupt, and does not remove on a later match', async () => {
		const { storage, gone, tab } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		gone.add('A');

		const noReads: KeyedStorage = { ...storage, getItem: refuse };
		const b = tab('B', noReads);

		expect(await b.restore('thought:1', SERVER)).toBeNull();
		expect(storage.items.size).toBe(1);

		// The form now equals the server copy, but the stored record was never read.
		b.sync('thought:1', SERVER, SERVER, 3);
		expect(storage.items.size).toBe(1);
	});

	it("keeps this tab's own record when it could not be read, even if the form matches the server", async () => {
		const { storage, tab } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);

		const a = tab('A', { ...storage, getItem: refuse });
		expect(await a.restore('thought:1', SERVER)).toBeNull();
		a.sync('thought:1', SERVER, SERVER, 3);
		expect(storage.items.size).toBe(1);
	});

	it('does not remove anything when keys cannot be listed', async () => {
		const { storage, tab } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);

		const b = tab('A', { ...storage, keys: refuse });
		expect(await b.restore('thought:1', SERVER)).toBeNull();
		b.sync('thought:1', SERVER, SERVER, 3);
		expect(storage.items.size).toBe(1);
	});
});

describe('sync', () => {
	it('clears the backup only when the server confirmed the exact text', () => {
		const { tab, storage } = browser();
		const backups = tab('A');
		backups.sync('thought:1', MINE, SERVER, 3);
		expect(storage.items.size).toBe(1);

		// An older text was confirmed while the user typed more: the newer text stays.
		const newer = { ...MINE, body: 'my unsaved text, and more' };
		backups.sync('thought:1', newer, MINE, 4);
		expect(storage.items.size).toBe(1);

		backups.sync('thought:1', newer, newer, 5);
		expect(storage.items.size).toBe(0);
	});
});
