import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { MAX_PROPOSALS, proposedThought } from '$lib/proposals';
import { rambles } from '$lib/server/app';
import { rambleId } from '$lib/server/schemas';
import type { RequestHandler } from './$types';

// The proposals come from the browser, so they are bounded like any other input.
const MAX_REQUEST_CHARS = 1_000_000;

const finishRequest = z.object({
	id: rambleId,
	attempt: z.string().regex(/^[0-9A-Za-z-]{1,64}$/),
	proposals: z.array(proposedThought).max(MAX_PROPOSALS)
});

export const POST: RequestHandler = async (event) => {
	const text = await event.request.text();

	if (text.length > MAX_REQUEST_CHARS) error(413, 'Too many proposals');
	let payload: unknown;

	try {
		payload = JSON.parse(text);
	} catch {
		payload = undefined;
	}

	const parsed = finishRequest.safeParse(payload);

	if (!parsed.success) error(400, 'Expected { id, attempt, proposals }');
	const result = await rambles(event).finishSplit(parsed.data);

	return json(result, { status: result.kind === 'conflict' ? 409 : 200 });
};
