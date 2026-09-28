import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { rambles } from '$lib/server/app';
import { rambleId } from '$lib/server/schemas';
import type { RequestHandler } from './$types';

const draftSave = z.object({ id: rambleId, body: z.string() });

export const PUT: RequestHandler = async ({ request }) => {
	const parsed = draftSave.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, 'Expected { id, body }');
	const id = await (await rambles()).saveDraft(parsed.data);
	return json({ id });
};
