import { env } from '$env/dynamic/private';
import { createRambleService, type RambleService } from './rambles';
import { createSplitter } from './splitter';
import { createStore } from './store';

let service: Promise<RambleService> | undefined;

// Built on first use so env is read at runtime, not during `vite build`.
export function rambles(): Promise<RambleService> {
	service ??= (async () => {
		const store = createStore(env.DATA_DIR || 'data');
		await store.init();
		return createRambleService({ store, split: createSplitter(env) });
	})();
	return service;
}
