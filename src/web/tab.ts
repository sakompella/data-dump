import { z } from 'zod';
import { createEditorBackups } from './editor-backup';
import { browserStorage, guardStore } from './safe-storage';

const LOCK_PREFIX = 'data-dump:editor-tab:';

const tabId = crypto.randomUUID();

// Held while this page is open; a backup whose tab has a free lock was left by a tab that is gone.
void navigator.locks.request(`${LOCK_PREFIX}${tabId}`, () => new Promise<void>(() => {}));

const isTabGone = (other: string) =>
	navigator.locks.request(`${LOCK_PREFIX}${other}`, { ifAvailable: true }, (lock) => lock !== null);

// Editors report a refused write through this, so the page can say so.
export function editorBackups<Draft extends Readonly<Record<string, string>>>(
	draftSchema: z.ZodType<Draft>,
	onFailure: () => void
) {
	return createEditorBackups({
		store: guardStore(browserStorage(), onFailure),
		tabId,
		isTabGone,
		draftSchema
	});
}
