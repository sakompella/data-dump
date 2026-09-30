import type { LayoutServerLoad } from './$types';

// The browser splits rambles through ChatGPT, so it needs the model name.
export const load: LayoutServerLoad = ({ platform }) => ({
	chatgptModel: platform?.env.PUBLIC_CHATGPT_MODEL || null
});
