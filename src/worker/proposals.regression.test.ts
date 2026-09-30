import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { newRambleId } from '../shared/ids';
import type { ProposedThought } from '../shared/proposals';
import { createNodeSql } from './testing/node-sql';
import { createUserRules, migrate } from './rules';

// Distinct words, so each thought body sits at exactly one place in the ramble.
const WORDS = Array.from({ length: 12 }, (_, index) => `w${index}x`);

const RAMBLE = WORDS.join(' ');

// A proposal quoting words [from, to) of the ramble, spaced however the model likes.
const quote = fc
	.tuple(
		fc.integer({ min: 0, max: WORDS.length - 1 }),
		fc.integer({ min: 1, max: 4 }),
		fc.constantFrom(' ', '  ', '\n', ' \t')
	)
	.map(([from, length, gap]): ProposedThought => ({
		label: 'l',
		text: WORDS.slice(from, from + length).join(gap),
		todo: false
	}));

function publishedRanges(proposals: readonly ProposedThought[]) {
	const sql = createNodeSql();
	migrate(sql, new Date(0));
	const data = createUserRules({ sql, now: () => new Date(0) });
	const id = newRambleId();
	data.saveDraft({ id, body: RAMBLE, base: null });
	const pending = data.endRamble(id);

	if (!pending) throw new Error('the ramble did not end');
	data.finishSplit({ id, revision: pending.revision, proposals });
	const bodies = data.home().thoughts.map((thought) => thought.body);
	sql.close();

	return bodies.map((body) => ({
		body,
		start: RAMBLE.indexOf(body),
		end: RAMBLE.indexOf(body) + body.length
	}));
}

describe('publishing proposals', () => {
	it('stores only passages of the ramble itself', () => {
		fc.assert(
			fc.property(fc.array(quote, { maxLength: 8 }), (proposals) => {
				for (const { body, start } of publishedRanges(proposals)) {
					expect(start, body).toBeGreaterThanOrEqual(0);
					expect(body.trim()).not.toBe('');
				}
			})
		);
	});

	it('never makes two thoughts from one passage proposed twice', () => {
		fc.assert(
			fc.property(fc.array(quote, { minLength: 1, maxLength: 4 }), (proposals) => {
				const ranges = publishedRanges([...proposals, ...proposals]).map(
					({ start, end }) => `${start}-${end}`
				);

				expect(new Set(ranges).size, ranges.join(', ')).toBe(ranges.length);
			})
		);
	});

	it('drops a proposal only when a kept thought already covers its whole passage', () => {
		fc.assert(
			// With no proposals the whole ramble is kept instead, a separate rule.
			fc.property(fc.array(quote, { minLength: 1, maxLength: 8 }), (proposals) => {
				const kept = publishedRanges(proposals);
				const proposed = proposals.map(({ text }) => rangeOf(text));
				const label = (r: Range) => `${r.start}-${r.end}`;

				for (const range of kept) {
					expect(proposed.map(label), `kept ${label(range)} was proposed`).toContain(label(range));
				}

				for (const range of proposed) {
					const covered = kept.some((k) => k.start <= range.start && range.end <= k.end);
					expect(covered, `${label(range)} is covered by a kept thought`).toBe(true);
				}
			})
		);
	});

	it('keeps partly overlapping passages as separate exact slices', () => {
		const proposals = ['w0x w1x', 'w1x w2x'].map((text) => ({ label: 'l', text, todo: false }));
		expect(
			publishedRanges(proposals)
				.map(({ body }) => body)
				.sort()
		).toEqual(['w0x w1x', 'w1x w2x']);
	});
});

type Range = { start: number; end: number };

// Where a quote of distinct ramble words sits in the ramble.
function rangeOf(text: string): Range {
	const words = text.split(/\s+/).filter((word) => word !== '');
	const first = words[0] ?? '';
	const last = words[words.length - 1] ?? '';

	return { start: RAMBLE.indexOf(first), end: RAMBLE.indexOf(last) + last.length };
}
