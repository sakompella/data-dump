import { chatgpt } from '$lib/server/app';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async () => ({ chatgpt: await chatgpt().status() });
