// The only module that knows about the model provider.
import { z } from 'zod';
import type { ProposedThought } from './copies';

export type { ProposedThought };

// Resolves to [] when nothing usable came back. Rejects when the call failed,
// so the caller can retry later instead of falling back.
export type Splitter = (body: string) => Promise<ProposedThought[]>;

type ProviderConfig =
	| { kind: 'none' }
	| { kind: 'openai'; apiKey: string; baseUrl: string; model: string };

export function readProviderConfig(env: Record<string, string | undefined>): ProviderConfig {
	const apiKey = env.OPENAI_API_KEY;
	if (!apiKey) return { kind: 'none' };
	const model = env.OPENAI_MODEL;
	if (!model) throw new Error('OPENAI_API_KEY is set but OPENAI_MODEL is not. Set OPENAI_MODEL.');
	const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
	return { kind: 'openai', apiKey, baseUrl, model };
}

const SYSTEM_PROMPT = `You split a person's ramble into separate thoughts.

Return JSON: {"thoughts": [{"label": string, "text": string, "todo": boolean}]}

Rules:
- One thought per distinct subject. A passing but complete observation is still a thought.
- "text" must be copied verbatim from the ramble: the person's exact words, in order. It may be several sentences or a whole passage. Never paraphrase, summarize, fix, or clean up the wording.
- "label" is a short neutral handle of a few words.
- "todo" is true for any action or possible action, including tentative ones such as "maybe email Michael". A clear commitment is not required.
- Do not invent names, dates, or plans.`;

const completionResponse = z.object({
	choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1)
});

const proposedThought = z.object({ label: z.string(), text: z.string(), todo: z.boolean() });
const thoughtList = z.object({ thoughts: z.array(z.unknown()) });

// Drops malformed items one by one rather than discarding the whole answer.
export function parseModelContent(content: string): ProposedThought[] {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch {
		return [];
	}
	const list = thoughtList.safeParse(json);
	if (!list.success) return [];
	return list.data.thoughts.flatMap((item) => {
		const parsed = proposedThought.safeParse(item);
		return parsed.success ? [parsed.data] : [];
	});
}

class RetryableError extends Error {}

async function requestCompletion(
	config: Extract<ProviderConfig, { kind: 'openai' }>,
	body: string
): Promise<string | null> {
	let response: Response;
	try {
		response = await fetch(`${config.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				model: config.model,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: body }
				]
			})
		});
	} catch (error) {
		throw new RetryableError(`network error: ${String(error)}`);
	}
	if (response.status === 429 || response.status >= 500) {
		throw new RetryableError(`provider returned ${response.status}`);
	}
	if (!response.ok) {
		throw new Error(`provider returned ${response.status}: ${await response.text()}`);
	}
	const parsed = completionResponse.safeParse(await response.json().catch(() => null));
	return parsed.success ? parsed.data.choices[0].message.content : null;
}

export function createSplitter(env: Record<string, string | undefined>): Splitter {
	const config = readProviderConfig(env);
	if (config.kind === 'none') {
		return async () => {
			console.warn('split: no OPENAI_API_KEY configured');
			return [];
		};
	}
	return async (body) => {
		let content: string | null;
		try {
			content = await requestCompletion(config, body);
		} catch (error) {
			if (!(error instanceof RetryableError)) throw error;
			console.warn(`split: ${error.message}; retrying once`);
			content = await requestCompletion(config, body);
		}
		return content === null ? [] : parseModelContent(content);
	};
}
