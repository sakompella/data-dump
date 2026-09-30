import type { RambleId, ThoughtId } from './ids';

export type { RambleId, ThoughtId };

// open: still being written; ended: waiting for split; split: thoughts copied.
export const RAMBLE_STATUSES = ['open', 'ended', 'split'] as const;

export type RambleStatus = (typeof RAMBLE_STATUSES)[number];

export const TODO_STATES = ['none', 'open', 'done'] as const;

export type TodoState = (typeof TODO_STATES)[number];

export interface Ramble {
	readonly id: RambleId;
	readonly status: RambleStatus;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly body: string;
}

export interface Thought {
	readonly id: ThoughtId;
	readonly rambleId: RambleId;
	readonly label: string;
	readonly todo: TodoState;
	readonly createdAt: Date;
	readonly body: string;
}

const NEXT_STATUS: Record<RambleStatus, RambleStatus | null> = {
	open: 'ended',
	ended: 'split',
	split: null
};

export const canAdvance = (from: RambleStatus, to: RambleStatus): boolean =>
	NEXT_STATUS[from] === to;

export function advance<R extends Ramble>(ramble: R, to: RambleStatus): R {
	if (!canAdvance(ramble.status, to)) {
		throw new Error(`ramble ${ramble.id}: cannot go from ${ramble.status} to ${to}`);
	}

	return { ...ramble, status: to };
}
