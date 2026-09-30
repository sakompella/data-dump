// Browser storage can refuse writes (quota, blocked storage). Backups are a
// safety net, so their failure must never stop the code that uses them.
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

// Every method swallows a thrown error and reports it through `onFailure`.
export function tolerant(storage: KeyedStorage, onFailure: () => void): KeyedStorage {
	function attempt<T>(work: () => T, fallback: T): T {
		try {
			return work();
		} catch {
			onFailure();

			return fallback;
		}
	}

	return {
		getItem: (key) => attempt(() => storage.getItem(key), null),
		setItem: (key, value) => attempt(() => storage.setItem(key, value), undefined),
		removeItem: (key) => attempt(() => storage.removeItem(key), undefined),
		keys: () => attempt(() => storage.keys(), [])
	};
}
