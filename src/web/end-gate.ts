// Runs `work` for the current capture unless a run for that same capture is
// already going; then the caller shares it. A later capture starts its own run.
export function oncePerGeneration(
	generation: () => number
): (work: () => Promise<void>) => Promise<void> {
	let running: { readonly generation: number; readonly promise: Promise<void> } | null = null;

	return (work) => {
		const current = generation();

		if (running?.generation === current) return running.promise;

		const promise = work().finally(() => {
			if (running?.promise === promise) running = null;
		});

		running = { generation: current, promise };

		return promise;
	};
}
