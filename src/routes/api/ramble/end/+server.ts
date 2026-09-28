import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { rambles } from '$lib/server/app';
import { rambleId } from '$lib/server/schemas';
import type { RequestHandler } from './$types';

const endRequest = z.object({ id: rambleId });

export const POST: RequestHandler = async ({ request }) => {
	const parsed = endRequest.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, 'Expected { id }');
	await (await rambles()).endRamble(parsed.data.id);
	return json({ ok: true });
};
