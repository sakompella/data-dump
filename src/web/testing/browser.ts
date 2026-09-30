import { createApp } from '../../worker/app';
import { createFakeNamespace } from '../../worker/testing/fake-namespace';

type LockCallback<Result> = (lock: { name: string } | null) => Result | Promise<Result>;

// Stands in for navigator.locks: exclusive locks by name, held until the
// callback's promise settles. `ifAvailable` probes wait for `probeGate`,
// so a test can act while a probe is still pending.
export function createFakeLockManager() {
	const held = new Set<string>();
	const queues = new Map<string, (() => void)[]>();
	let probeGate: Promise<void> = Promise.resolve();

	async function hold<Result>(name: string, callback: LockCallback<Result>): Promise<Result> {
		held.add(name);

		try {
			return await callback({ name });
		} finally {
			held.delete(name);
			queues.get(name)?.shift()?.();
		}
	}

	async function request<Result>(
		name: string,
		optionsOrCallback: { ifAvailable?: boolean } | LockCallback<Result>,
		maybeCallback?: LockCallback<Result>
	): Promise<Result> {
		const callback = optionsOrCallback instanceof Function ? optionsOrCallback : maybeCallback;
		const ifAvailable = !(optionsOrCallback instanceof Function) && optionsOrCallback.ifAvailable;

		if (!callback) throw new Error('lock request without a callback');

		if (ifAvailable) {
			await probeGate;

			return held.has(name) ? callback(null) : hold(name, callback);
		}

		if (held.has(name)) {
			await new Promise<void>((resolve) =>
				queues.set(name, [...(queues.get(name) ?? []), resolve])
			);
		}

		return hold(name, callback);
	}

	return {
		request,
		held: () => [...held],
		// Holds every `ifAvailable` probe until the returned function is called.
		pauseProbes(): () => void {
			let release = () => {};

			probeGate = new Promise<void>((resolve) => (release = resolve));

			return release;
		}
	};
}

export const DEV_USER = 'me';

// A fetch that answers from the real Hono app and in-memory user data, as
// `vite dev` does with DEV_USER_ID. `afterReply` runs once a request has been
// answered and before the browser sees the reply.
export function createServedApp() {
	const namespace = createFakeNamespace();
	const app = createApp({ dev: true });
	const env = { USER_DATA: namespace, DEV_USER_ID: DEV_USER };
	let afterReply: (request: { method: string; path: string }) => Promise<void> = async () => {};

	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
			'http://localhost'
		);

		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		const response = await app.request(url.pathname + url.search, { ...init, method }, env);
		await afterReply({ method, path: url.pathname });

		return response;
	};

	return {
		fetch,
		data: () => namespace.getByName(DEV_USER),
		setAfterReply(hook: typeof afterReply) {
			afterReply = hook;
		},
		close: () => namespace.close()
	};
}

// Lets every queued promise and DOM update run. Each round is one macrotask,
// which drains the whole microtask queue; no wall-clock time passes.
export async function settle(rounds = 10): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
