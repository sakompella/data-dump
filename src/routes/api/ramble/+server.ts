import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { rambles } from '$lib/server/app';
import { rambleId, revision } from '$lib/server/schemas';
import { WriteRateLimited } from '$lib/server/store';
import type { RequestHandler } from './$types';

const draftSave = z.object({ id: rambleId, body: z.string(), base: revision.nullable() });

// Seconds the capture box waits before saving again after R2 refused a write.
const RETRY_AFTER_S = 2;

export const PUT: RequestHandler = async (event) => {
	const parsed = draftSave.safeParse(await event.request.json().catch(() => null));

	if (!parsed.success) error(400, 'Expected { id, body, base }');

	try {
		return json(await rambles(event).saveDraft(parsed.data));
	} catch (caught) {
		if (!(caught instanceof WriteRateLimited)) throw caught;

		return new Response('Saving too often; try again shortly', {
			status: 503,
			headers: { 'retry-after': String(RETRY_AFTER_S) }
		});
	}
};
