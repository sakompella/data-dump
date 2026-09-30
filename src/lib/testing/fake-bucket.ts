import type { DocumentBucket } from '$lib/server/store';

// A test clock shared by the fake bucket and the code under test: sleeping
// moves time forward instead of waiting.
export function createTestClock(start = Date.parse('2026-01-01T00:00:00Z')) {
	let millis = start;

	return {
		now: () => new Date(millis),
		advance: (ms: number) => void (millis += ms),
		sleep: async (ms: number) => {
			millis += ms;
			await Promise.resolve();
		}
	};
}

export type TestClock = ReturnType<typeof createTestClock>;

interface StoredObject {
	readonly text: string;
	readonly etag: string;
	readonly writtenAt: number;
}

const MIN_WRITE_GAP_MS = 1000;

// In-memory R2 with the behaviour the store relies on: a fresh etag per write,
// onlyIf conditions that write nothing and return null when they fail,
// If-None-Match: * for create-only, cursor pages, and at most one write per
// second to a key (error 10058, as R2 reports it).
// `io` runs before each call; by default it lets other pending work run, as
// real I/O would. Property tests pass a fast-check scheduler here.
export function createFakeBucket({
	clock = createTestClock(),
	pageSize = 1000,
	io = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
}: { clock?: TestClock; pageSize?: number; io?: () => Promise<void> } = {}) {
	const objects = new Map<string, StoredObject>();
	let writes = 0;

	function conditionHolds(
		existing: StoredObject | undefined,
		onlyIf: { etagMatches: string } | Headers
	) {
		if (!(onlyIf instanceof Headers)) return existing?.etag === onlyIf.etagMatches;
		const noneMatch = onlyIf.get('if-none-match');

		if (noneMatch !== '*' || [...onlyIf.keys()].length !== 1) {
			throw new Error('fake bucket: only If-None-Match: * is supported');
		}

		return existing === undefined;
	}

	const bucket: DocumentBucket = {
		async get(key) {
			await io();
			const object = objects.get(key);

			return object ? { etag: object.etag, text: async () => object.text } : null;
		},

		async put(key, value, { onlyIf }) {
			await io();
			const existing = objects.get(key);

			if (!conditionHolds(existing, onlyIf)) return null;
			const now = clock.now().getTime();

			if (existing && now - existing.writtenAt < MIN_WRITE_GAP_MS) {
				throw new Error('put: Rate limit exceeded. (10058)');
			}

			writes += 1;
			const etag = `etag-${writes}`;
			objects.set(key, { text: value, etag, writtenAt: now });

			return { etag };
		},

		async list({ prefix, cursor }) {
			await io();
			const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
			const start = cursor ? keys.findIndex((key) => key > cursor) : 0;
			const page = start === -1 ? [] : keys.slice(start, start + pageSize);
			const objectsOnPage = page.map((key) => ({ key }));
			const last = page.at(-1);

			return last !== undefined && keys.indexOf(last) < keys.length - 1
				? { objects: objectsOnPage, truncated: true, cursor: last }
				: { objects: objectsOnPage, truncated: false };
		}
	};

	return { bucket, objects };
}
