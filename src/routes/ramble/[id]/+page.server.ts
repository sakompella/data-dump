import { error, fail } from '@sveltejs/kit';
import { parseRambleId } from '$lib/ids';
import { rambles } from '$lib/server/app';
import type { Actions, PageServerLoad } from './$types';

function rambleIdFrom(params: { id: string }) {
	const id = parseRambleId(params.id);
	if (!id) error(404, 'No such ramble');
	return id;
}

export const load: PageServerLoad = async ({ params }) => {
	const found = await (await rambles()).ramble(rambleIdFrom(params));
	if (!found) error(404, 'No such ramble');
	return found;
};

export const actions = {
	save: async ({ params, request }) => {
		const body = (await request.formData()).get('body');
		if (typeof body !== 'string') return fail(400, { invalid: true });
		const found = await (await rambles()).editRamble({ id: rambleIdFrom(params), body });
		if (!found) error(404, 'No such ramble');
		return { saved: true };
	}
} satisfies Actions;
