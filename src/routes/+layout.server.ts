import { chatgpt } from '$lib/server/app';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ url }) => ({
	chatgpt: url.pathname === '/login' ? null : await chatgpt().status()
});
