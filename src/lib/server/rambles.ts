import { newPublicationId, newRambleId, newThoughtId, type Revision } from '$lib/ids';
import { isIdle } from '$lib/idle';
import type { ProposedThought } from '$lib/proposals';
import {
	advance,
	isPublished,
	type PublicationId,
	type Ramble,
	type RambleId,
	type RambleStatus,
	type Thought,
	type ThoughtId
} from '$lib/domain';
import { copiesFromProposals, wholeRambleCopy } from './copies';
import { WriteRateLimited, type Store, type Stored } from './store';

export type RambleService = ReturnType<typeof createRambleService>;

export interface ThoughtEdit {
	readonly label: string;
	readonly body: string;
	readonly todo: Thought['todo'];
}

// A write based on what the caller last read: `conflict` means the document
// changed since then and nothing was written.
export type EditResult = 'saved' | 'conflict' | 'missing';

export type FinishResult =
	| { kind: 'published'; publication: PublicationId }
	| { kind: 'not-ended'; status: RambleStatus }
	| { kind: 'missing' }
	| { kind: 'conflict' };

export interface PendingSplit {
	readonly id: RambleId;
	readonly body: string;
}

const newestFirst = (a: Thought, b: Thought) =>
	b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id);

// Waits between tries when R2 refuses a write for coming within a second of the last one.
const RATE_LIMIT_BACKOFF_MS = [250, 500, 1000, 2000];

// How often a status change is retried after another write got there first.
const CONFLICT_RETRIES = 3;

export function createRambleService({
	store,
	now = () => new Date(),
	sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
}: {
	store: Store;
	now?: () => Date;
	sleep?: (ms: number) => Promise<void>;
}) {
	async function retryRateLimited<T>(write: () => Promise<T>): Promise<T> {
		for (const delay of RATE_LIMIT_BACKOFF_MS) {
			try {
				return await write();
			} catch (error) {
				if (!(error instanceof WriteRateLimited)) throw error;
				await sleep(delay);
			}
		}

		return write();
	}

	const openRamble = (id: RambleId, body: string): Ramble => {
		const at = now();

		return { id, status: 'open', createdAt: at, updatedAt: at, body };
	};

	// Text that cannot go into the ramble it was meant for goes into a new one.
	async function saveAsReplacement(body: string) {
		const id = newRambleId();

		if (body === '') return { id, revision: null };
		const created = await store.createRamble(openRamble(id, body));

		if (!created) throw new Error(`ramble ${id} already exists`);

		return { id, revision: created.revision };
	}

	const endedState = (ramble: Ramble) =>
		advance(ramble, { status: ramble.body.trim() === '' ? 'discarded' : 'ended' });

	// Ends the latest version of an open ramble; empty ones are discarded.
	async function end(id: RambleId): Promise<Stored<Ramble> | null> {
		for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt += 1) {
			const current = await store.readRamble(id);

			if (!current || current.status !== 'open') return current;

			const ended = await retryRateLimited(() =>
				store.replaceRamble(endedState(current), current.revision)
			);

			if (ended) return ended;
		}

		throw new Error(`ramble ${id} kept changing while being ended`);
	}

	// Stale open rambles are ended on page load. If one changed since it was
	// listed, it was just written to, so it is left as it now is.
	async function endIfIdle(ramble: Stored<Ramble>): Promise<Stored<Ramble>> {
		if (ramble.status !== 'open' || !isIdle(ramble.updatedAt, now())) return ramble;

		const ended = await retryRateLimited(() =>
			store.replaceRamble(endedState(ramble), ramble.revision)
		);

		return ended ?? (await store.readRamble(ramble.id)) ?? ramble;
	}

	async function publishedThought(id: ThoughtId): Promise<Stored<Thought> | null> {
		const thought = await store.readThought(id);

		if (!thought || thought.deleted) return null;
		const ramble = await store.readRamble(thought.rambleId);

		return ramble && isPublished(thought, ramble) ? thought : null;
	}

	async function replacePublishedThought(
		id: ThoughtId,
		base: Revision,
		change: (thought: Thought) => Thought
	): Promise<EditResult> {
		const thought = await publishedThought(id);

		if (!thought) return 'missing';

		if (thought.revision !== base) return 'conflict';
		const saved = await retryRateLimited(() => store.replaceThought(change(thought), base));

		return saved ? 'saved' : 'conflict';
	}

	return {
		// Upsert against the revision the caller last saw. A stale save is
		// never merged or dropped: its text goes into a new ramble whose id
		// is returned. Rejects with WriteRateLimited when R2 needs a pause.
		async saveDraft({
			id,
			body,
			base
		}: {
			id: RambleId;
			body: string;
			base: Revision | null;
		}): Promise<{ id: RambleId; revision: Revision | null }> {
			const existing = await store.readRamble(id);

			if (!existing) {
				if (body === '') return { id, revision: null };
				const created = await store.createRamble(openRamble(id, body));

				return created ? { id, revision: created.revision } : saveAsReplacement(body);
			}

			if (existing.status === 'open') {
				if (existing.body === body) return { id, revision: existing.revision };

				if (existing.revision === base) {
					const saved = await store.replaceRamble({ ...existing, body, updatedAt: now() }, base);

					if (saved) return { id, revision: saved.revision };
				}
			}

			return saveAsReplacement(body);
		},

		// Returns the ramble's text when it is waiting for a split.
		async endRamble(id: RambleId): Promise<PendingSplit | null> {
			const ended = await end(id);

			return ended?.status === 'ended' ? { id, body: ended.body } : null;
		},

		// Copies the proposals out of the stored body and publishes them, once.
		// Each run writes its thoughts under a fresh publication id, then
		// commits that id onto the ramble only if the ramble is unchanged
		// since it was read. Thoughts of a run that lost are never shown.
		async finishSplit({
			id,
			attempt,
			proposals
		}: {
			id: RambleId;
			attempt: string;
			proposals: readonly ProposedThought[];
		}): Promise<FinishResult> {
			for (let run = 0; run < CONFLICT_RETRIES; run += 1) {
				const current = await store.readRamble(id);

				if (!current) return { kind: 'missing' };

				if (current.status === 'split') {
					return { kind: 'published', publication: current.publication };
				}

				if (current.status !== 'ended') return { kind: 'not-ended', status: current.status };
				const publication = newPublicationId();
				const kept = copiesFromProposals(current.body, proposals);

				console.info(
					`split ${id} (attempt ${attempt}): kept ${kept.length} of ${proposals.length} proposed thoughts` +
						(kept.length === 0 ? '; keeping the whole ramble' : '')
				);

				const copies = kept.length > 0 ? kept : [wholeRambleCopy(current.body)];
				const createdAt = now();

				await Promise.all(
					copies.map(async (copy) => {
						const thought = {
							id: newThoughtId(),
							rambleId: id,
							publication,
							createdAt,
							deleted: false,
							...copy
						};

						if (!(await retryRateLimited(() => store.createThought(thought)))) {
							throw new Error(`thought ${thought.id} already exists`);
						}
					})
				);

				const committed = await retryRateLimited(() =>
					store.replaceRamble(advance(current, { status: 'split', publication }), current.revision)
				);

				if (committed) return { kind: 'published', publication };
				console.info(
					`split ${id} (attempt ${attempt}): ramble changed meanwhile; reading it again`
				);
			}

			return { kind: 'conflict' };
		},

		// Ends idle open rambles, then lists what the home page shows.
		async home(): Promise<{
			draft: Stored<Ramble> | null;
			thoughts: Stored<Thought>[];
			pending: PendingSplit[];
		}> {
			const [listed, thoughts] = await Promise.all([store.listRambles(), store.listThoughts()]);
			const rambles = await Promise.all(listed.map(endIfIdle));
			const byId = new Map(rambles.map((ramble) => [ramble.id, ramble]));

			const draft =
				rambles
					.filter((r) => r.status === 'open')
					.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;

			const pending = rambles
				.filter((r) => r.status === 'ended')
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(({ id, body }) => ({ id, body }));

			const published = thoughts
				.filter((thought) => {
					const ramble = byId.get(thought.rambleId);

					return ramble !== undefined && isPublished(thought, ramble);
				})
				.sort(newestFirst);

			return { draft, thoughts: published, pending };
		},

		async ramble(
			id: RambleId
		): Promise<{ ramble: Stored<Ramble>; thoughts: Stored<Thought>[] } | null> {
			const ramble = await store.readRamble(id);

			if (!ramble || ramble.status === 'discarded') return null;

			const thoughts =
				ramble.status === 'split'
					? (await store.listThoughts()).filter((t) => isPublished(t, ramble)).sort(newestFirst)
					: [];

			return { ramble, thoughts };
		},

		// Changes only the ramble body; its status and thoughts stay as they are.
		async editRamble({
			id,
			body,
			base
		}: {
			id: RambleId;
			body: string;
			base: Revision;
		}): Promise<EditResult> {
			const ramble = await store.readRamble(id);

			if (!ramble || ramble.status === 'discarded') return 'missing';

			if (ramble.revision !== base) return 'conflict';

			const saved = await retryRateLimited(() =>
				store.replaceRamble({ ...ramble, body, updatedAt: now() }, base)
			);

			return saved ? 'saved' : 'conflict';
		},

		thought: publishedThought,

		editThought: ({
			id,
			base,
			edit
		}: {
			id: ThoughtId;
			base: Revision;
			edit: Partial<ThoughtEdit>;
		}) => replacePublishedThought(id, base, (thought) => ({ ...thought, ...edit })),

		deleteThought: ({ id, base }: { id: ThoughtId; base: Revision }) =>
			replacePublishedThought(id, base, (thought) => ({ ...thought, deleted: true }))
	};
}
