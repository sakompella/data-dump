import { z } from 'zod';
import { parseRambleId, parseThoughtId } from '$lib/ids';
import { TODO_STATES } from '$lib/domain';

const brandedId = <Id>(parseId: (raw: string) => Id | null) =>
	z.string().transform((raw, ctx) => {
		const id = parseId(raw);
		if (id === null) {
			ctx.addIssue({ code: 'custom', message: `malformed id ${raw}` });
			return z.NEVER;
		}
		return id;
	});

export const rambleId = brandedId(parseRambleId);
export const thoughtId = brandedId(parseThoughtId);
export const todoState = z.enum(TODO_STATES);
