import { z } from 'zod';
import { parseRevision, type Revision } from '$lib/ids';
import {
	TODO_STATES,
	type Ramble,
	type RambleId,
	type RambleState,
	type Thought,
	type ThoughtId
} from '$lib/domain';
import type { UserId } from './access';
import { formatDocument, parseDocument } from './frontmatter';
import { publicationId, rambleId, thoughtId } from './schemas';

const isoDate = z.iso.datetime().transform((raw) => new Date(raw));

const rambleFields = { id: rambleId, created: isoDate, updated: isoDate };

const rambleMeta = z.discriminatedUnion('status', [
	z.object({ ...rambleFields, status: z.literal('open') }),
	z.object({ ...rambleFields, status: z.literal('ended') }),
	z.object({ ...rambleFields, status: z.literal('split'), publication: publicationId }),
	z.object({ ...rambleFields, status: z.literal('discarded') })
]);

const thoughtMeta = z.object({
	id: thoughtId,
	ramble: rambleId,
	publication: publicationId,
	label: z.string(),
	todo: z.enum(TODO_STATES),
	created: isoDate,
	deleted: z.boolean()
});

export function formatRamble(ramble: Ramble): string {
	const data = {
		id: ramble.id,
		status: ramble.status,
		created: ramble.createdAt.toISOString(),
		updated: ramble.updatedAt.toISOString()
	};

	return formatDocument(
		ramble.status === 'split' ? { ...data, publication: ramble.publication } : data,
		ramble.body
	);
}

export function parseRamble(text: string): Ramble | null {
	const doc = parseDocument(text);
	const meta = doc && rambleMeta.safeParse(doc.data);

	if (!doc || !meta?.success) return null;
	const { id, created, updated } = meta.data;

	const state: RambleState =
		meta.data.status === 'split'
			? { status: 'split', publication: meta.data.publication }
			: { status: meta.data.status };

	return { id, createdAt: created, updatedAt: updated, body: doc.body, ...state };
}

export function formatThought(thought: Thought): string {
	return formatDocument(
		{
			id: thought.id,
			ramble: thought.rambleId,
			publication: thought.publication,
			label: thought.label,
			todo: thought.todo,
			created: thought.createdAt.toISOString(),
			deleted: thought.deleted
		},
		thought.body
	);
}

export function parseThought(text: string): Thought | null {
	const doc = parseDocument(text);
	const meta = doc && thoughtMeta.safeParse(doc.data);

	if (!doc || !meta?.success) return null;
	const { id, ramble, publication, label, todo, created, deleted } = meta.data;

	return {
		id,
		rambleId: ramble,
		publication,
		label,
		todo,
		createdAt: created,
		body: doc.body,
		deleted
	};
}

// A document as read, with the revision a later write must still match.
export type Stored<T> = T & { readonly revision: Revision };

// The part of an R2 bucket binding the store uses. R2Bucket satisfies it;
// tests use an in-memory fake with the same conditional-write rules.
export interface DocumentBucket {
	get(key: string): Promise<{ readonly etag: string; text(): Promise<string> } | null>;
	put(
		key: string,
		value: string,
		options: { onlyIf: { etagMatches: string } | Headers }
	): Promise<{ readonly etag: string } | null>;
	list(options: {
		prefix: string;
		cursor?: string;
	}): Promise<
		{ readonly objects: readonly { readonly key: string }[] } & (
			| { readonly truncated: true; readonly cursor: string }
			| { readonly truncated: false }
		)
	>;
}

// R2 allows one write per second to a key and reports more as error 10058.
export class WriteRateLimited extends Error {}

const rateLimitError = z.object({ message: z.string().regex(/\(10058\)/) });

type Condition = { kind: 'absent' } | { kind: 'matches'; revision: Revision };

export type Store = ReturnType<typeof createStore>;

// One user's documents: users/<userId>/rambles/<id>.md and .../thoughts/<id>.md.
export function createStore({ bucket, userId }: { bucket: DocumentBucket; userId: UserId }) {
	const rambleDir = `users/${userId}/rambles/`;
	const thoughtDir = `users/${userId}/thoughts/`;
	const rambleKey = (id: RambleId) => `${rambleDir}${id}.md`;
	const thoughtKey = (id: ThoughtId) => `${thoughtDir}${id}.md`;

	async function read<T>(
		key: string,
		parse: (text: string) => T | null
	): Promise<Stored<T> | null> {
		const object = await bucket.get(key);

		if (!object) return null;
		const value = parse(await object.text());
		const revision = parseRevision(object.etag);

		if (!value || !revision) {
			console.warn(`store: skipping malformed object ${key}`);

			return null;
		}

		return { ...value, revision };
	}

	// Null when the condition failed and nothing was written.
	async function write<T>(key: string, value: T, text: string, condition: Condition) {
		const onlyIf =
			condition.kind === 'absent'
				? new Headers({ 'If-None-Match': '*' })
				: { etagMatches: condition.revision };

		let written: { readonly etag: string } | null;

		try {
			written = await bucket.put(key, text, { onlyIf });
		} catch (error) {
			if (rateLimitError.safeParse(error).success)
				throw new WriteRateLimited(`${key} was written too recently`);
			throw error;
		}

		if (!written) return null;
		const revision = parseRevision(written.etag);

		if (!revision) throw new Error(`store: unexpected etag for ${key}`);
		const stored: Stored<T> = { ...value, revision };

		return stored;
	}

	async function listKeys(prefix: string): Promise<string[]> {
		const keys: string[] = [];
		let cursor: string | undefined;

		for (;;) {
			const page = await bucket.list({ prefix, cursor });
			keys.push(...page.objects.map((object) => object.key).filter((key) => key.endsWith('.md')));

			if (!page.truncated) return keys;
			cursor = page.cursor;
		}
	}

	async function readAll<T>(prefix: string, parse: (text: string) => T | null) {
		const items = await Promise.all((await listKeys(prefix)).map((key) => read(key, parse)));

		return items.filter((item) => item !== null);
	}

	return {
		readRamble: (id: RambleId) => read(rambleKey(id), parseRamble),
		// Null if a ramble with this id already exists.
		createRamble: (ramble: Ramble) =>
			write(rambleKey(ramble.id), ramble, formatRamble(ramble), { kind: 'absent' }),
		// Null if the stored ramble is no longer at `expected`.
		replaceRamble: (ramble: Ramble, expected: Revision) =>
			write(rambleKey(ramble.id), ramble, formatRamble(ramble), {
				kind: 'matches',
				revision: expected
			}),
		listRambles: () => readAll(rambleDir, parseRamble),
		readThought: (id: ThoughtId) => read(thoughtKey(id), parseThought),
		createThought: (thought: Thought) =>
			write(thoughtKey(thought.id), thought, formatThought(thought), { kind: 'absent' }),
		replaceThought: (thought: Thought, expected: Revision) =>
			write(thoughtKey(thought.id), thought, formatThought(thought), {
				kind: 'matches',
				revision: expected
			}),
		listThoughts: () => readAll(thoughtDir, parseThought)
	};
}
