import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { copiesFromProposals, findSourcePassage } from './copies';
import { parseModelContent } from './splitter';

const ramble = `Rev keeps stalling on the deploy.
I think the EA argument   was weaker than it sounded,
honestly.

maybe email Michael about Friday`;

describe('copiesFromProposals', () => {
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

describe('parseModelContent', () => {
	it('keeps well-formed items and ignores the rest', () => {
		const content = JSON.stringify({
			thoughts: [{ label: 'a', text: 'b', todo: true }, { label: 1 }, 'nope']
		});
		expect(parseModelContent(content)).toEqual([{ label: 'a', text: 'b', todo: true }]);
	});

	it('returns nothing for unusable output', () => {
		expect(parseModelContent('not json')).toEqual([]);
		expect(parseModelContent('{"items": []}')).toEqual([]);
	});
});
