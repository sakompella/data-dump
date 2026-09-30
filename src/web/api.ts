import { hc, type InferResponseType } from 'hono/client';
import type { AppType } from '../worker/app';

export const api = hc<AppType>('/').api;

export type HomeData = InferResponseType<typeof api.home.$get, 200>;

export type ThoughtData = HomeData['thoughts'][number];

export type ConfigData = InferResponseType<typeof api.config.$get, 200>;

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
