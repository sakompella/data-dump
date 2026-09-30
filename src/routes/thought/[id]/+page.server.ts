import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { parseThoughtId } from '$lib/ids';
import { rambles } from '$lib/server/app';
import { formText, revision, todoState } from '$lib/server/schemas';
import type { Actions, PageServerLoad } from './$types';

const thoughtEdit = z.object({
	label: formText.pipe(z.string().trim()),
	body: formText,
	todo: todoState,
	revision
});

const thoughtDelete = z.object({ revision });

function thoughtIdFrom(params: { id: string }) {
	const id = parseThoughtId(params.id);

	if (!id) error(404, 'No such thought');

	return id;
}

export const load: PageServerLoad = async (event) => {
	const thought = await rambles(event).thought(thoughtIdFrom(event.params));

	if (!thought) error(404, 'No such thought');

	return { thought };
};

export const actions = {
	save: async (event) => {
		const parsed = thoughtEdit.safeParse(Object.fromEntries(await event.request.formData()));

		if (!parsed.success) return fail(400, { invalid: true });
		const { revision: base, ...edit } = parsed.data;

		const result = await rambles(event).editThought({
			id: thoughtIdFrom(event.params),
			base,
			edit
		});

		if (result === 'missing') error(404, 'No such thought');

		if (result === 'conflict') return fail(409, { conflict: true, edit });

		return { saved: true };
	},
	delete: async (event) => {
		const parsed = thoughtDelete.safeParse(Object.fromEntries(await event.request.formData()));

		if (!parsed.success) return fail(400, { invalid: true });

		const result = await rambles(event).deleteThought({
			id: thoughtIdFrom(event.params),
			base: parsed.data.revision
		});

		if (result === 'conflict') return fail(409, { conflict: true });
		redirect(303, '/');
	}
} satisfies Actions;
