import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newRambleId, parseRevision, type RambleId, type Revision } from '../shared/ids';
import { IDLE_GAP_MS } from '../shared/idle';
import { createNodeSql } from './testing/node-sql';
import { createUserRules, migrate, type UserRules } from './rules';

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

const rambleCount = () => db.sql.query('SELECT COUNT(*) AS n FROM rambles');

function storedRevision(d: UserRules, id: RambleId): Revision {
	const current = d.ramble(id)?.ramble.revision;

	if (current === undefined) throw new Error(`no ramble ${id}`);

	return current;
}

const savedEdit = z.object({ kind: z.literal('saved'), revision: z.number() });

// The revision a successful edit answered with.
function answeredRevision<Result>(result: Result): Revision {
	const revision = parseRevision(savedEdit.parse(result).revision);

	if (revision === null) throw new Error('the edit answered with no usable revision');

	return revision;
}

function publishedThought() {
	const id = newRambleId();
	data.saveDraft({ id, body: 'a ramble', base: null });
	const pending = data.endRamble(id);

	if (!pending) throw new Error('the ramble did not end');
	data.finishSplit({ id, revision: pending.revision, proposals: [] });
	const [thought] = data.home().thoughts;

	if (!thought) throw new Error('the split published no thought');

	return thought;
}

describe('splitting a ramble edited to blank', () => {
	it('publishes nothing and discards the ramble, as ending a blank ramble does', () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[ \t\n]*$/), (blank) => {
				const { data: d, sql } = open();
				const id = newRambleId();
				d.saveDraft({ id, body: 'something', base: null });
				d.endRamble(id);
				d.editRamble({ id, body: blank, base: storedRevision(d, id) });

				expect(d.finishSplit({ id, revision: storedRevision(d, id), proposals: [] })).toEqual({
					kind: 'published'
				});
				expect(d.home()).toMatchObject({ thoughts: [], pending: [] });
				expect(d.ramble(id)).toBeNull();
				expect(d.saveDraft({ id, body: 'typed late', base: null }).id).not.toBe(id);
				sql.close();
			}),
			{ numRuns: 50 }
		);
	});
});

describe('an edit answers with the new revision', () => {
	it('so a ramble write from elsewhere between two edits makes the second one a conflict', () => {
		const id = newRambleId();
		data.saveDraft({ id, body: 'first', base: null });

		const mine = data.editRamble({ id, body: 'mine', base: storedRevision(data, id) });
		expect(mine).toEqual({ kind: 'saved', revision: storedRevision(data, id) });
		data.editRamble({ id, body: 'theirs', base: storedRevision(data, id) });

		expect(data.editRamble({ id, body: 'mine again', base: answeredRevision(mine) })).toEqual({
			kind: 'conflict'
		});
		expect(data.ramble(id)?.ramble.body).toBe('theirs');
	});

	it('so a thought write from elsewhere between two edits makes the second one a conflict', () => {
		const thought = publishedThought();
		const current = () => data.thought(thought.id)?.revision ?? thought.revision;

		const mine = data.editThought({ id: thought.id, base: current(), edit: { body: 'mine' } });
		expect(mine).toEqual({ kind: 'saved', revision: current() });
		data.editThought({ id: thought.id, base: current(), edit: { body: 'theirs' } });

		expect(
			data.editThought({ id: thought.id, base: answeredRevision(mine), edit: { body: 'again' } })
		).toEqual({ kind: 'conflict' });
		expect(data.thought(thought.id)?.body).toBe('theirs');
	});
});

describe('a save whose reply was lost', () => {
	it('is accepted again when resent unchanged, with the same id and no new ramble', () => {
		const id = newRambleId();
		data.saveDraft({ id, body: 'first', base: null });

		expect(data.saveDraft({ id, body: 'first', base: null })).toEqual({ id, revision: 1 });
		expect(rambleCount()).toEqual([{ n: 1 }]);
	});

	it('is followed by more typing in the same ramble, not a replacement', () => {
		const id = newRambleId();
		data.saveDraft({ id, body: 'first', base: null });

		expect(data.saveDraft({ id, body: 'first and more', base: null })).toEqual({
			id,
			revision: 2
		});
		expect(data.ramble(id)?.ramble.body).toBe('first and more');
		expect(rambleCount()).toEqual([{ n: 1 }]);
	});

	it('still sends a stale body that does not extend the stored text to a replacement', () => {
		const id = newRambleId();
		data.saveDraft({ id, body: 'first', base: null });
		data.saveDraft({ id, body: 'first, tab A', base: storedRevision(data, id) });

		for (const body of ['first, tab B', 'fir', 'other']) {
			const late = data.saveDraft({ id, body, base: null });
			expect(late.id, body).not.toBe(id);
			expect(data.ramble(late.id)?.ramble.body).toBe(body);
		}

		expect(data.ramble(id)?.ramble.body).toBe('first, tab A');
	});
});

// Two tabs type into one ramble. Any save's reply may be lost, so that tab
// keeps its old id and revision; a tab may also end its ramble.
type TabOp =
	| { kind: 'type'; tab: 0 | 1; word: string; replyLost: boolean }
	| { kind: 'end'; tab: 0 | 1 };

const tabOp: fc.Arbitrary<TabOp> = fc.oneof(
	fc.record({
		kind: fc.constant('type' as const),
		tab: fc.constantFrom(0 as const, 1 as const),
		word: fc.constantFrom('alpha ', 'beta', ' ', 'gamma.'),
		replyLost: fc.boolean()
	}),
	fc.record({ kind: fc.constant('end' as const), tab: fc.constantFrom(0 as const, 1 as const) })
);

describe('two tabs with lost replies', () => {
	it('never lose text the server stored, and keep every tab’s latest text whole', () => {
		fc.assert(
			fc.property(fc.array(tabOp, { maxLength: 25 }), (ops) => {
				const { data: d, sql } = open();
				const start = newRambleId();

				const tabs: { id: RambleId; revision: Revision | null; text: string }[] = [
					{ id: start, revision: null, text: '' },
					{ id: start, revision: null, text: '' }
				];

				const stored: { id: RambleId; body: string }[] = [];

				for (const op of ops) {
					const t = tabs[op.tab];

					if (op.kind === 'end') {
						d.endRamble(t.id);
						continue;
					}

					t.text += op.word;
					const saved = d.saveDraft({ id: t.id, body: t.text, base: t.revision });

					if (saved.revision !== null) stored.push({ id: saved.id, body: t.text });

					if (!op.replyLost) {
						t.id = saved.id;
						t.revision = saved.revision;
					}
				}

				for (const { id, body } of stored.filter((s) => s.body.trim() !== '')) {
					expect(d.ramble(id)?.ramble.body.startsWith(body), `${id}: ${body}`).toBe(true);
				}

				const bodies = d.home().pending.map((p) => p.body);

				const draftBodies = sql
					.query("SELECT body FROM rambles WHERE status = 'open'")
					.map((row) => String(row.body));

				for (const { text } of tabs.filter((t) => t.text.trim() !== '')) {
					expect([...bodies, ...draftBodies].some((body) => body.startsWith(text))).toBe(true);
				}

				sql.close();
			}),
			{ numRuns: 300 }
		);
	});
});

// A small pool of ids, so saves, ends, edits, and splits keep hitting the
// same rambles, from any revision a tab might still hold.
type IdOp =
	| { kind: 'save'; slot: number; body: string; base: number | null }
	| { kind: 'end'; slot: number }
	| { kind: 'edit'; slot: number; body: string }
	| { kind: 'split'; slot: number }
	| { kind: 'wait' };

const slot = fc.integer({ min: 0, max: 2 });

const text = fc.constantFrom('', ' ', 'words', 'more words');

const idOp: fc.Arbitrary<IdOp> = fc.oneof(
	fc.record({
		kind: fc.constant('save' as const),
		slot,
		body: text,
		base: fc.option(fc.integer({ min: 1, max: 4 }))
	}),
	fc.record({ kind: fc.constant('end' as const), slot }),
	fc.record({ kind: fc.constant('edit' as const), slot, body: text }),
	fc.record({ kind: fc.constant('split' as const), slot }),
	fc.record({ kind: fc.constant('wait' as const) })
);

describe('a discarded ramble id', () => {
	it('is never used again, whatever order saves, ends, edits, and splits come in', () => {
		fc.assert(
			fc.property(fc.array(idOp, { maxLength: 30 }), (ops) => {
				const { data: d, sql, advance } = open();
				const ids = [newRambleId(), newRambleId(), newRambleId()];
				const seen = new Set<RambleId>();
				const discarded = new Set<RambleId>();

				for (const op of ops) {
					if (op.kind === 'wait') {
						advance(IDLE_GAP_MS + 1);
						d.settleOnLoad();
					} else {
						const id = ids[op.slot];
						const current = d.ramble(id)?.ramble;

						if (op.kind === 'save') {
							const base = op.base === null ? null : parseRevision(op.base);
							const saved = d.saveDraft({ id, body: op.body, base });

							if (discarded.has(id)) expect(saved.id).not.toBe(id);
						}

						if (op.kind === 'end') d.endRamble(id);

						if (op.kind === 'edit' && current) {
							d.editRamble({ id, body: op.body, base: current.revision });
						}

						if (op.kind === 'split' && current) {
							d.finishSplit({ id, revision: current.revision, proposals: [] });
						}
					}

					for (const id of ids) {
						const exists = d.ramble(id) !== null;

						if (exists) expect(discarded.has(id), `${id} came back`).toBe(false);

						if (exists) seen.add(id);
						else if (seen.has(id)) discarded.add(id);
					}
				}

				sql.close();
			}),
			{ numRuns: 300 }
		);
	});
});
