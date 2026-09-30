import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newRambleId, parseRevision, type RambleId, type Revision } from '../shared/ids';
import { IDLE_GAP_MS } from '../shared/idle';
import type { ProposedThought } from '../shared/proposals';
import { createNodeSql } from './testing/node-sql';
import { createUserRules, migrate, type UserRules } from './rules';

const BODY = 'Rev keeps stalling. maybe email Michael about Friday';

const PROPOSALS: ProposedThought[] = [
	{ label: 'Rev', text: 'Rev keeps stalling.', todo: false },
	{ label: 'Michael', text: 'maybe email Michael about Friday', todo: true }
];

function revisionOf(n: number): Revision {
	const parsed = parseRevision(n);

	if (parsed === null) throw new Error(`bad revision ${n}`);

	return parsed;
}

function open() {
	let clock = Date.parse('2026-01-01T00:00:00Z');
	const sql = createNodeSql();
	migrate(sql, new Date(clock));
	const data = createUserRules({ sql, now: () => new Date(clock) });

	return { sql, data, advance: (ms: number) => void (clock += ms) };
}

let db: ReturnType<typeof open>;

let data: UserRules;

beforeEach(() => {
	db = open();
	data = db.data;
});

afterEach(() => db.sql.close());

function savedRamble(body = BODY) {
	const id = newRambleId();
	const { revision } = data.saveDraft({ id, body, base: null });

	if (revision === null) throw new Error('nothing was saved');

	return { id, revision };
}

function splitRamble(proposals = PROPOSALS) {
	const { id } = savedRamble();
	const pending = data.endRamble(id);

	if (!pending) throw new Error('ramble did not end');

	return { id, result: data.finishSplit({ id, revision: pending.revision, proposals }) };
}

describe('migrate', () => {
	it('runs each migration once', () => {
		migrate(db.sql, new Date());
		expect(db.sql.query('SELECT version FROM migrations')).toEqual([
			{ version: 1 },
			{ version: 2 }
		]);
	});
});

describe('saveDraft', () => {
	it('creates a ramble on the first non-empty save only', () => {
		const id = newRambleId();
		expect(data.saveDraft({ id, body: '', base: null })).toEqual({ id, revision: null });
		expect(data.ramble(id)).toBeNull();
		expect(data.saveDraft({ id, body: 'hello', base: null })).toEqual({ id, revision: 1 });
		expect(data.ramble(id)?.ramble).toMatchObject({ status: 'open', body: 'hello' });
	});

	it('puts a save from a stale revision into a new ramble instead of overwriting', () => {
		const { id, revision } = savedRamble('first');
		const tabA = data.saveDraft({ id, body: 'first, then tab A', base: revision });
		const tabB = data.saveDraft({ id, body: 'first, then tab B', base: revision });

		expect(tabA).toEqual({ id, revision: 2 });
		expect(tabB.id).not.toBe(id);
		expect(data.ramble(id)?.ramble.body).toBe('first, then tab A');
		expect(data.ramble(tabB.id)?.ramble).toMatchObject({
			status: 'open',
			body: 'first, then tab B'
		});
	});

	it('treats a resend of the stored text as saved', () => {
		const { id, revision } = savedRamble();
		expect(data.saveDraft({ id, body: BODY, base: null })).toEqual({ id, revision });
	});

	it('puts text for a ramble that is no longer open into a new ramble', () => {
		const { id, revision } = savedRamble();
		data.endRamble(id);
		const late = data.saveDraft({ id, body: `${BODY} and more`, base: revision });

		expect(late.id).not.toBe(id);
		expect(data.ramble(late.id)?.ramble.body).toBe(`${BODY} and more`);
		expect(data.ramble(id)?.ramble).toMatchObject({ status: 'ended', body: BODY });
	});
});

describe('endRamble', () => {
	it('returns the text and revision to split', () => {
		const { id } = savedRamble();
		expect(data.endRamble(id)).toEqual({ id, body: BODY, revision: 2 });
		expect(data.endRamble(id)).toEqual({ id, body: BODY, revision: 2 });
	});

	it('deletes an empty ramble; later text goes into a new one', () => {
		const { id, revision } = savedRamble('x');
		const blank = data.saveDraft({ id, body: '  ', base: revision });
		expect(data.endRamble(id)).toBeNull();
		expect(data.ramble(id)).toBeNull();

		const late = data.saveDraft({ id, body: 'typed late', base: blank.revision });
		expect(data.ramble(late.id)?.ramble.body).toBe('typed late');
	});

	it('never brings a deleted ramble id back, even for a first save', () => {
		const { id } = savedRamble('x');
		data.saveDraft({ id, body: ' ', base: revisionOf(1) });
		data.endRamble(id);

		const late = data.saveDraft({ id, body: 'typed late', base: null });
		expect(late.id).not.toBe(id);
		expect(data.ramble(id)).toBeNull();
	});
});

describe('settleOnLoad', () => {
	it('ends open rambles past the idle gap and keeps fresh ones open', () => {
		const stale = savedRamble();
		db.advance(IDLE_GAP_MS + 1);
		const fresh = savedRamble('still going');
		data.settleOnLoad();
		const { draft, pending } = data.home();

		expect(draft?.id).toBe(fresh.id);
		expect(pending).toEqual([{ id: stale.id, body: BODY, revision: 2 }]);
	});
});

describe('finishSplit', () => {
	it('publishes the exact copies, once', () => {
		const { id, result } = splitRamble();
		expect(result).toEqual({ kind: 'published' });
		expect(data.finishSplit({ id, revision: revisionOf(2), proposals: [] })).toEqual(result);

		const { thoughts } = data.home();
		expect(thoughts.map((t) => t.body).sort()).toEqual(PROPOSALS.map((p) => p.text).sort());
		expect(thoughts.map((t) => t.todo).sort()).toEqual(['none', 'open']);
		expect(data.ramble(id)?.ramble.status).toBe('split');
	});

	it('keeps the whole ramble when nothing proposed is the user’s own words', () => {
		splitRamble([{ label: 'x', text: 'a paraphrase', todo: true }]);
		const { thoughts } = data.home();
		expect(thoughts).toHaveLength(1);
		expect(thoughts[0]).toMatchObject({
			body: BODY,
			todo: 'none',
			label: 'Rev keeps stalling. maybe email'
		});
	});

	it('does nothing for a ramble that has not ended', () => {
		const { id, revision } = savedRamble();
		expect(data.finishSplit({ id, revision, proposals: PROPOSALS })).toEqual({
			kind: 'not-ended',
			status: 'open'
		});
		expect(data.home().thoughts).toEqual([]);
	});

	it('refuses proposals made from a body that was edited since', () => {
		const { id } = savedRamble();
		const pending = data.endRamble(id);

		if (!pending) throw new Error('ramble did not end');
		expect(data.editRamble({ id, body: 'Rev keeps stalling.', base: pending.revision })).toBe(
			'saved'
		);
		expect(data.finishSplit({ id, revision: pending.revision, proposals: PROPOSALS })).toEqual({
			kind: 'stale'
		});
		expect(data.home().pending).toEqual([{ id, body: 'Rev keeps stalling.', revision: 3 }]);
	});

	it('writes nothing when a thought insert fails', () => {
		const { id } = savedRamble();
		const pending = data.endRamble(id);

		if (!pending) throw new Error('ramble did not end');
		db.sql.query(
			"CREATE TRIGGER fail_second BEFORE INSERT ON thoughts WHEN (SELECT COUNT(*) FROM thoughts) = 1 BEGIN SELECT RAISE(ABORT, 'boom'); END"
		);
		expect(() =>
			data.finishSplit({ id, revision: pending.revision, proposals: PROPOSALS })
		).toThrow();
		expect(db.sql.query('SELECT COUNT(*) AS n FROM thoughts')).toEqual([{ n: 0 }]);
		expect(data.ramble(id)?.ramble.status).toBe('ended');
	});
});

describe('edits', () => {
	function publishedThought() {
		splitRamble();
		const [thought] = data.home().thoughts;

		return thought;
	}

	it('refuses a ramble edit based on an old revision', () => {
		const { id, revision } = savedRamble();
		data.saveDraft({ id, body: `${BODY}!`, base: revision });
		expect(data.editRamble({ id, body: 'stale', base: revision })).toBe('conflict');
		expect(data.ramble(id)?.ramble.body).toBe(`${BODY}!`);
	});

	it('keeps a split ramble and its thoughts when its body is edited', () => {
		const { id } = splitRamble();
		const before = data.ramble(id);

		if (!before) throw new Error('missing');
		expect(data.editRamble({ id, body: 'edited', base: before.ramble.revision })).toBe('saved');
		expect(data.ramble(id)?.ramble).toMatchObject({ status: 'split', body: 'edited' });
		expect(data.ramble(id)?.thoughts).toEqual(before.thoughts);
	});

	it('refuses a thought edit based on an old revision', () => {
		const thought = publishedThought();
		const base = thought.revision;
		expect(data.editThought({ id: thought.id, base, edit: { todo: 'done' } })).toBe('saved');
		expect(data.editThought({ id: thought.id, base, edit: { label: 'x' } })).toBe('conflict');
		expect(data.thought(thought.id)).toMatchObject({ todo: 'done', label: thought.label });
	});

	it('deletes a thought for good; editing it afterwards finds nothing', () => {
		const thought = publishedThought();
		expect(data.deleteThought({ id: thought.id, base: thought.revision })).toBe('saved');
		expect(data.thought(thought.id)).toBeNull();
		expect(
			data.editThought({ id: thought.id, base: thought.revision, edit: { label: 'back?' } })
		).toBe('missing');
	});

	it('refuses a delete based on an old revision', () => {
		const thought = publishedThought();
		data.editThought({ id: thought.id, base: thought.revision, edit: { todo: 'done' } });
		expect(data.deleteThought({ id: thought.id, base: thought.revision })).toBe('conflict');
		expect(data.thought(thought.id)).not.toBeNull();
	});
});

// Two tabs and a page editor act on the same rambles in any order, each
// working from whatever revision it last saw.
type Op =
	| { kind: 'type'; tab: 0 | 1; word: string }
	| { kind: 'end'; tab: 0 | 1 }
	| { kind: 'split'; tab: 0 | 1; proposals: ProposedThought[]; fresh: boolean }
	| { kind: 'edit-page'; tab: 0 | 1; word: string };

const tab = fc.constantFrom(0 as const, 1 as const);

const word = fc.constantFrom('alpha', 'beta.', 'gamma', 'delta!', ' ');

const op: fc.Arbitrary<Op> = fc.oneof(
	fc.record({ kind: fc.constant('type' as const), tab, word }),
	fc.record({ kind: fc.constant('end' as const), tab }),
	fc.record({
		kind: fc.constant('split' as const),
		tab,
		fresh: fc.boolean(),
		proposals: fc.array(
			fc.record({
				label: fc.constant('l'),
				text: fc.constantFrom('alpha', 'beta.', 'gamma delta!', 'nope'),
				todo: fc.boolean()
			}),
			{ maxLength: 3 }
		)
	}),
	fc.record({ kind: fc.constant('edit-page' as const), tab, word })
);

describe('any order of saves, ends, splits, and edits', () => {
	it('never loses saved text, splits each ramble once, and never overwrites a newer save', () => {
		fc.assert(
			fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
				const { data: d, sql } = open();
				// Both tabs start on one ramble, as after restoring one backup twice.
				const start = newRambleId();

				const tabs: { id: RambleId; revision: Revision | null; text: string }[] = [
					{ id: start, revision: null, text: '' },
					{ id: start, revision: null, text: '' }
				];

				// The last text the server confirmed for each ramble id.
				const confirmed = new Map<RambleId, string>();
				// Thoughts of each ramble as first published.
				const published = new Map<RambleId, string[]>();

				const bodies = (id: RambleId) => (d.ramble(id)?.thoughts ?? []).map((t) => t.body).sort();

				for (const o of ops) {
					const t = tabs[o.tab];

					if (o.kind === 'type') {
						t.text += o.word;
						const saved = d.saveDraft({ id: t.id, body: t.text, base: t.revision });
						t.id = saved.id;
						t.revision = saved.revision;

						if (saved.revision !== null) confirmed.set(saved.id, t.text);
					}

					if (o.kind === 'end') {
						const pending = d.endRamble(t.id);

						if (pending === null && d.ramble(t.id) === null) confirmed.delete(t.id);
					}

					if (o.kind === 'split') {
						const current = d.ramble(t.id)?.ramble;
						const revision = o.fresh && current ? current.revision : (t.revision ?? revisionOf(1));
						const result = d.finishSplit({ id: t.id, revision, proposals: o.proposals });

						if (result.kind === 'published' && !published.has(t.id)) {
							published.set(t.id, bodies(t.id));
							const ramble = d.ramble(t.id)?.ramble;

							for (const body of published.get(t.id) ?? []) expect(ramble?.body).toContain(body);
						}
					}

					if (o.kind === 'edit-page') {
						const current = d.ramble(t.id)?.ramble;

						if (
							current &&
							d.editRamble({ id: t.id, body: current.body + o.word, base: current.revision }) ===
								'saved'
						) {
							confirmed.set(t.id, current.body + o.word);
						}
					}
				}

				for (const [id, body] of confirmed) expect(d.ramble(id)?.ramble.body).toBe(body);

				// A tab's saved text is never replaced by another tab; page edits only append.
				// Ending deletes a blank ramble, so only tabs with real text are checked.
				for (const { id, text, revision } of tabs) {
					if (revision === null || text.trim() === '') continue;
					expect(d.ramble(id)?.ramble.body.startsWith(text)).toBe(true);
				}

				for (const [id, first] of published) {
					expect(bodies(id)).toEqual(first);
					expect(first.length).toBeGreaterThan(0);
				}

				sql.close();
			}),
			{ numRuns: 300 }
		);
	});
});
