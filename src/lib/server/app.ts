import type { RequestEvent } from '@sveltejs/kit';
import { createRambleService, type RambleService } from './rambles';
import { createStore } from './store';

// Built per request: the bucket binding and the user both come with the request.
export function rambles(event: Pick<RequestEvent, 'platform' | 'locals'>): RambleService {
	if (!event.platform) throw new Error('Cloudflare bindings are missing: no platform.env');
	const store = createStore({ bucket: event.platform.env.DATA, userId: event.locals.userId });

	return createRambleService({ store });
}
