import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newRambleId, newThoughtId } from '$lib/ids';
import { RAMBLE_STATUSES, TODO_STATES, type Ramble, type Thought } from '$lib/domain';
import { formatRamble, formatThought, parseRamble, parseThought } from './store';

const awkwardText = fc.oneof(
	fc.string({ unit: 'grapheme' }),
	fc.string({ unit: 'binary' }),
	fc
		.array(fc.constantFrom('---', '\n', '\r\n', ' ', '\t', 'é', '🙂', 'a: b', '# x', '"'), {
			maxLength: 12
		})
		.map((parts) => parts.join(''))
);

const date = fc.date({ min: new Date(0), max: new Date(4e12), noInvalidDate: true });

describe('frontmatter files', () => {
	it('round-trip rambles', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...RAMBLE_STATUSES),
				date,
				date,
				awkwardText,
				(status, createdAt, updatedAt, body) => {
					const ramble: Ramble = { id: newRambleId(), status, createdAt, updatedAt, body };
					expect(parseRamble(formatRamble(ramble))).toEqual(ramble);
				}
			)
		);
	});

	it('round-trip thoughts, including awkward labels', () => {
		fc.assert(
			fc.property(
				awkwardText,
				fc.constantFrom(...TODO_STATES),
				date,
				awkwardText,
				(label, todo, createdAt, body) => {
					const thought: Thought = {
						id: newThoughtId(),
						rambleId: newRambleId(),
						label,
						todo,
						createdAt,
						body
					};

					expect(parseThought(formatThought(thought))).toEqual(thought);
				}
			)
		);
	});

	it('rejects malformed files', () => {
		expect(parseRamble('no frontmatter')).toBeNull();
		expect(parseRamble('---\nid: nope\nstatus: open\n---\nbody')).toBeNull();
		expect(parseThought('---\n: : :\n---\n')).toBeNull();
	});
});
