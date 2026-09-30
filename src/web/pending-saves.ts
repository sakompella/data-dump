// Saves started while a page unmounts. The next page waits for them, so it
// never loads a draft older than the text the user just typed.
let pending: Promise<void> = Promise.resolve();

export function trackSave(save: Promise<unknown>): void {
	const before = pending;
	pending = (async () => {
		await before;
		await save.catch(() => undefined);
	})();
}

export const savesSettled = (): Promise<void> => pending;
