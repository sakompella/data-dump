// One user's rambles and thoughts, and every rule about changing them. The
// UserData Durable Object runs this against its SQLite storage; tests run it
// against node:sqlite. Every method is synchronous, so a call reads and
// writes without anything else running in between.
import { z } from 'zod';
import {
	advance,
	RAMBLE_STATUSES,
	TODO_STATES,
	type Ramble,
	type RambleId,
	type RambleStatus,
	type Thought,
	type ThoughtId
} from '../shared/domain';
import { newRambleId, newThoughtId, type Revision } from '../shared/ids';
import { isIdle } from '../shared/idle';
import type { ProposedThought } from '../shared/proposals';
import { copiesFromProposals, wholeRambleCopy } from './copies';
import { rambleId, revision, thoughtId } from '../shared/schemas';

export type SqlValue = string | number | null;

export interface Sql {
	// Runs one statement and returns its rows as the driver gives them.
	query(statement: string, ...bindings: SqlValue[]): readonly Readonly<Record<string, SqlValue>>[];
	// Runs work atomically: if it throws, none of its writes stay.
	transaction<T>(work: () => T): T;
}

// Each entry is one schema version; entries are never edited once deployed.
// Nothing has been deployed yet, so version 1 is still the only one.
const MIGRATIONS: readonly (readonly string[])[] = [
	[
		`CREATE TABLE rambles (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL CHECK (status IN ('open', 'ended', 'split')),
			revision INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			body TEXT NOT NULL
		)`,
		`CREATE TABLE thoughts (
			id TEXT PRIMARY KEY,
			ramble_id TEXT NOT NULL REFERENCES rambles (id),
			label TEXT NOT NULL,
			todo TEXT NOT NULL CHECK (todo IN ('none', 'open', 'done')),
			revision INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			body TEXT NOT NULL
		)`,
		'CREATE INDEX thoughts_by_ramble ON thoughts (ramble_id)',
		// A discarded id must never come back: a tab that still holds it would
		// otherwise match a revision of the new ramble by accident.
		'CREATE TABLE discarded_rambles (id TEXT PRIMARY KEY)'
	]
];

export function migrate(sql: Sql, now: Date): void {
	sql.query(
		'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)'
	);

	const applied = new Set(
		sql.query('SELECT version FROM migrations').map((row) => z.number().parse(row.version))
	);

	MIGRATIONS.forEach((statements, index) => {
		const version = index + 1;

		if (applied.has(version)) return;
		sql.transaction(() => {
			for (const statement of statements) sql.query(statement);
			sql.query(
				'INSERT INTO migrations (version, applied_at) VALUES (?, ?)',
				version,
				now.getTime()
			);
		});
	});
}

const millis = z.number().transform((ms) => new Date(ms));

const rambleRow = z
	.object({
		id: rambleId,
		status: z.enum(RAMBLE_STATUSES),
		revision,
		created_at: millis,
		updated_at: millis,
		body: z.string()
	})
	.transform(({ created_at, updated_at, ...ramble }) => ({
		...ramble,
		createdAt: created_at,
		updatedAt: updated_at
	}));

const thoughtRow = z
	.object({
		id: thoughtId,
		ramble_id: rambleId,
		label: z.string(),
		todo: z.enum(TODO_STATES),
		revision,
		created_at: millis,
		body: z.string()
	})
	.transform(({ ramble_id, created_at, ...thought }) => ({
		...thought,
		rambleId: ramble_id,
		createdAt: created_at
	}));

// A document as read, with the revision a later write must still match.
export type Stored<T> = T & { readonly revision: Revision };

// SAFETY: one more than a positive integer is a positive integer.
const nextRevision = (current: Revision): Revision => (current + 1) as Revision;

// SAFETY: 1 is a positive integer.
const FIRST_REVISION = 1 as Revision;

export interface ThoughtEdit {
	readonly label: string;
	readonly body: string;
	readonly todo: Thought['todo'];
}

// `conflict` means the document changed since the caller read it; nothing was written.
export type EditResult =
	| { kind: 'saved'; revision: Revision }
	| { kind: 'conflict' }
	| { kind: 'missing' };

export type DeleteResult = 'saved' | 'conflict' | 'missing';

export interface PendingSplit {
	readonly id: RambleId;
	readonly body: string;
	readonly revision: Revision;
}

export interface SaveResult {
	readonly id: RambleId;
	// Null when there was no text, so nothing was stored.
	readonly revision: Revision | null;
}

export interface HomeView {
	readonly draft: Stored<Ramble> | null;
	readonly thoughts: Stored<Thought>[];
	readonly pending: PendingSplit[];
}

export interface RambleView {
	readonly ramble: Stored<Ramble>;
	readonly thoughts: Stored<Thought>[];
}

export type FinishResult =
	| { kind: 'published' }
	| { kind: 'not-ended'; status: RambleStatus }
	| { kind: 'missing' }
	// The ramble was edited after the browser read it; it stays ended for a new split.
	| { kind: 'stale' };

export type UserRules = ReturnType<typeof createUserRules>;

export function createUserRules({ sql, now }: { sql: Sql; now: () => Date }) {
	function readRamble(id: RambleId): Stored<Ramble> | null {
		const [row] = sql.query('SELECT * FROM rambles WHERE id = ?', id);

		return row ? rambleRow.parse(row) : null;
	}

	function readThought(id: ThoughtId): Stored<Thought> | null {
		const [row] = sql.query('SELECT * FROM thoughts WHERE id = ?', id);

		return row ? thoughtRow.parse(row) : null;
	}

	const thoughtsOf = (id: RambleId) =>
		sql
			.query('SELECT * FROM thoughts WHERE ramble_id = ? ORDER BY created_at DESC, id', id)
			.map((row) => thoughtRow.parse(row));

	function insertOpenRamble(id: RambleId, body: string): Revision {
		const at = now().getTime();

		sql.query(
			'INSERT INTO rambles (id, status, revision, created_at, updated_at, body) VALUES (?, ?, ?, ?, ?, ?)',
			id,
			'open',
			FIRST_REVISION,
			at,
			at,
			body
		);

		return FIRST_REVISION;
	}

	function writeRamble(ramble: Stored<Ramble>): Revision {
		const next = nextRevision(ramble.revision);

		sql.query(
			'UPDATE rambles SET status = ?, revision = ?, updated_at = ?, body = ? WHERE id = ?',
			ramble.status,
			next,
			ramble.updatedAt.getTime(),
			ramble.body,
			ramble.id
		);

		return next;
	}

	// Text that cannot go into the ramble it was meant for goes into a new one.
	function saveAsReplacement(body: string): SaveResult {
		const id = newRambleId();

		return { id, revision: body === '' ? null : insertOpenRamble(id, body) };
	}

	function discard(id: RambleId): void {
		sql.query('DELETE FROM rambles WHERE id = ?', id);
		sql.query('INSERT OR IGNORE INTO discarded_rambles (id) VALUES (?)', id);
	}

	// Empty rambles are deleted instead of ended: there is nothing to split.
	function end(ramble: Stored<Ramble>): PendingSplit | null {
		if (ramble.body.trim() === '') {
			discard(ramble.id);

			return null;
		}

		const revision = writeRamble(advance(ramble, 'ended'));

		return { id: ramble.id, body: ramble.body, revision };
	}

	return {
		// Upsert against the revision the caller last saw. A stale save that
		// does not extend the stored text is never merged or dropped: its text
		// goes into a new ramble whose id is returned.
		saveDraft({
			id,
			body,
			base
		}: {
			id: RambleId;
			body: string;
			base: Revision | null;
		}): SaveResult {
			const existing = readRamble(id);

			if (!existing) {
				const discarded = sql.query('SELECT id FROM discarded_rambles WHERE id = ?', id).length > 0;

				return discarded
					? saveAsReplacement(body)
					: { id, revision: body === '' ? null : insertOpenRamble(id, body) };
			}

			if (existing.status === 'open') {
				if (existing.body === body) return { id, revision: existing.revision };

				// A stale base whose text extends the stored text (a lost reply, then more
				// typing) drops nothing, so it updates the ramble instead of forking it.
				if (existing.revision === base || body.startsWith(existing.body)) {
					return { id, revision: writeRamble({ ...existing, body, updatedAt: now() }) };
				}
			}

			return saveAsReplacement(body);
		},

		// Returns the ramble's text when it is waiting for a split.
		endRamble(id: RambleId): PendingSplit | null {
			const ramble = readRamble(id);

			if (ramble?.status === 'open') return end(ramble);

			return ramble?.status === 'ended'
				? { id, body: ramble.body, revision: ramble.revision }
				: null;
		},

		// Ends open rambles that have been idle past the gap.
		settleOnLoad(): void {
			const open = sql
				.query("SELECT * FROM rambles WHERE status = 'open'")
				.map((row) => rambleRow.parse(row));

			for (const ramble of open.filter((r) => isIdle(r.updatedAt, now()))) end(ramble);
		},

		// Copies the proposals out of the stored body and publishes them, once.
		finishSplit({
			id,
			revision: base,
			proposals
		}: {
			id: RambleId;
			revision: Revision;
			proposals: readonly ProposedThought[];
		}): FinishResult {
			return sql.transaction((): FinishResult => {
				const ramble = readRamble(id);

				if (!ramble) return { kind: 'missing' };

				if (ramble.status === 'split') return { kind: 'published' };

				if (ramble.status === 'open') return { kind: 'not-ended', status: ramble.status };

				if (ramble.revision !== base) return { kind: 'stale' };

				// Edited to blank after it ended: nothing to publish.
				if (ramble.body.trim() === '') {
					discard(id);

					return { kind: 'published' };
				}

				const kept = copiesFromProposals(ramble.body, proposals);
				const copies = kept.length > 0 ? kept : [wholeRambleCopy(ramble.body)];
				const at = now().getTime();

				for (const copy of copies) {
					sql.query(
						'INSERT INTO thoughts (id, ramble_id, label, todo, revision, created_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
						newThoughtId(),
						id,
						copy.label,
						copy.todo,
						FIRST_REVISION,
						at,
						copy.body
					);
				}

				writeRamble(advance(ramble, 'split'));

				return { kind: 'published' };
			});
		},

		home(): HomeView {
			const [draftRow] = sql.query(
				"SELECT * FROM rambles WHERE status = 'open' ORDER BY updated_at DESC LIMIT 1"
			);

			const pending = sql
				.query("SELECT * FROM rambles WHERE status = 'ended' ORDER BY id")
				.map((row) => rambleRow.parse(row))
				.map(({ id, body, revision }) => ({ id, body, revision }));

			const thoughts = sql
				.query('SELECT * FROM thoughts ORDER BY created_at DESC, id')
				.map((row) => thoughtRow.parse(row));

			return { draft: draftRow ? rambleRow.parse(draftRow) : null, thoughts, pending };
		},

		ramble(id: RambleId): RambleView | null {
			const ramble = readRamble(id);

			return ramble && { ramble, thoughts: thoughtsOf(id) };
		},

		thought: readThought,

		// Changes only the ramble body; its status and thoughts stay as they are.
		editRamble({ id, body, base }: { id: RambleId; body: string; base: Revision }): EditResult {
			const ramble = readRamble(id);

			if (!ramble) return { kind: 'missing' };

			if (ramble.revision !== base) return { kind: 'conflict' };

			return { kind: 'saved', revision: writeRamble({ ...ramble, body, updatedAt: now() }) };
		},

		editThought({
			id,
			base,
			edit
		}: {
			id: ThoughtId;
			base: Revision;
			edit: Partial<ThoughtEdit>;
		}): EditResult {
			const thought = readThought(id);

			if (!thought) return { kind: 'missing' };

			if (thought.revision !== base) return { kind: 'conflict' };
			const { label, body, todo } = { ...thought, ...edit };
			const next = nextRevision(thought.revision);

			sql.query(
				'UPDATE thoughts SET label = ?, body = ?, todo = ?, revision = ? WHERE id = ?',
				label,
				body,
				todo,
				next,
				id
			);

			return { kind: 'saved', revision: next };
		},

		deleteThought({ id, base }: { id: ThoughtId; base: Revision }): DeleteResult {
			const thought = readThought(id);

			if (!thought) return 'missing';

			if (thought.revision !== base) return 'conflict';
			sql.query('DELETE FROM thoughts WHERE id = ?', id);

			return 'saved';
		}
	};
}
