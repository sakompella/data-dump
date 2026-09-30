import { env } from '$env/dynamic/private';
import { fail, redirect } from '@sveltejs/kit';
import { chatgpt } from '$lib/server/app';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const auth = chatgpt();
	const status = await auth.status();

	return {
		status,
		signInUrl: (await auth.pendingLogin())?.toString() ?? null,
		redirectUri: auth.redirectUri,
		modelMissing: !env.CHATGPT_MODEL
	};
};

export const actions = {
	start: async () => {
		await chatgpt().startLogin();
		redirect(303, '/connect');
	},
	complete: async ({ request }) => {
		const address = (await request.formData()).get('address');

		if (typeof address !== 'string') return fail(400, { error: 'Paste the full address.' });
		const result = await chatgpt().completeLogin(address);

		if (!result.ok) return fail(400, { error: result.error });
		redirect(303, '/connect');
	},
	disconnect: async () => {
		await chatgpt().disconnect();
		redirect(303, '/connect');
	}
} satisfies Actions;
