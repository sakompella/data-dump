import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { rambles } from '$lib/server/app';
import { rambleId } from '$lib/server/schemas';
import type { RequestHandler } from './$types';

const endRequest = z.object({ id: rambleId });

// Replies with the ramble's text when the browser should split it now.
export const POST: RequestHandler = async (event) => {
	const parsed = endRequest.safeParse(await event.request.json().catch(() => null));

	if (!parsed.success) error(400, 'Expected { id }');

	return json({ toSplit: await rambles(event).endRamble(parsed.data.id) });
};
