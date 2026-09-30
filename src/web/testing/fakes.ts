import type { WithLock } from '../chatgpt/auth';

// Stands in for navigator.locks: work under one name runs one at a time, in order.
export function createFakeLocks(): WithLock {
	const tails = new Map<string, Promise<unknown>>();

	return async function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
		const previous = tails.get(name) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(work);
		tails.set(name, result);

		try {
			return await result;
		} finally {
			if (tails.get(name) === result) tails.delete(name);
		}
	};
}

// Stands in for localStorage, which every tab of an origin shares.
export function createFakeStorage() {
	const items = new Map<string, string>();

	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
		keys: () => [...items.keys()]
	};
}
