import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newPublicationId, newRambleId } from '$lib/ids';
import { IDLE_GAP_MS, isIdle } from '$lib/idle';
import { advance, canAdvance, RAMBLE_STATUSES, type Ramble, type RambleState } from './domain';

const ramble = (state: RambleState): Ramble => ({
	id: newRambleId(),
	createdAt: new Date(0),
	updatedAt: new Date(0),
	body: 'text',
	...state
});

const split: RambleState = { status: 'split', publication: newPublicationId() };

describe('ramble lifecycle', () => {
	it('only moves one step forward', () => {
		const allowed = RAMBLE_STATUSES.flatMap((from) =>
			RAMBLE_STATUSES.filter((to) => canAdvance(from, to)).map((to) => `${from}->${to}`)
		);

		expect(allowed).toEqual(['open->ended', 'open->discarded', 'ended->split']);
	});

	it('refuses to move backward or skip', () => {
		expect(() => advance(ramble(split), { status: 'open' })).toThrow();
		expect(() => advance(ramble({ status: 'ended' }), { status: 'open' })).toThrow();
		expect(() => advance(ramble({ status: 'open' }), split)).toThrow();
		expect(() => advance(ramble({ status: 'discarded' }), { status: 'ended' })).toThrow();
		expect(advance(ramble({ status: 'open' }), { status: 'ended' }).status).toBe('ended');
		expect(advance(ramble({ status: 'ended' }), split)).toMatchObject(split);
	});
});

describe('idle gap', () => {
	it('is idle exactly when more than IDLE_GAP has passed', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 0, max: 1e9 }), (t, gap) => {
				expect(isIdle(new Date(t), new Date(t + gap))).toBe(gap > IDLE_GAP_MS);
			})
		);
	});
});
