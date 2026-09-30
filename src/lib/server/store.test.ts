import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newPublicationId, newRambleId, newThoughtId } from '$lib/ids';
import { TODO_STATES, type Ramble, type RambleState, type Thought } from '$lib/domain';
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

const rambleState: fc.Arbitrary<RambleState> = fc.oneof(
	fc.constantFrom<RambleState>({ status: 'open' }, { status: 'ended' }, { status: 'discarded' }),
	fc.constant(null).map((): RambleState => ({ status: 'split', publication: newPublicationId() }))
);

const date = fc.date({ min: new Date(0), max: new Date(4e12), noInvalidDate: true });

describe('frontmatter files', () => {
	it('round-trip rambles', () => {
		fc.assert(
			fc.property(rambleState, date, date, awkwardText, (state, createdAt, updatedAt, body) => {
				const ramble: Ramble = { id: newRambleId(), createdAt, updatedAt, body, ...state };
				expect(parseRamble(formatRamble(ramble))).toEqual(ramble);
			})
		);
	});

	it('round-trip thoughts, including awkward labels', () => {
		fc.assert(
			fc.property(
				awkwardText,
				fc.constantFrom(...TODO_STATES),
				date,
				awkwardText,
				fc.boolean(),
				(label, todo, createdAt, body, deleted) => {
					const thought: Thought = {
						id: newThoughtId(),
						rambleId: newRambleId(),
						publication: newPublicationId(),
						label,
						todo,
						createdAt,
						body,
						deleted
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
		expect(parseRamble('---\nid: 0000000aa-aaaaaaaa\nstatus: split\n---\n')).toBeNull();
	});
});
