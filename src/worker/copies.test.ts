import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { copiesFromProposals, findSourcePassage, keptPassages } from './copies';

const ramble = `Rev keeps stalling on the deploy.
I think the EA argument   was weaker than it sounded,
honestly.

maybe email Michael about Friday`;

describe('copiesFromProposals', () => {
	it('keeps a repeated or contained passage once, and a partly overlapping one as its own slice', () => {
		const copies = copiesFromProposals(ramble, [
			{ label: 'first', text: 'maybe email Michael', todo: true },
			{ label: 'again', text: 'maybe email Michael', todo: false },
			{ label: 'inside', text: 'email Michael', todo: false },
			{ label: 'wider', text: 'email Michael about Friday', todo: false }
		]);

		expect(copies).toEqual([
			{ label: 'first', body: 'maybe email Michael', todo: 'open' },
			{ label: 'wider', body: 'email Michael about Friday', todo: 'none' }
		]);
	});

	it('keeps verbatim passages as the exact source slice, in ramble order', () => {
		const copies = copiesFromProposals(ramble, [
			{ label: 'Michael', text: 'maybe email Michael about Friday', todo: true },
			{
				label: 'EA argument',
				text: 'I think the EA argument was weaker than it sounded, honestly.',
				todo: false
			}
		]);

		expect(copies).toEqual([
			{
				label: 'EA argument',
				body: 'I think the EA argument   was weaker than it sounded,\nhonestly.',
				todo: 'none'
			},
			{ label: 'Michael', body: 'maybe email Michael about Friday', todo: 'open' }
		]);
	});

	it('drops paraphrases and empty proposals', () => {
		const copies = copiesFromProposals(ramble, [
			{ label: 'Rev', text: 'Rev is stalling the deploy.', todo: false },
			{ label: 'blank', text: '  \n ', todo: false },
			{ label: 'Michael', text: 'Email Michael about Friday', todo: true }
		]);

		expect(copies).toEqual([]);
	});

	it('treats regex characters literally', () => {
		expect(findSourcePassage('a.b (c)', 'a.b (c)')?.text).toBe('a.b (c)');
		expect(findSourcePassage('axb (c)', 'a.b (c)')).toBeNull();
	});

	it('accepts any passage whose whitespace the model changed', () => {
		const text = fc.string({ unit: fc.constantFrom('a', 'b', '.', '(', '🙂', ' ', '\n', '\t') });
		fc.assert(
			fc.property(text, fc.nat(), fc.nat(), (body, i, j) => {
				const [start, end] = [i % (body.length + 1), j % (body.length + 1)].sort((x, y) => x - y);
				const proposal = body.slice(start, end).trim().split(/\s+/).join(' ');
				fc.pre(proposal !== '');
				const [copy] = copiesFromProposals(body, [{ label: '', text: proposal, todo: false }]);
				expect(body).toContain(copy.body);
				expect(copy.body.split(/\s+/).join(' ')).toBe(proposal);
			})
		);
	});

	it('only ever accepts substrings of the ramble', () => {
		const words = fc.array(fc.constantFrom('a', 'b', 'c.', '(d)', '🙂', '*'), { maxLength: 8 });
		const spacing = fc.constantFrom(' ', '  ', '\n', '\t');

		const text = fc
			.array(fc.tuple(words, spacing), { maxLength: 10 })
			.map((parts) => parts.map(([w, s]) => w.join(' ') + s).join(''));

		fc.assert(
			fc.property(text, fc.array(text, { maxLength: 5 }), (body, proposals) => {
				const copies = copiesFromProposals(
					body,
					proposals.map((p) => ({ label: '', text: p, todo: false }))
				);

				for (const copy of copies) {
					expect(body).toContain(copy.body);
					expect(copy.body.trim()).not.toBe('');
				}
			})
		);
	});
});

describe('keptPassages on any proposals', () => {
	const words = ['alpha', 'beta', 'gamma', 'delta'];

	const source = 'alpha beta gamma  delta alpha beta';

	const proposal = fc.record({
		label: fc.constant('l'),
		text: fc
			.array(fc.constantFrom(...words), { minLength: 1, maxLength: 3 })
			.map((picked) => picked.join(' ')),
		todo: fc.boolean()
	});

	it('keeps exact source slices, none inside another, and covers every proposed passage', () => {
		fc.assert(
			fc.property(fc.array(proposal, { maxLength: 8 }), (proposals) => {
				const kept = keptPassages(source, proposals);

				for (const { start, end, copy } of kept) expect(source.slice(start, end)).toBe(copy.body);

				for (const a of kept) {
					for (const b of kept) {
						if (a !== b) expect(a.start <= b.start && b.end <= a.end).toBe(false);
					}
				}

				for (const p of proposals) {
					const passage = findSourcePassage(source, p.text);

					if (passage) {
						const end = passage.start + passage.text.length;
						const covered = kept.some((k) => k.start <= passage.start && end <= k.end);
						expect(covered).toBe(true);
					}
				}
			})
		);
	});
});
