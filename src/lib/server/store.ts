import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
	RAMBLE_STATUSES,
	TODO_STATES,
	type Ramble,
	type RambleId,
	type Thought,
	type ThoughtId
} from '$lib/domain';
import { formatDocument, parseDocument } from './frontmatter';
import { rambleId, thoughtId } from './schemas';

const isoDate = z.iso.datetime().transform((raw) => new Date(raw));

const rambleMeta = z.object({
	id: rambleId,
	status: z.enum(RAMBLE_STATUSES),
	created: isoDate,
	updated: isoDate
});

const thoughtMeta = z.object({
	id: thoughtId,
	ramble: rambleId,
	label: z.string(),
	todo: z.enum(TODO_STATES),
	created: isoDate
});

export function formatRamble(ramble: Ramble): string {
	return formatDocument(
		{
			id: ramble.id,
			status: ramble.status,
			created: ramble.createdAt.toISOString(),
			updated: ramble.updatedAt.toISOString()
		},
		ramble.body
	);
}

export function parseRamble(text: string): Ramble | null {
	const doc = parseDocument(text);
	const meta = doc && rambleMeta.safeParse(doc.data);

	if (!doc || !meta?.success) return null;
	const { id, status, created, updated } = meta.data;

	return { id, status, createdAt: created, updatedAt: updated, body: doc.body };
}

export function formatThought(thought: Thought): string {
	return formatDocument(
		{
			id: thought.id,
			ramble: thought.rambleId,
			label: thought.label,
			todo: thought.todo,
			created: thought.createdAt.toISOString()
		},
		thought.body
	);
}

export function parseThought(text: string): Thought | null {
	const doc = parseDocument(text);
	const meta = doc && thoughtMeta.safeParse(doc.data);

	if (!doc || !meta?.success) return null;
	const { id, ramble, label, todo, created } = meta.data;

	return { id, rambleId: ramble, label, todo, createdAt: created, body: doc.body };
}

export type Store = ReturnType<typeof createStore>;

export function createStore(dataDir: string) {
	const rambleDir = join(dataDir, 'rambles');
	const thoughtDir = join(dataDir, 'thoughts');
	const ramblePath = (id: RambleId) => join(rambleDir, `${id}.md`);
	const thoughtPath = (id: ThoughtId) => join(thoughtDir, `${id}.md`);

	async function writeAtomic(path: string, text: string): Promise<void> {
		const temp = `${path}.${crypto.randomUUID()}.tmp`;
		await writeFile(temp, text, 'utf8');
		await rename(temp, path);
	}

	async function readOptional<T>(
		path: string,
		parse: (text: string) => T | null
	): Promise<T | null> {
		let text: string;

		try {
			text = await readFile(path, 'utf8');
		} catch (error) {
			if (missingFileError.safeParse(error).success) return null;
			throw error;
		}

		const parsed = parse(text);

		if (!parsed) console.warn(`store: skipping malformed file ${path}`);

		return parsed;
	}

	async function readAll<T>(dir: string, parse: (text: string) => T | null): Promise<T[]> {
		const names = (await readdir(dir)).filter((name) => name.endsWith('.md'));
		const items = await Promise.all(names.map((name) => readOptional(join(dir, name), parse)));

		return items.filter((item) => item !== null);
	}

	return {
		async init(): Promise<void> {
			await mkdir(rambleDir, { recursive: true });
			await mkdir(thoughtDir, { recursive: true });
		},
		readRamble: (id: RambleId) => readOptional(ramblePath(id), parseRamble),
		writeRamble: (ramble: Ramble) => writeAtomic(ramblePath(ramble.id), formatRamble(ramble)),
		deleteRamble: (id: RambleId) => rm(ramblePath(id), { force: true }),
		listRambles: () => readAll(rambleDir, parseRamble),
		readThought: (id: ThoughtId) => readOptional(thoughtPath(id), parseThought),
		writeThought: (thought: Thought) =>
			writeAtomic(thoughtPath(thought.id), formatThought(thought)),
		deleteThought: (id: ThoughtId) => rm(thoughtPath(id), { force: true }),
		listThoughts: () => readAll(thoughtDir, parseThought)
	};
}

const missingFileError = z.object({ code: z.literal('ENOENT') });
