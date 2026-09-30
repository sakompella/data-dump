import { newRambleId, newThoughtId } from '$lib/ids';
import { isIdle } from '$lib/idle';
import { copiesFromProposals, wholeRambleCopy } from './copies';
import { advance, type Ramble, type RambleId, type Thought, type ThoughtId } from '$lib/domain';
import { createKeyedMutex } from './keyed-mutex';
import type { Splitter } from './splitter';
import type { Store } from './store';

export type RambleService = ReturnType<typeof createRambleService>;

export interface ThoughtEdit {
	readonly label: string;
	readonly body: string;
	readonly todo: Thought['todo'];
}

const newestFirst = (a: Thought, b: Thought) =>
	b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id);

export function createRambleService({
	store,
	split,
	now = () => new Date()
}: {
	store: Store;
	split: Splitter;
	now?: () => Date;
}) {
	const withLock = createKeyedMutex();
	const splitsInFlight = new Map<RambleId, Promise<void>>();

	async function createRamble(id: RambleId, body: string): Promise<void> {
		if (body === '') return;
		const at = now();
		await store.writeRamble({ id, status: 'open', createdAt: at, updatedAt: at, body });
	}

	// Open rambles past the idle gap are ended. Empty ones are deleted instead.
	async function endIfOpen(id: RambleId, onlyIfIdle: boolean): Promise<void> {
		await withLock(id, async () => {
			const ramble = await store.readRamble(id);

			if (!ramble || ramble.status !== 'open') return;

			if (onlyIfIdle && !isIdle(ramble.updatedAt, now())) return;

			if (ramble.body.trim() === '') {
				await store.deleteRamble(id);

				return;
			}

			await store.writeRamble(advance(ramble, 'ended'));
		});
	}

	async function splitIfEnded(id: RambleId): Promise<void> {
		const snapshot = await store.readRamble(id);

		if (!snapshot || snapshot.status !== 'ended') return;

		let proposals;

		try {
			proposals = await split(snapshot.body);
		} catch (error) {
			console.error(`split ${id}: model call failed; ramble stays ended for a later retry`, error);

			return;
		}

		const kept = copiesFromProposals(snapshot.body, proposals);

		if (kept.length > 0) {
			console.info(`split ${id}: ${kept.length} of ${proposals.length} proposed thoughts kept`);
		} else {
			console.info(`split ${id}: nothing usable from the model; keeping the whole ramble`);
		}

		const copies = kept.length > 0 ? kept : [wholeRambleCopy(snapshot.body)];

		await withLock(id, async () => {
			const latest = await store.readRamble(id);

			if (!latest || latest.status !== 'ended') return;
			// Thoughts of a ramble that is not split yet were never shown; they
			// can only be leftovers of an interrupted split.
			const leftovers = (await store.listThoughts()).filter((t) => t.rambleId === id);
			await Promise.all(leftovers.map((t) => store.deleteThought(t.id)));
			const createdAt = now();

			for (const copy of copies) {
				await store.writeThought({ id: newThoughtId(), rambleId: id, createdAt, ...copy });
			}

			await store.writeRamble(advance(latest, 'split'));
		});
	}

	function splitOnce(id: RambleId): Promise<void> {
		const running = splitsInFlight.get(id);

		if (running) return running;
		const started = splitIfEnded(id).finally(() => splitsInFlight.delete(id));
		splitsInFlight.set(id, started);

		return started;
	}

	async function isPublished(thought: Thought): Promise<boolean> {
		return (await store.readRamble(thought.rambleId))?.status === 'split';
	}

	return {
		// Upsert. A ramble that is no longer open is never reopened: the text
		// goes into a new ramble so it is not lost. Returns the id that holds it.
		async saveDraft({ id, body }: { id: RambleId; body: string }): Promise<RambleId> {
			const accepted = await withLock(id, async () => {
				const existing = await store.readRamble(id);

				if (!existing) {
					await createRamble(id, body);

					return true;
				}

				if (existing.status !== 'open') return false;
				await store.writeRamble({ ...existing, body, updatedAt: now() });

				return true;
			});

			if (accepted) return id;
			const replacement = newRambleId();
			await withLock(replacement, () => createRamble(replacement, body));

			return replacement;
		},

		async endRamble(id: RambleId): Promise<void> {
			await endIfOpen(id, false);
			await splitOnce(id);
		},

		// Runs on page load: ends idle rambles now, and retries pending splits
		// in the background.
		async settleOnLoad(): Promise<void> {
			const open = (await store.listRambles()).filter((r) => r.status === 'open');
			await Promise.all(open.map((r) => endIfOpen(r.id, true)));
			const ended = (await store.listRambles()).filter((r) => r.status === 'ended');
			void Promise.all(ended.map((r) => splitOnce(r.id))).catch((error) =>
				console.error('split retry failed', error)
			);
		},

		async home(): Promise<{ draft: Ramble | null; thoughts: Thought[]; waiting: number }> {
			const rambles = await store.listRambles();
			const split = new Set(rambles.filter((r) => r.status === 'split').map((r) => r.id));

			const draft =
				rambles
					.filter((r) => r.status === 'open')
					.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;

			const thoughts = (await store.listThoughts())
				.filter((t) => split.has(t.rambleId))
				.sort(newestFirst);

			const waiting = rambles.filter((r) => r.status === 'ended').length;

			return { draft, thoughts, waiting };
		},

		async ramble(id: RambleId): Promise<{ ramble: Ramble; thoughts: Thought[] } | null> {
			const ramble = await store.readRamble(id);

			if (!ramble) return null;

			const thoughts =
				ramble.status === 'split'
					? (await store.listThoughts()).filter((t) => t.rambleId === id).sort(newestFirst)
					: [];

			return { ramble, thoughts };
		},

		// Changes only the ramble; thoughts copied from it stay as they are.
		editRamble({ id, body }: { id: RambleId; body: string }): Promise<boolean> {
			return withLock(id, async () => {
				const ramble = await store.readRamble(id);

				if (!ramble) return false;
				await store.writeRamble({ ...ramble, body, updatedAt: now() });

				return true;
			});
		},

		async thought(id: ThoughtId): Promise<Thought | null> {
			const thought = await store.readThought(id);

			return thought && (await isPublished(thought)) ? thought : null;
		},

		editThought(id: ThoughtId, edit: Partial<ThoughtEdit>): Promise<boolean> {
			return withLock(id, async () => {
				const thought = await store.readThought(id);

				if (!thought || !(await isPublished(thought))) return false;
				await store.writeThought({ ...thought, ...edit });

				return true;
			});
		},

		deleteThought(id: ThoughtId): Promise<boolean> {
			return withLock(id, async () => {
				const thought = await store.readThought(id);

				if (!thought || !(await isPublished(thought))) return false;
				await store.deleteThought(id);

				return true;
			});
		}
	};
}
