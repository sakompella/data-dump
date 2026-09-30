import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { parseRambleId } from '$lib/ids';
import { rambles } from '$lib/server/app';
import { formText, revision } from '$lib/server/schemas';
import type { Actions, PageServerLoad } from './$types';

const rambleEdit = z.object({ body: formText, revision });

function rambleIdFrom(params: { id: string }) {
	const id = parseRambleId(params.id);

	if (!id) error(404, 'No such ramble');

	return id;
}

export const load: PageServerLoad = async (event) => {
	const found = await rambles(event).ramble(rambleIdFrom(event.params));

	if (!found) error(404, 'No such ramble');

	return found;
};

export const actions = {
	save: async (event) => {
		const form = await event.request.formData();
		const edit = rambleEdit.safeParse({ body: form.get('body'), revision: form.get('revision') });

		if (!edit.success) return fail(400, { invalid: true });

		const result = await rambles(event).editRamble({
			id: rambleIdFrom(event.params),
			body: edit.data.body,
			base: edit.data.revision
		});

		if (result === 'missing') error(404, 'No such ramble');

		if (result === 'conflict') return fail(409, { conflict: true, body: edit.data.body });

		return { saved: true };
	}
} satisfies Actions;
