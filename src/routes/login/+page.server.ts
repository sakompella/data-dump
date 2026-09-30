import { env } from '$env/dynamic/private';
import { fail, redirect } from '@sveltejs/kit';
import { isValidSession, SESSION_COOKIE, sessionToken } from '$lib/server/auth';
import type { Actions } from './$types';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export const actions = {
	default: async ({ request, cookies, url }) => {
		const password = env.APP_PASSWORD;

		if (!password) redirect(303, '/');
		const attempt = (await request.formData()).get('password');
		const token = typeof attempt === 'string' ? sessionToken(attempt) : undefined;

		if (!isValidSession(password, token)) return fail(400, { wrong: true });
		cookies.set(SESSION_COOKIE, sessionToken(password), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: ONE_YEAR_SECONDS
		});
		redirect(303, '/');
	}
} satisfies Actions;
