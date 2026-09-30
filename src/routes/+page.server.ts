import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { rambles } from '$lib/server/app';
import { revision, thoughtId } from '$lib/server/schemas';
import type { Actions, PageServerLoad } from './$types';

const toggle = z.object({ id: thoughtId, revision });

export const load: PageServerLoad = async (event) => {
	const { draft, thoughts, pending } = await rambles(event).home();

	return {
		draft: draft && {
			id: draft.id,
			body: draft.body,
			updatedAt: draft.updatedAt,
			revision: draft.revision
		},
		thoughts,
		pending
	};
};

export const actions = {
	toggle: async (event) => {
		const form = await event.request.formData();
		const parsed = toggle.safeParse({ id: form.get('id'), revision: form.get('revision') });

		if (!parsed.success) return fail(400);
		const todo = form.has('done') ? 'done' : 'open';

		const result = await rambles(event).editThought({
			id: parsed.data.id,
			base: parsed.data.revision,
			edit: { todo }
		});

		if (result === 'missing') return fail(404);

		if (result === 'conflict') return fail(409, { conflict: true });
	}
} satisfies Actions;
