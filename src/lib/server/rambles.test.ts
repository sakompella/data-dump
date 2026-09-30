import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { newRambleId, type RambleId, type Revision } from '$lib/ids';
import { IDLE_GAP_MS } from '$lib/idle';
import type { ProposedThought } from '$lib/proposals';
import { createFakeBucket, createTestClock, type TestClock } from '$lib/testing/fake-bucket';
import { parseUserId, type UserId } from './access';
import { createRambleService, type RambleService } from './rambles';
import { createStore, WriteRateLimited, type DocumentBucket, type Store } from './store';

const BODY = 'Rev keeps stalling. maybe email Michael about Friday';

const PROPOSALS: ProposedThought[] = [
	{ label: 'Rev', text: 'Rev keeps stalling.', todo: false },
	{ label: 'Michael', text: 'maybe email Michael about Friday', todo: true }
];

function userId(raw: string): UserId {
	const id = parseUserId(raw);

	if (!id) throw new Error(`bad test user id ${raw}`);

	return id;
}

function setUp({ bucket, clock }: { bucket: DocumentBucket; clock: TestClock }) {
	const store = createStore({ bucket, userId: userId('user-1') });
	const service = createRambleService({ store, now: clock.now, sleep: clock.sleep });

	return { store, service };
}

let clock: TestClock;

let fake: ReturnType<typeof createFakeBucket>;

let store: Store;

let service: RambleService;

beforeEach(() => {
	clock = createTestClock();
	fake = createFakeBucket({ clock });
	({ store, service } = setUp({ bucket: fake.bucket, clock }));
});

// Autosaves to one ramble are at least this far apart, as in the capture box.
const pause = () => clock.advance(1500);

async function savedRamble(body = BODY) {
	const id = newRambleId();
	const saved = await service.saveDraft({ id, body, base: null });
	pause();

	return { id, revision: saved.revision };
}

async function splitRamble(proposals = PROPOSALS) {
	const { id } = await savedRamble();
	await service.endRamble(id);
	const result = await service.finishSplit({ id, attempt: 'a', proposals });

	return { id, result };
}

describe('saveDraft', () => {
	it('creates a ramble on the first non-empty save only', async () => {
		const id = newRambleId();
		expect(await service.saveDraft({ id, body: '', base: null })).toEqual({ id, revision: null });
		expect(await store.readRamble(id)).toBeNull();
		const saved = await service.saveDraft({ id, body: 'hello', base: null });
		expect(saved.id).toBe(id);
		expect(await store.readRamble(id)).toMatchObject({ body: 'hello', revision: saved.revision });
	});

	it('keys documents by user', async () => {
		const { id } = await savedRamble();
		expect([...fake.objects.keys()]).toEqual([`users/user-1/rambles/${id}.md`]);
		const other = createStore({ bucket: fake.bucket, userId: userId('user-2') });
		expect(await other.readRamble(id)).toBeNull();
	});

	it('puts a save from a stale revision into a new ramble instead of overwriting', async () => {
		const { id, revision } = await savedRamble('first');
		const tabA = await service.saveDraft({ id, body: 'first, then tab A', base: revision });
		pause();
		const tabB = await service.saveDraft({ id, body: 'first, then tab B', base: revision });

		expect(tabA.id).toBe(id);
		expect(tabB.id).not.toBe(id);
		expect(await store.readRamble(id)).toMatchObject({ body: 'first, then tab A' });
		expect(await store.readRamble(tabB.id)).toMatchObject({
			status: 'open',
			body: 'first, then tab B',
			revision: tabB.revision
		});
	});

	it('treats a resend of the stored text as saved', async () => {
		const { id, revision } = await savedRamble();
		expect(await service.saveDraft({ id, body: BODY, base: null })).toEqual({ id, revision });
	});

	it('puts text for a ramble that is no longer open into a new ramble', async () => {
		const { id, revision } = await savedRamble();
		await service.endRamble(id);
		const late = await service.saveDraft({ id, body: `${BODY} and more`, base: revision });

		expect(late.id).not.toBe(id);
		expect(await store.readRamble(late.id)).toMatchObject({ body: `${BODY} and more` });
		expect(await store.readRamble(id)).toMatchObject({ status: 'ended', body: BODY });
	});

	it('reports a write within a second of the last one as rate limited', async () => {
		const id = newRambleId();
		const first = await service.saveDraft({ id, body: 'a', base: null });

		await expect(service.saveDraft({ id, body: 'ab', base: first.revision })).rejects.toThrow(
			WriteRateLimited
		);

		expect(await store.readRamble(id)).toMatchObject({ body: 'a' });
		pause();
		expect((await service.saveDraft({ id, body: 'ab', base: first.revision })).id).toBe(id);
	});
});

describe('endRamble', () => {
	it('ends right after an autosave by waiting out the rate limit', async () => {
		const id = newRambleId();
		await service.saveDraft({ id, body: BODY, base: null });
		expect(await service.endRamble(id)).toEqual({ id, body: BODY });
		expect(await store.readRamble(id)).toMatchObject({ status: 'ended' });
	});

	it('discards an empty ramble instead of deleting it', async () => {
		const { id, revision } = await savedRamble('x');
		const blank = await service.saveDraft({ id, body: '  ', base: revision });
		pause();

		expect(await service.endRamble(id)).toBeNull();
		expect(await store.readRamble(id)).toMatchObject({ status: 'discarded', body: '  ' });
		expect(await service.ramble(id)).toBeNull();

		const late = await service.saveDraft({ id, body: 'typed late', base: blank.revision });
		expect(late.id).not.toBe(id);
		expect(await store.readRamble(late.id)).toMatchObject({ body: 'typed late' });
	});

	it('returns the text of an already ended ramble so its split can be retried', async () => {
		const { id } = await savedRamble();
		await service.endRamble(id);
		expect(await service.endRamble(id)).toEqual({ id, body: BODY });
	});
});

describe('finishSplit', () => {
	it('publishes the exact copies, once', async () => {
		const { id, result } = await splitRamble();
		expect(result.kind).toBe('published');
		const again = await service.finishSplit({ id, attempt: 'b', proposals: [] });
		expect(again).toEqual(result);

		const { thoughts } = await service.home();
		expect(thoughts.map((t) => t.body).sort()).toEqual(PROPOSALS.map((p) => p.text).sort());
		expect(thoughts.map((t) => t.todo).sort()).toEqual(['none', 'open']);
	});

	it('keeps the whole ramble when nothing proposed is the user’s own words', async () => {
		await splitRamble([{ label: 'x', text: 'a paraphrase', todo: true }]);
		const { thoughts } = await service.home();
		expect(thoughts).toHaveLength(1);
		expect(thoughts[0]).toMatchObject({
			body: BODY,
			todo: 'none',
			label: 'Rev keeps stalling. maybe email'
		});
	});

	it('does nothing for a ramble that has not ended', async () => {
		const { id } = await savedRamble();
		expect(await service.finishSplit({ id, attempt: 'a', proposals: PROPOSALS })).toEqual({
			kind: 'not-ended',
			status: 'open'
		});
		expect(fake.objects.size).toBe(1);
	});

	it('publishes exactly one set when two runs finish together, in either order', async () => {
		await fc.assert(
			fc.asyncProperty(fc.scheduler(), async (s) => {
				const race = createTestClock();
				const bucket = createFakeBucket({ clock: race, io: () => s.schedule(Promise.resolve()) });
				const raced = setUp({ bucket: bucket.bucket, clock: race });
				const id = newRambleId();

				const setup = (async () => {
					await raced.service.saveDraft({ id, body: BODY, base: null });
					race.advance(1500);
					await raced.service.endRamble(id);
				})();

				await s.waitFor(setup);

				const runs = Promise.all([
					raced.service.finishSplit({ id, attempt: 'same', proposals: PROPOSALS }),
					raced.service.finishSplit({ id, attempt: 'same', proposals: PROPOSALS.slice(0, 1) })
				]);

				const [first, second] = await s.waitFor(runs);
				expect(first).toEqual(second);
				const ramble = await s.waitFor(raced.store.readRamble(id));

				if (ramble?.status !== 'split') throw new Error('ramble was not split');
				const all = await s.waitFor(raced.store.listThoughts());
				const shown = (await s.waitFor(raced.service.home())).thoughts;
				expect(shown.every((t) => t.publication === ramble.publication)).toBe(true);

				expect(shown.map((t) => t.id).sort()).toEqual(
					all
						.filter((t) => t.publication === ramble.publication)
						.map((t) => t.id)
						.sort()
				);

				expect([1, 2]).toContain(shown.length);

				for (const orphan of all.filter((t) => t.publication !== ramble.publication)) {
					expect(await s.waitFor(raced.service.thought(orphan.id))).toBeNull();
				}
			}),
			{ numRuns: 50 }
		);
	});

	it('copies from the new body when the ramble is edited while thoughts are written', async () => {
		const { id } = await savedRamble();
		await service.endRamble(id);
		const edited = 'Rev keeps stalling. Nothing else.';
		const put = fake.bucket.put;
		let editedOnce = false;

		fake.bucket.put = async (key, value, options) => {
			if (!editedOnce && key.includes('/thoughts/')) {
				editedOnce = true;
				clock.advance(1500);
				const ramble = await store.readRamble(id);

				if (!ramble) throw new Error('ramble missing');
				expect(await service.editRamble({ id, body: edited, base: ramble.revision })).toBe('saved');
			}

			return put(key, value, options);
		};

		const result = await service.finishSplit({ id, attempt: 'a', proposals: PROPOSALS });
		expect(result.kind).toBe('published');
		expect(await store.readRamble(id)).toMatchObject({ status: 'split', body: edited });
		expect((await service.home()).thoughts.map((t) => t.body)).toEqual(['Rev keeps stalling.']);
		expect((await store.listThoughts()).length).toBeGreaterThan(1);
	});
});

describe('edits', () => {
	async function publishedThought() {
		await splitRamble();
		const [thought] = (await service.home()).thoughts;
		pause();

		return thought;
	}

	it('refuses a ramble edit based on an old revision', async () => {
		const { id, revision } = await savedRamble();
		const newer = await service.saveDraft({ id, body: `${BODY}!`, base: revision });
		pause();
		expect(newer.id).toBe(id);

		if (!revision) throw new Error('first save made no revision');
		expect(await service.editRamble({ id, body: 'stale', base: revision })).toBe('conflict');
		expect(await store.readRamble(id)).toMatchObject({ body: `${BODY}!` });
	});

	it('keeps a split ramble split when its body is edited', async () => {
		const { id } = await splitRamble();
		const before = await store.readRamble(id);

		if (!before || before.status !== 'split') throw new Error('not split');
		pause();
		expect(await service.editRamble({ id, body: 'edited', base: before.revision })).toBe('saved');
		expect(await store.readRamble(id)).toMatchObject({
			status: 'split',
			publication: before.publication,
			body: 'edited'
		});
		expect((await service.home()).thoughts).toHaveLength(2);
	});

	it('refuses a thought edit based on an old revision', async () => {
		const thought = await publishedThought();
		const base = thought.revision;
		expect(await service.editThought({ id: thought.id, base, edit: { todo: 'done' } })).toBe(
			'saved'
		);
		pause();
		expect(await service.editThought({ id: thought.id, base, edit: { label: 'x' } })).toBe(
			'conflict'
		);
		expect(await service.thought(thought.id)).toMatchObject({ todo: 'done', label: thought.label });
	});

	it('deletes a thought as a tombstone that a stale edit cannot bring back', async () => {
		const thought = await publishedThought();
		expect(await service.deleteThought({ id: thought.id, base: thought.revision })).toBe('saved');
		pause();
		expect(await service.thought(thought.id)).toBeNull();
		expect((await service.home()).thoughts.map((t) => t.id)).not.toContain(thought.id);

		const stale = { id: thought.id, base: thought.revision, edit: { label: 'back?' } };
		expect(await service.editThought(stale)).toBe('missing');
		expect(await store.readThought(thought.id)).toMatchObject({ deleted: true });
	});
});

describe('home', () => {
	it('ends open rambles past the idle gap and lists ended ones for a split', async () => {
		const stale = await savedRamble();
		clock.advance(IDLE_GAP_MS + 1);
		const fresh = await savedRamble('still going');
		const { draft, pending } = await service.home();

		expect(draft?.id).toBe(fresh.id);
		expect(pending).toEqual([{ id: stale.id, body: BODY }]);
		expect(await store.readRamble(stale.id)).toMatchObject({ status: 'ended' });
	});

	it('reads every page of a long listing', async () => {
		const paged = createFakeBucket({ clock, pageSize: 2 });
		const small = setUp({ bucket: paged.bucket, clock });

		for (let i = 0; i < 5; i += 1) {
			await small.service.saveDraft({ id: newRambleId(), body: `ramble ${i}`, base: null });
		}

		expect(await small.store.listRambles()).toHaveLength(5);
	});
});

type Op =
	| { kind: 'save'; tab: 0 | 1; word: string }
	| { kind: 'end' }
	| { kind: 'finish'; proposals: ProposedThought[] };

const op: fc.Arbitrary<Op> = fc.oneof(
	fc.record({
		kind: fc.constant('save' as const),
		tab: fc.constantFrom(0 as const, 1 as const),
		word: fc.constantFrom('alpha', 'beta.', 'gamma', 'delta!')
	}),
	fc.record({ kind: fc.constant('end' as const) }),
	fc.record({
		kind: fc.constant('finish' as const),
		proposals: fc.array(
			fc.record({
				label: fc.constant('l'),
				text: fc.constantFrom('alpha', 'beta.', 'gamma delta!', 'nope'),
				todo: fc.boolean()
			}),
			{ maxLength: 3 }
		)
	})
);

describe('concurrent saves, ends, and splits', () => {
	it('never lose acknowledged text and publish one run per ramble', async () => {
		await fc.assert(
			fc.asyncProperty(fc.scheduler(), fc.array(op, { maxLength: 12 }), async (s, ops) => {
				const race = createTestClock();
				const bucket = createFakeBucket({ clock: race, io: () => s.schedule(Promise.resolve()) });

				const { store: raceStore, service: raceService } = setUp({
					bucket: bucket.bucket,
					clock: race
				});

				// Both tabs start on the same ramble, as after restoring one backup twice.
				const start = newRambleId();

				const tabs: { id: RambleId; revision: Revision | null; text: string }[] = [
					{ id: start, revision: null, text: '' },
					{ id: start, revision: null, text: '' }
				];

				const latestAck = new Map<RambleId, { order: number; body: string }>();

				async function save(tab: (typeof tabs)[number]) {
					try {
						const saved = await raceService.saveDraft({
							id: tab.id,
							body: tab.text,
							base: tab.revision
						});

						tab.id = saved.id;
						tab.revision = saved.revision;
						// The fake numbers etags in write order, so the highest is the latest write.
						const order = Number(saved.revision?.replace('etag-', '') ?? 0);

						if (order > (latestAck.get(saved.id)?.order ?? 0)) {
							latestAck.set(saved.id, { order, body: tab.text });
						}

						return true;
					} catch (error) {
						if (!(error instanceof WriteRateLimited)) throw error;

						return false;
					}
				}

				const tabOps = (index: 0 | 1) => ops.filter((o) => o.kind === 'save' && o.tab === index);
				const serverOps = ops.filter((o) => o.kind !== 'save');

				const runTab = async (index: 0 | 1) => {
					for (const o of tabOps(index)) {
						if (o.kind !== 'save') continue;
						tabs[index].text += ` ${o.word}`;
						race.advance(500);
						await save(tabs[index]);
					}
				};

				const runServer = async () => {
					for (const o of serverOps) {
						race.advance(500);

						if (o.kind === 'end') await raceService.endRamble(tabs[0].id);

						if (o.kind === 'finish') {
							await raceService.finishSplit({
								id: tabs[0].id,
								attempt: 'x',
								proposals: o.proposals
							});
						}
					}
				};

				await s.waitFor(Promise.all([runTab(0), runTab(1), runServer()]));

				for (const tab of tabs) {
					race.advance(1500);
					expect(await s.waitFor(save(tab))).toBe(true);
				}

				for (const tab of tabs.filter(({ text }) => text !== '')) {
					const stored = await s.waitFor(raceStore.readRamble(tab.id));
					expect(stored?.body).toBe(tab.text);
				}

				for (const [id, ack] of latestAck) {
					const stored = await s.waitFor(raceStore.readRamble(id));
					expect(stored?.body).toBe(ack.body);
				}

				const rambles = await s.waitFor(raceStore.listRambles());
				const thoughts = await s.waitFor(raceStore.listThoughts());
				const shown = (await s.waitFor(raceService.home())).thoughts;

				for (const ramble of rambles) {
					const mine = shown.filter((t) => t.rambleId === ramble.id);

					if (ramble.status !== 'split') {
						expect(mine).toEqual([]);
						continue;
					}

					const run = thoughts.filter(
						(t) => t.rambleId === ramble.id && t.publication === ramble.publication
					);

					expect(mine.map((t) => t.id).sort()).toEqual(run.map((t) => t.id).sort());
					expect(mine.length).toBeGreaterThan(0);

					for (const thought of mine) expect(ramble.body).toContain(thought.body);
				}
			}),
			{ numRuns: 200 }
		);
	});
});
