import { dev } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { identify } from '$lib/server/access';

export const handle: Handle = async ({ event, resolve }) => {
	const identity = await identify({
		dev,
		env: event.platform?.env ?? {},
		token: event.request.headers.get('cf-access-jwt-assertion')
	});

	if (!identity.ok) {
		console.warn(`access denied: ${identity.reason}`);
		const status = event.url.pathname.startsWith('/api/') ? 401 : 403;

		return new Response(status === 401 ? 'Unauthorized' : 'Forbidden', { status });
	}

	event.locals.userId = identity.userId;

	return resolve(event);
};
