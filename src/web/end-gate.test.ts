import { describe, expect, it } from 'vitest';
import { oncePerGeneration } from './end-gate';

function deferred() {
	let finish: () => void = () => {};

	const promise = new Promise<void>((resolve) => (finish = resolve));

	return { promise, finish };
}

describe('oncePerGeneration', () => {
	it('shares one run between triggers for the same capture', async () => {
		let generation = 1;
		let runs = 0;
		const wait = deferred();
		const gate = oncePerGeneration(() => generation);

		const first = gate(async () => {
			runs += 1;
			await wait.promise;
		});

		const second = gate(async () => {
			runs += 1;
		});

		expect(second).toBe(first);
		wait.finish();
		await first;
		expect(runs).toBe(1);
	});

	it('lets a new capture start its own run while the old one is unfinished', async () => {
		let generation = 1;
		const wait = deferred();
		const gate = oncePerGeneration(() => generation);
		const ended: number[] = [];

		const old = gate(async () => {
			await wait.promise;
			ended.push(1);
		});

		generation = 2;
		await gate(async () => void ended.push(2));
		wait.finish();
		await old;
		expect(ended).toEqual([2, 1]);
	});

	it('allows a retry after a run failed', async () => {
		const gate = oncePerGeneration(() => 1);
		await expect(gate(() => Promise.reject(new Error('save failed')))).rejects.toThrow();

		let retried = false;
		await gate(async () => void (retried = true));
		expect(retried).toBe(true);
	});
});
