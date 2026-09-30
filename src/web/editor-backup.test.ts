import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEditorBackups } from './editor-backup';
import { tolerant, type KeyedStorage } from './safe-storage';
import { createFakeStorage } from './testing/fakes';

const draftSchema = z.object({ label: z.string(), body: z.string() });

const SERVER = { label: 'l', body: 'server text' };

const MINE = { label: 'l', body: 'my unsaved text' };

// Tabs of one browser share storage; `gone` lists the tabs whose lock is free.
function browser() {
	const storage = createFakeStorage();
	const gone = new Set<string>();

	const tab = (tabId: string, shared: KeyedStorage = storage) =>
		createEditorBackups({
			storage: shared,
			tabId,
			isTabGone: async (other) => gone.has(other),
			draftSchema
		});

	return { storage, gone, tab };
}

describe('editor backups', () => {
	it('restores after navigating away and coming back in the same tab', async () => {
		const { tab } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);

		// The page is left and mounted again: a new backups object, the same tab.
		expect(await tab('A').restore('thought:1', SERVER)).toEqual({ draft: MINE, revision: 3 });
	});

	it('restores after a reload, when the old tab is gone, and keeps the base revision', async () => {
		const { tab, gone } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		gone.add('A');

		expect(await tab('B').restore('thought:1', SERVER)).toEqual({ draft: MINE, revision: 3 });
		// It now belongs to the new tab, so it survives another reload.
		gone.add('B');
		expect(await tab('C').restore('thought:1', SERVER)).toEqual({ draft: MINE, revision: 3 });
	});

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

	it('leaves another live tab and another document alone', async () => {
		const { tab, storage } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		tab('A').sync('thought:2', { label: 'x', body: 'other' }, SERVER, 1);

		expect(await tab('B').restore('thought:1', SERVER)).toBeNull();
		expect(storage.items.size).toBe(2);

		tab('B').remove('thought:1');
		expect(storage.items.size).toBe(2);
	});

	it('drops a backup that equals the server copy and one that cannot be read', async () => {
		const { tab, storage, gone } = browser();
		tab('A').sync('thought:1', MINE, SERVER, 3);
		storage.setItem('data-dump:edit:thought:1:Z', '{not json');
		gone.add('A');
		gone.add('Z');

		expect(await tab('B').restore('thought:1', MINE)).toBeNull();
		expect([...storage.items.keys()]).toEqual(['data-dump:edit:thought:1:Z']);
	});

	it('keeps working when storage throws on every call', async () => {
		let failures = 0;

		const refusing: KeyedStorage = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('quota');
			},
			removeItem: () => {
				throw new Error('blocked');
			},
			keys: () => {
				throw new Error('blocked');
			}
		};

		const { tab } = browser();

		const backups = tab(
			'A',
			tolerant(refusing, () => (failures += 1))
		);

		backups.sync('thought:1', MINE, SERVER, 3);

		expect(await backups.restore('thought:1', SERVER)).toBeNull();
		expect(failures).toBeGreaterThan(0);
	});
});
