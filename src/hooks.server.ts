import { env } from '$env/dynamic/private';
import { redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { isValidSession, SESSION_COOKIE } from '$lib/server/auth';

export const init: ServerInit = () => {
	if (!env.APP_PASSWORD) {
		console.warn(
			'APP_PASSWORD is not set: anyone who can reach this server can read and edit everything.'
		);
	}
};

export const handle: Handle = async ({ event, resolve }) => {
	const password = env.APP_PASSWORD;
	if (
		!password ||
		event.url.pathname === '/login' ||
		isValidSession(password, event.cookies.get(SESSION_COOKIE))
	) {
		return resolve(event);
	}
	if (event.url.pathname.startsWith('/api/')) {
		return new Response('Unauthorized', { status: 401 });
	}
	redirect(303, '/login');
};
