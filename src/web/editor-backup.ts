// Unsaved edits of one thought or ramble, kept in browser storage until the
// server confirms that exact text. Keys carry the tab, so one tab never
// touches another live tab's backup. A backup left by a tab that is gone
// (closed, or reloaded) can be picked up again.
import { z } from 'zod';
import type { KeyedStorage } from './safe-storage';

export type EditorDraft = Readonly<Record<string, string>>;

const PREFIX = 'data-dump:edit:';

// The kind and id of the edited document, for example `thought:0abc...`.
export type DocumentKey = string;

export interface FoundBackup<Draft extends EditorDraft> {
	readonly draft: Draft;
	// The revision the edit started from; saving with it still detects newer writes.
	readonly revision: number;
}

export const sameDraft = (a: EditorDraft, b: EditorDraft): boolean =>
	Object.keys(a).length === Object.keys(b).length &&
	Object.keys(a).every((key) => a[key] === b[key]);

export function createEditorBackups<Draft extends EditorDraft>({
	storage,
	tabId,
	isTabGone,
	draftSchema
}: {
	storage: KeyedStorage;
	tabId: string;
	isTabGone: (tabId: string) => Promise<boolean>;
	draftSchema: z.ZodType<Draft>;
}) {
	const record = z.object({ draft: draftSchema, revision: z.number(), at: z.number() });

	const keyFor = (doc: DocumentKey, tab: string) => `${PREFIX}${doc}:${tab}`;

	function read(key: string) {
		try {
			const parsed = record.safeParse(JSON.parse(storage.getItem(key) ?? 'null'));

			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	}

	// This tab's backup, and those of tabs that are gone; newest first.
	async function candidates(doc: DocumentKey) {
		const own = keyFor(doc, tabId);
		const prefix = `${PREFIX}${doc}:`;
		const found: { key: string; draft: Draft; revision: number; at: number }[] = [];

		for (const key of storage.keys().filter((k) => k.startsWith(prefix))) {
			if (key !== own && !(await isTabGone(key.slice(prefix.length)))) continue;
			const backup = read(key);

			if (backup) found.push({ key, ...backup });
		}

		return found.sort((a, b) => b.at - a.at);
	}

	return {
		// Keeps the backup equal to the text on screen while it differs from the
		// server's copy, and removes it once they match (that is, once the server
		// has confirmed exactly this text).
		sync(doc: DocumentKey, current: Draft, server: Draft, revision: number): void {
			if (sameDraft(current, server)) storage.removeItem(keyFor(doc, tabId));
			else
				storage.setItem(
					keyFor(doc, tabId),
					JSON.stringify({ draft: current, revision, at: Date.now() })
				);
		},

		remove(doc: DocumentKey): void {
			storage.removeItem(keyFor(doc, tabId));
		},

		// What to put back in the editor, if anything. Backups equal to the
		// server's copy are dropped. Restored backups of gone tabs move to this tab.
		async restore(doc: DocumentKey, server: Draft): Promise<FoundBackup<Draft> | null> {
			const all = await candidates(doc);
			const [best] = all.filter((backup) => !sameDraft(backup.draft, server));

			for (const backup of all) {
				if (backup.key !== keyFor(doc, tabId)) storage.removeItem(backup.key);
			}

			if (!best) {
				storage.removeItem(keyFor(doc, tabId));

				return null;
			}

			storage.setItem(
				keyFor(doc, tabId),
				JSON.stringify({ draft: best.draft, revision: best.revision, at: Date.now() })
			);

			return { draft: best.draft, revision: best.revision };
		}
	};
}
