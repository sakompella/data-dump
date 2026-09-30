import { describe, expect, it } from 'vitest';
import { guardStore, writeConfirmed, type KeyedStorage } from './safe-storage';
import { createFakeStorage } from './testing/fakes';

const refuse = () => {
	throw new Error('blocked');
};

const working = (): KeyedStorage => createFakeStorage();

describe('guardStore', () => {
	it('reports every kind of failure as a failure, never as empty or done', () => {
		let failures = 0;

		const store = guardStore(
			{ getItem: refuse, setItem: refuse, removeItem: refuse, keys: refuse },
			() => (failures += 1)
		);

		expect(store.read('a')).toEqual({ ok: false });
		expect(store.write('a', 'b')).toBe(false);
		expect(store.remove('a')).toBe(false);
		expect(store.keys()).toBeNull();
		expect(failures).toBe(4);
	});

	it('tells an absent key from a failed read', () => {
		const store = guardStore(working(), () => {});

		expect(store.read('missing')).toEqual({ ok: true, value: null });
		expect(store.write('a', 'b')).toBe(true);
		expect(store.read('a')).toEqual({ ok: true, value: 'b' });
		expect(store.keys()).toEqual(['a']);
	});
});

describe('writeConfirmed', () => {
	it('is false when the write fails, and when the value cannot be read back', () => {
		const noWrite = guardStore({ ...working(), setItem: refuse }, () => {});
		expect(writeConfirmed(noWrite, 'a', 'b')).toBe(false);

		const noRead = guardStore({ ...working(), getItem: refuse }, () => {});
		expect(writeConfirmed(noRead, 'a', 'b')).toBe(false);

		const forgetful = guardStore({ ...working(), setItem: () => {} }, () => {});
		expect(writeConfirmed(forgetful, 'a', 'b')).toBe(false);
	});

	it('is true when the store holds the value', () => {
		expect(
			writeConfirmed(
				guardStore(working(), () => {}),
				'a',
				'b'
			)
		).toBe(true);
	});
});
