// Browser storage can refuse reads and writes (quota, blocked storage). Backups
// are a safety net, so a failure must never stop the code that uses them, and
// it must never look like "empty" or "done": every call says whether it worked,
// and code that deletes a backup only does so after a confirmed success.
export interface KeyedStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
	keys(): string[];
}

export const browserStorage = (): KeyedStorage => ({
	getItem: (key) => localStorage.getItem(key),
	setItem: (key, value) => localStorage.setItem(key, value),
	removeItem: (key) => localStorage.removeItem(key),
	keys: () => Object.keys(localStorage)
});

// `ok: false` means the read did not happen; `value: null` means the key is absent.
export type Read = { readonly ok: true; readonly value: string | null } | { readonly ok: false };

export interface BackupStore {
	read(key: string): Read;
	write(key: string, value: string): boolean;
	remove(key: string): boolean;
	// Null when the keys could not be listed.
	keys(): string[] | null;
}

// Every failure is reported through `onFailure` and returned as a failure result.
export function guardStore(storage: KeyedStorage, onFailure: () => void): BackupStore {
	function attempt<T, Failed>(work: () => T, failed: Failed): T | Failed {
		try {
			return work();
		} catch {
			onFailure();

			return failed;
		}
	}

	return {
		read: (key) =>
			attempt(() => ({ ok: true as const, value: storage.getItem(key) }), { ok: false as const }),
		write: (key, value) => attempt(() => (storage.setItem(key, value), true), false),
		remove: (key) => attempt(() => (storage.removeItem(key), true), false),
		keys: () => attempt(() => storage.keys(), null)
	};
}

// Writes, then reads the value back. True only if the store now holds exactly `value`.
export function writeConfirmed(store: BackupStore, key: string, value: string): boolean {
	if (!store.write(key, value)) return false;
	const back = store.read(key);

	return back.ok && back.value === value;
}
