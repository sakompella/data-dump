// Serializes async work per key within this process.
export function createKeyedMutex() {
	const tails = new Map<string, Promise<unknown>>();

	return async function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = tails.get(key) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(work);
		tails.set(key, result);
		try {
			return await result;
		} finally {
			if (tails.get(key) === result) tails.delete(key);
		}
	};
}
