import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newRambleId } from './ids';
import { IDLE_GAP_MS, isIdle } from './idle';
import { advance, canAdvance, RAMBLE_STATUSES, type Ramble } from './domain';

const ramble = (status: Ramble['status']): Ramble => ({
	id: newRambleId(),
	status,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	body: 'text'
});

describe('ramble lifecycle', () => {
	it('only moves one step forward', () => {
		const allowed = RAMBLE_STATUSES.flatMap((from) =>
			RAMBLE_STATUSES.filter((to) => canAdvance(from, to)).map((to) => `${from}->${to}`)
		);

		expect(allowed).toEqual(['open->ended', 'ended->split']);
	});

	it('refuses to move backward or skip', () => {
		expect(() => advance(ramble('split'), 'open')).toThrow();
		expect(() => advance(ramble('ended'), 'open')).toThrow();
		expect(() => advance(ramble('open'), 'split')).toThrow();
		expect(advance(ramble('open'), 'ended').status).toBe('ended');
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
