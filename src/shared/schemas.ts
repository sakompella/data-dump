import { z } from 'zod';
import { parseRambleId, parseRevision, parseThoughtId } from './ids';
import { TODO_STATES } from './domain';

const branded = <Raw, Branded>(raw: z.ZodType<Raw>, parse: (raw: Raw) => Branded | null) =>
	raw.transform((value, ctx) => {
		const parsed = parse(value);

		if (parsed === null) {
			ctx.addIssue({ code: 'custom', message: `malformed value ${String(value)}` });

			return z.NEVER;
		}

		return parsed;
	});

export const rambleId = branded(z.string(), parseRambleId);

export const thoughtId = branded(z.string(), parseThoughtId);

export const revision = branded(z.number(), parseRevision);

export const todoState = z.enum(TODO_STATES);
