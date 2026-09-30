// Shared by server and browser: the capture box makes ramble ids client-side.
declare const brand: unique symbol;

type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type RambleId = Brand<string, 'RambleId'>;

export type ThoughtId = Brand<string, 'ThoughtId'>;

const ID_PATTERN = /^[0-9a-z]{9}-[0-9a-z]{8}$/;

let lastMillis = 0;

// Time-sortable and filename-safe. Millis are bumped when needed so ids made
// in one process always sort in creation order.
function newId(): string {
	lastMillis = Math.max(Date.now(), lastMillis + 1);
	const time = lastMillis.toString(36).padStart(9, '0');

	const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
		(byte % 36).toString(36)
	).join('');

	return `${time}-${random}`;
}

export const newRambleId = (): RambleId => newId() as RambleId;

export const newThoughtId = (): ThoughtId => newId() as ThoughtId;

export const parseRambleId = (raw: string): RambleId | null =>
	ID_PATTERN.test(raw) ? (raw as RambleId) : null;

export const parseThoughtId = (raw: string): ThoughtId | null =>
	ID_PATTERN.test(raw) ? (raw as ThoughtId) : null;
