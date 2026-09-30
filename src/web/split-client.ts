import { api } from './api';
import { browserLock, createChatGPTAuth } from './chatgpt/auth';
import { splitWithChatGPT } from './chatgpt/splitter';
import type { RambleId } from '../shared/domain';
import type { Revision } from '../shared/ids';
import type { ProposedThought } from '../shared/proposals';

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
	ramble: { id: RambleId; body: string; revision: Revision };
	model: string | null;
}): Promise<void> {
	const proposals = await propose(ramble.body, model);

	if (proposals === null) return;

	try {
		const response = await api.ramble.split.$post({
			json: { id: ramble.id, revision: ramble.revision, proposals }
		});

		if (!response.ok) console.warn(`split: finishing failed with status ${response.status}`);
	} catch (error) {
		console.warn('split: finishing failed', error);
	}
}
