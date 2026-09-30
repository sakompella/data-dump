import { hc, type InferResponseType } from 'hono/client';
import type { AppType } from '../worker/app';
import { session } from './session.svelte';
import { sessionAwareFetch } from './session-fetch';

export const api = hc<AppType>('/', {
	fetch: sessionAwareFetch(fetch, () => (session.expired = true))
}).api;

export type HomeData = InferResponseType<typeof api.home.$get, 200>;

export type ThoughtData = HomeData['thoughts'][number];

// The model name is fixed for a deployment, so it is asked for once.
let model: Promise<string | null> | undefined;

export function chatgptModel(): Promise<string | null> {
	model ??= (async () => {
		try {
			const res = await api.config.$get();

			return res.ok ? (await res.json()).chatgptModel : null;
		} catch {
			return null;
		}
	})();

	return model;
}
