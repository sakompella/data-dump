import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newRambleId, newThoughtId } from '$lib/ids';
import { IDLE_GAP_MS } from '$lib/idle';
import type { ProposedThought } from './copies';
import { createRambleService } from './rambles';
import type { Splitter } from './splitter';
import { createStore, type Store } from './store';

const BODY = 'Rev keeps stalling. maybe email Michael about Friday';
const PROPOSALS: ProposedThought[] = [
	{ label: 'Rev', text: 'Rev keeps stalling.', todo: false },
	{ label: 'Michael', text: 'maybe email Michael about Friday', todo: true }
];

let dataDir: string;
let store: Store;
let splitCalls: number;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'data-dump-test-'));
	store = createStore(dataDir);
	await store.init();
	splitCalls = 0;
});

afterEach(() => rm(dataDir, { recursive: true, force: true }));

const countingSplitter =
	(proposals: ProposedThought[]): Splitter =>
	async () => {
		splitCalls += 1;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return proposals;
	};

describe('saveDraft', () => {
	it('creates a ramble on the first non-empty save only', async () => {
		const service = createRambleService({ store, split: countingSplitter([]) });
		const id = newRambleId();
		expect(await service.saveDraft({ id, body: '' })).toBe(id);
		expect(await store.readRamble(id)).toBeNull();
		await service.saveDraft({ id, body: 'hello' });
		expect((await store.readRamble(id))?.body).toBe('hello');
	});

	it('puts text for a ramble that is no longer open into a new ramble', async () => {
		const service = createRambleService({ store, split: countingSplitter(PROPOSALS) });
		const id = newRambleId();
		await service.saveDraft({ id, body: BODY });
		await service.endRamble(id);

		const lateText = `${BODY} and one more line`;
		const newId = await service.saveDraft({ id, body: lateText });

		expect(newId).not.toBe(id);
		expect(await store.readRamble(newId)).toMatchObject({ status: 'open', body: lateText });
		expect(await store.readRamble(id)).toMatchObject({ status: 'split', body: BODY });
	});
});

describe('endRamble', () => {
	it('splits once when ended twice or concurrently', async () => {
		const service = createRambleService({ store, split: countingSplitter(PROPOSALS) });
		const id = newRambleId();
		await service.saveDraft({ id, body: BODY });

		await Promise.all([service.endRamble(id), service.endRamble(id), service.endRamble(id)]);
		await service.endRamble(id);

		const thoughts = await store.listThoughts();
		expect(splitCalls).toBe(1);
		expect(thoughts.map((t) => t.body).sort()).toEqual(PROPOSALS.map((p) => p.text).sort());
		expect((await store.readRamble(id))?.status).toBe('split');
	});

	it('falls back to the whole ramble when nothing usable comes back', async () => {
		const service = createRambleService({
			store,
			split: countingSplitter([{ label: 'x', text: 'a paraphrase', todo: true }])
		});
		const id = newRambleId();
		await service.saveDraft({ id, body: BODY });
		await service.endRamble(id);

		const thoughts = await store.listThoughts();
		expect(thoughts).toHaveLength(1);
		expect(thoughts[0]).toMatchObject({
			body: BODY,
			todo: 'none',
			label: 'Rev keeps stalling. maybe email'
		});
	});

	it('leaves the ramble ended when the model call fails, and retries later', async () => {
		let fail = true;
		const service = createRambleService({
			store,
			split: async (body) => {
				if (fail) throw new Error('503');
				return countingSplitter(PROPOSALS)(body);
			}
		});
		const id = newRambleId();
		await service.saveDraft({ id, body: BODY });
		await service.endRamble(id);
		expect((await store.readRamble(id))?.status).toBe('ended');
		expect((await service.home()).waiting).toBe(1);

		fail = false;
		await service.endRamble(id);
		expect((await store.readRamble(id))?.status).toBe('split');
		expect(await store.listThoughts()).toHaveLength(2);
	});

	it('deletes an empty ramble instead of splitting it', async () => {
		const service = createRambleService({ store, split: countingSplitter(PROPOSALS) });
		const id = newRambleId();
		await service.saveDraft({ id, body: 'x' });
		await service.saveDraft({ id, body: '  ' });
		await service.endRamble(id);
		expect(await store.readRamble(id)).toBeNull();
		expect(splitCalls).toBe(0);
	});

	it('replaces leftovers of a crashed split with exactly one clean set', async () => {
		const service = createRambleService({ store, split: countingSplitter(PROPOSALS) });
		const id = newRambleId();
		await service.saveDraft({ id, body: BODY });
		const ramble = await store.readRamble(id);
		if (!ramble) throw new Error('draft was not saved');
		await store.writeRamble({ ...ramble, status: 'ended' });
		await store.writeThought({
			id: newThoughtId(),
			rambleId: id,
			label: 'Rev',
			todo: 'none',
			createdAt: new Date(),
			body: 'Rev keeps stalling.'
		});
		expect((await service.home()).thoughts).toEqual([]);

		await service.endRamble(id);

		const bodies = (await service.home()).thoughts.map((t) => t.body).sort();
		expect(bodies).toEqual(PROPOSALS.map((p) => p.text).sort());
		expect(await readdir(join(dataDir, 'thoughts'))).toHaveLength(2);
	});

	it('copies from the body as it was when the split started', async () => {
		let editDuringSplit: () => Promise<unknown> = async () => undefined;
		const service = createRambleService({
			store,
			split: async (body) => {
				await editDuringSplit();
				return countingSplitter(PROPOSALS)(body);
			}
		});
		const id = newRambleId();
		await service.saveDraft({ id, body: BODY });
		const edited = 'Rewritten after ending.';
		editDuringSplit = () => service.editRamble({ id, body: edited });

		await service.endRamble(id);

		expect(await store.readRamble(id)).toMatchObject({ status: 'split', body: edited });
		const bodies = (await store.listThoughts()).map((t) => t.body).sort();
		expect(bodies).toEqual(PROPOSALS.map((p) => p.text).sort());
	});
});

describe('settleOnLoad', () => {
	it('ends open rambles past the idle gap and keeps fresh ones open', async () => {
		let clock = new Date('2026-01-01T00:00:00Z');
		const service = createRambleService({
			store,
			split: countingSplitter(PROPOSALS),
			now: () => clock
		});
		const stale = newRambleId();
		await service.saveDraft({ id: stale, body: BODY });
		clock = new Date(clock.getTime() + IDLE_GAP_MS + 1);
		const fresh = newRambleId();
		await service.saveDraft({ id: fresh, body: 'still going' });

		await service.settleOnLoad();

		expect((await service.home()).draft?.id).toBe(fresh);
		await service.endRamble(stale);
		expect((await store.readRamble(stale))?.status).toBe('split');
		expect(splitCalls).toBe(1);
	});
});
