import { describe, expect, it } from 'vitest';
import { tolerant, type KeyedStorage } from './safe-storage';

const broken: KeyedStorage = {
	getItem: () => {
		throw new Error('blocked');
	},
	setItem: () => {
		throw new DOMException('full', 'QuotaExceededError');
	},
	removeItem: () => {
		throw new Error('blocked');
	},
	keys: () => {
		throw new Error('blocked');
	}
};

describe('tolerant', () => {
	it('never throws, gives empty answers, and reports each failure', () => {
		let failures = 0;
		const storage = tolerant(broken, () => (failures += 1));

		expect(storage.getItem('a')).toBeNull();
		expect(() => storage.setItem('a', 'b')).not.toThrow();
		expect(() => storage.removeItem('a')).not.toThrow();
		expect(storage.keys()).toEqual([]);
		expect(failures).toBe(4);
	});

	it('reports nothing when storage works', () => {
		const items = new Map<string, string>();
		let failures = 0;

		const storage = tolerant(
			{
				getItem: (key) => items.get(key) ?? null,
				setItem: (key, value) => void items.set(key, value),
				removeItem: (key) => void items.delete(key),
				keys: () => [...items.keys()]
			},
			() => (failures += 1)
		);

		storage.setItem('a', 'b');
		expect(storage.getItem('a')).toBe('b');
		expect(storage.keys()).toEqual(['a']);
		expect(failures).toBe(0);
	});
});
