import { browserLock, createChatGPTAuth } from '$lib/chatgpt/auth';
import { splitWithChatGPT } from '$lib/chatgpt/splitter';
import type { RambleId } from '$lib/ids';
import type { ProposedThought } from '$lib/proposals';

export const chatgptAuth = () =>
	createChatGPTAuth({ storage: localStorage, withLock: browserLock });

// Proposals to send, or null to leave the ramble ended for a later retry.
async function propose(body: string, model: string | null): Promise<ProposedThought[] | null> {
	const auth = chatgptAuth();
	const status = auth.status();

	// Without ChatGPT the whole ramble becomes one thought.
	if (status === 'not-connected') return [];

	if (status === 'needs-reconnect' || !model) {
		console.warn(`split: waiting (${model ? 'ChatGPT needs a reconnect' : 'no model set'})`);

		return null;
	}

	try {
		return await splitWithChatGPT({ body, model, tokens: auth });
	} catch (error) {
		console.warn('split: ChatGPT call failed; the ramble stays ended for a later retry', error);

		return null;
	}
}

// Splits an ended ramble in the browser and hands the proposals to the
// Worker, which copies and publishes them. Never throws: any failure leaves
// the ramble ended, and the home page retries it on its next load.
export async function splitRamble({
	ramble,
	model
}: {
	ramble: { id: RambleId; body: string };
	model: string | null;
}): Promise<void> {
	const proposals = await propose(ramble.body, model);

	if (proposals === null) return;

	try {
		const response = await fetch('/api/ramble/split', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id: ramble.id, attempt: crypto.randomUUID(), proposals })
		});

		if (!response.ok) console.warn(`split: finishing failed with status ${response.status}`);
	} catch (error) {
		console.warn('split: finishing failed', error);
	}
}
