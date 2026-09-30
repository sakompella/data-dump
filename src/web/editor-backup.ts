// Unsaved edits of one thought or ramble, kept in browser storage.
//
// A backup record is removed only when
//   (a) the server confirmed that exact text,
//   (b) the user discarded it, or
//   (c) it was copied to another key and the copy was read back.
// A storage failure is "did not happen": it never removes a record and never
// reads as "nothing there".
//
// Keys carry the tab, so one tab never touches another live tab's backup. The
// backup of a tab that is gone (closed, or reloaded) can be picked up again.
import { z } from 'zod';
import { writeConfirmed, type BackupStore } from './safe-storage';

export type EditorDraft = Readonly<Record<string, string>>;

const PREFIX = 'data-dump:edit:';

// The kind and id of the edited document, for example `thought:0abc...`.
export type DocumentKey = string;

export interface FoundBackup<Draft extends EditorDraft> {
	readonly key: string;
	readonly draft: Draft;
	// The revision the edit started from; saving with it still detects newer writes.
	readonly revision: number;
}

export const sameDraft = (a: EditorDraft, b: EditorDraft): boolean =>
	Object.keys(a).length === Object.keys(b).length &&
	Object.keys(a).every((key) => a[key] === b[key]);

export function createEditorBackups<Draft extends EditorDraft>({
	store,
	tabId,
	isTabGone,
	draftSchema
}: {
	store: BackupStore;
	tabId: string;
	isTabGone: (tabId: string) => Promise<boolean>;
	draftSchema: z.ZodType<Draft>;
}) {
	const record = z.object({ draft: draftSchema, revision: z.number(), at: z.number() });

	const ownKey = (doc: DocumentKey) => `${PREFIX}${doc}:${tabId}`;

	const encode = (draft: Draft, revision: number) =>
		JSON.stringify({ draft, revision, at: Date.now() });

	// Documents whose stored backups could not all be read. Until they can, "the
	// form equals the server copy" must not remove this tab's record: it may be
	// one that was never looked at.
	const unread = new Set<DocumentKey>();

	// Valid records of this tab and of tabs that are gone, newest first. Records
	// that cannot be read or parsed are left where they are.
	async function records(doc: DocumentKey): Promise<FoundBackup<Draft>[]> {
		const keys = store.keys();

		if (keys === null) {
			unread.add(doc);

			return [];
		}

		const prefix = `${PREFIX}${doc}:`;
		const found: (FoundBackup<Draft> & { at: number })[] = [];

		for (const key of keys.filter((k) => k.startsWith(prefix))) {
			// `tab~time` keys are spare copies made by a tab; a live tab's own are still shown.
			const owner = key.slice(prefix.length).split('~')[0] ?? '';

			if (owner !== tabId && !(await isTabGone(owner))) continue;

			const read = store.read(key);

			if (!read.ok) {
				unread.add(doc);
				continue;
			}

			const parsed = parseRecord(read.value);

			if (parsed) found.push({ key, ...parsed });
		}

		return found.sort((a, b) => b.at - a.at);
	}

	function parseRecord(text: string | null) {
		try {
			const parsed = record.safeParse(JSON.parse(text ?? 'null'));

			return parsed.success ? parsed.data : null;
		} catch {
			return null;
		}
	}

	return {
		// Keeps this tab's backup equal to the text on screen while it differs
		// from the server's copy, and removes it once they match.
		sync(doc: DocumentKey, current: Draft, server: Draft, revision: number): void {
			if (!sameDraft(current, server)) {
				store.write(ownKey(doc), encode(current, revision));
			} else if (!unread.has(doc)) {
				store.remove(ownKey(doc));
			}
		},

		// The user discarded this tab's backup.
		remove(doc: DocumentKey): void {
			store.remove(ownKey(doc));
		},

		// The text to put back in the editor, if any: this tab's own backup, else
		// the newest of the gone tabs' (copied to this tab, and its source removed
		// only once the copy reads back). Backups equal to the server copy are
		// removed. Other distinct drafts stay where they are; see `others`.
		async restore(doc: DocumentKey, server: Draft): Promise<FoundBackup<Draft> | null> {
			const distinct: FoundBackup<Draft>[] = [];

			for (const backup of await records(doc)) {
				if (sameDraft(backup.draft, server)) store.remove(backup.key);
				else distinct.push(backup);
			}

			const chosen = distinct.find((backup) => backup.key === ownKey(doc)) ?? distinct[0];

			if (!chosen) return null;

			if (chosen.key !== ownKey(doc)) {
				const copied = writeConfirmed(store, ownKey(doc), encode(chosen.draft, chosen.revision));

				if (copied) store.remove(chosen.key);
			}

			return chosen;
		},

		// Distinct drafts of gone tabs that were not restored, for the user to look at.
		async others(doc: DocumentKey, server: Draft, shown: Draft): Promise<FoundBackup<Draft>[]> {
			return (await records(doc)).filter(
				(backup) =>
					backup.key !== ownKey(doc) &&
					!sameDraft(backup.draft, server) &&
					!sameDraft(backup.draft, shown)
			);
		},

		// Puts an other draft in the editor. What was in the editor is kept as its
		// own record first, and the other record is removed only after this tab's
		// record reads back as that draft. Returns false, changing nothing, if not.
		swapIn(
			doc: DocumentKey,
			other: FoundBackup<Draft>,
			current: { draft: Draft; revision: number },
			server: Draft
		): boolean {
			if (!sameDraft(current.draft, server)) {
				const spare = `${PREFIX}${doc}:${tabId}~${Date.now()}`;

				if (!writeConfirmed(store, spare, encode(current.draft, current.revision))) return false;
			}

			if (!writeConfirmed(store, ownKey(doc), encode(other.draft, other.revision))) return false;
			store.remove(other.key);

			return true;
		},

		// The user discarded another draft.
		discard(other: FoundBackup<Draft>): void {
			store.remove(other.key);
		}
	};
}
