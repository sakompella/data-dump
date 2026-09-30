import type { PublicationId, RambleId, ThoughtId } from '$lib/ids';

export type { PublicationId, RambleId, ThoughtId };

export const RAMBLE_STATUSES = ['open', 'ended', 'split', 'discarded'] as const;

export type RambleStatus = (typeof RAMBLE_STATUSES)[number];

export type RambleState =
	// Still being written.
	| { readonly status: 'open' }
	// Waiting for a split.
	| { readonly status: 'ended' }
	// Its thoughts are the ones carrying this publication id.
	| { readonly status: 'split'; readonly publication: PublicationId }
	// Ended with no text. Kept so a late write cannot bring it back; never shown.
	| { readonly status: 'discarded' };

export const TODO_STATES = ['none', 'open', 'done'] as const;

export type TodoState = (typeof TODO_STATES)[number];

export type Ramble = {
	readonly id: RambleId;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly body: string;
} & RambleState;

export interface Thought {
	readonly id: ThoughtId;
	readonly rambleId: RambleId;
	readonly publication: PublicationId;
	readonly label: string;
	readonly todo: TodoState;
	readonly createdAt: Date;
	readonly body: string;
	// Deleted thoughts stay as tombstones so a stale edit cannot recreate them.
	readonly deleted: boolean;
}

const NEXT_STATUSES: Record<RambleStatus, readonly RambleStatus[]> = {
	open: ['ended', 'discarded'],
	ended: ['split'],
	split: [],
	discarded: []
};

export const canAdvance = (from: RambleStatus, to: RambleStatus): boolean =>
	NEXT_STATUSES[from].includes(to);

export function advance(ramble: Ramble, next: RambleState): Ramble {
	if (!canAdvance(ramble.status, next.status)) {
		throw new Error(`ramble ${ramble.id}: cannot go from ${ramble.status} to ${next.status}`);
	}

	const { id, createdAt, updatedAt, body } = ramble;

	return { id, createdAt, updatedAt, body, ...next };
}

// Thoughts from any other split of the same ramble are never shown.
export const isPublished = (thought: Thought, ramble: Ramble): boolean =>
	!thought.deleted &&
	thought.rambleId === ramble.id &&
	ramble.status === 'split' &&
	thought.publication === ramble.publication;
