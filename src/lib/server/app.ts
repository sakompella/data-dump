import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { createChatGPTAuth, type ChatGPTAuth } from './chatgpt-auth';
import { createRambleService, type RambleService } from './rambles';
import { createSplitter } from './splitter';
import { createStore } from './store';

const dataDir = () => env.DATA_DIR || 'data';

let auth: ChatGPTAuth | undefined;

let service: Promise<RambleService> | undefined;

export function chatgpt(): ChatGPTAuth {
	auth ??= createChatGPTAuth({ dir: join(dataDir(), 'auth') });

	return auth;
}

// Built on first use so env is read at runtime, not during `vite build`.
export function rambles(): Promise<RambleService> {
	service ??= (async () => {
		const store = createStore(dataDir());
		await store.init();

		return createRambleService({ store, split: createSplitter({ env, chatgpt: chatgpt() }) });
	})();

	return service;
}
