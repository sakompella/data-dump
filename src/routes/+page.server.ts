import { fail } from '@sveltejs/kit';
import { rambles } from '$lib/server/app';
import { thoughtId } from '$lib/server/schemas';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const service = await rambles();
	await service.settleOnLoad();
	const { draft, thoughts, waiting } = await service.home();
	return {
		draft: draft && { id: draft.id, body: draft.body, updatedAt: draft.updatedAt },
		thoughts,
		waiting
	};
};

export const actions = {
	toggle: async ({ request }) => {
		const form = await request.formData();
		const id = thoughtId.safeParse(form.get('id'));
		if (!id.success) return fail(400);
		const todo = form.has('done') ? 'done' : 'open';
		const found = await (await rambles()).editThought(id.data, { todo });
		if (!found) return fail(404);
	}
} satisfies Actions;
