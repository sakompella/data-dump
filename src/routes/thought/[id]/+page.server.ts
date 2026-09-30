import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { parseThoughtId } from '$lib/ids';
import { rambles } from '$lib/server/app';
import { formText, todoState } from '$lib/server/schemas';
import type { Actions, PageServerLoad } from './$types';

const thoughtEdit = z.object({
	label: formText.pipe(z.string().trim()),
	body: formText,
	todo: todoState
});

function thoughtIdFrom(params: { id: string }) {
	const id = parseThoughtId(params.id);

	if (!id) error(404, 'No such thought');

	return id;
}

export const load: PageServerLoad = async ({ params }) => {
	const thought = await (await rambles()).thought(thoughtIdFrom(params));

	if (!thought) error(404, 'No such thought');

	return { thought };
};

export const actions = {
	save: async ({ params, request }) => {
		const edit = thoughtEdit.safeParse(Object.fromEntries(await request.formData()));

		if (!edit.success) return fail(400, { invalid: true });
		const found = await (await rambles()).editThought(thoughtIdFrom(params), edit.data);

		if (!found) error(404, 'No such thought');

		return { saved: true };
	},
	delete: async ({ params }) => {
		await (await rambles()).deleteThought(thoughtIdFrom(params));
		redirect(303, '/');
	}
} satisfies Actions;
