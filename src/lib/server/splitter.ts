// The only module that knows about the model provider.
import { z } from 'zod';
import type { ChatGPTAuth } from './chatgpt-auth';
import type { ProposedThought } from './copies';

export type { ProposedThought };

// Resolves to [] when nothing usable came back. Rejects when the call failed,
// so the caller can retry later instead of falling back.
export type Splitter = (body: string) => Promise<ProposedThought[]>;

type ApiKeyConfig =
	| { kind: 'none' }
	| { kind: 'openai'; apiKey: string; baseUrl: string; model: string };

export function readProviderConfig(env: Record<string, string | undefined>): ApiKeyConfig {
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
class Unauthorized extends Error {}

async function requestCompletion(
	fetch: typeof globalThis.fetch,
	config: Extract<ApiKeyConfig, { kind: 'openai' }>,
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

async function retryOnce<T>(attempt: () => Promise<T>): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (!(error instanceof RetryableError)) throw error;
		console.warn(`split: ${error.message}; retrying once`);
		return attempt();
	}
}

// Incremental server-sent events parser. Feed it decoded text in any
// chunking, with `last` set on the final call; it returns the data of each
// event completed so far.
export function createSseParser(): (chunk: string, last?: boolean) => string[] {
	let unfinished = '';
	let data: string[] = [];
	return (chunk, last = false) => {
		let text = unfinished + chunk;
		// A trailing CR may be the first half of a CRLF split across chunks.
		const heldCr = !last && text.endsWith('\r');
		if (heldCr) text = text.slice(0, -1);
		const lines = text.split(/\r\n|\r|\n/);
		unfinished = (lines.pop() ?? '') + (heldCr ? '\r' : '');
		const events: string[] = [];
		for (const line of lines) {
			if (line === '') {
				if (data.length > 0) events.push(data.join('\n'));
				data = [];
				continue;
			}
			if (line.startsWith(':')) continue;
			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
			if (field === 'data') data.push(value);
		}
		return events;
	};
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const parse = createSseParser();
	for await (const bytes of body) {
		yield* parse(decoder.decode(bytes, { stream: true }));
	}
	yield* parse(decoder.decode(), true);
}

const streamEvent = z.looseObject({ type: z.string() });
const textDelta = z.object({ delta: z.string() });
const failure = z.object({
	message: z.string().optional(),
	response: z.object({ error: z.object({ message: z.string() }).nullish() }).optional()
});

// Concatenates the output text deltas until the response finishes.
export async function collectOutputText(body: ReadableStream<Uint8Array>): Promise<string> {
	let text = '';
	for await (const data of sseData(body)) {
		if (data === '[DONE]') break;
		let json: unknown;
		try {
			json = JSON.parse(data);
		} catch {
			continue;
		}
		const event = streamEvent.safeParse(json);
		if (!event.success) continue;
		switch (event.data.type) {
			case 'response.output_text.delta': {
				const delta = textDelta.safeParse(json);
				if (delta.success) text += delta.data.delta;
				break;
			}
			case 'response.completed':
			case 'response.incomplete':
				return text;
			case 'response.failed':
			case 'error': {
				const details = failure.safeParse(json);
				const message = details.success
					? (details.data.response?.error?.message ?? details.data.message)
					: undefined;
				throw new Error(`response ${event.data.type}: ${message ?? 'no details'}`);
			}
		}
	}
	throw new Error('response stream ended before the response finished');
}

export const CHATGPT_API_BASE_URL = 'https://api.openai.com/v1';

// Sign in with ChatGPT rejects max_output_tokens, temperature, and prompt
// cache retention/options, so the body carries none of them (as in Pi's
// packages/ai/src/api/openai-responses.ts @ 1b347794).
async function requestResponse(
	fetch: typeof globalThis.fetch,
	{ apiBaseUrl, model, accessToken }: { apiBaseUrl: string; model: string; accessToken: string },
	body: string
): Promise<string> {
	let response: Response;
	try {
		response = await fetch(`${apiBaseUrl}/responses`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${accessToken}`,
				'content-type': 'application/json',
				accept: 'text/event-stream'
			},
			body: JSON.stringify({
				model,
				instructions: SYSTEM_PROMPT,
				input: body,
				stream: true,
				store: false
			})
		});
	} catch (error) {
		throw new RetryableError(`network error: ${String(error)}`);
	}
	if (response.status === 401) throw new Unauthorized('ChatGPT rejected the access token');
	if (response.status === 429 || response.status >= 500) {
		throw new RetryableError(`provider returned ${response.status}`);
	}
	if (!response.ok || !response.body) {
		throw new Error(`provider returned ${response.status}: ${await response.text()}`);
	}
	return collectOutputText(response.body);
}

type ChatGPTTokens = Pick<ChatGPTAuth, 'isConnected' | 'accessToken' | 'accessTokenAfterRejection'>;

export const missingChatGPTModel =
	'ChatGPT is connected but CHATGPT_MODEL is not set. Set CHATGPT_MODEL.';

// Precedence: a connected ChatGPT account, else OPENAI_API_KEY, else none.
// The connection is checked per split because it can change while running.
export function createSplitter({
	env,
	chatgpt,
	fetch = globalThis.fetch,
	chatgptApiBaseUrl = CHATGPT_API_BASE_URL
}: {
	env: Record<string, string | undefined>;
	chatgpt: ChatGPTTokens;
	fetch?: typeof globalThis.fetch;
	chatgptApiBaseUrl?: string;
}): Splitter {
	const apiKey = readProviderConfig(env);
	const chatgptModel = env.CHATGPT_MODEL || null;

	async function viaChatGPT(model: string, body: string): Promise<string> {
		const accessToken = await chatgpt.accessToken();
		const request = { apiBaseUrl: chatgptApiBaseUrl, model, accessToken };
		try {
			return await requestResponse(fetch, request, body);
		} catch (error) {
			if (!(error instanceof Unauthorized)) throw error;
			const fresh = await chatgpt.accessTokenAfterRejection(accessToken);
			return requestResponse(fetch, { ...request, accessToken: fresh }, body);
		}
	}

	return async (body) => {
		if (await chatgpt.isConnected()) {
			if (!chatgptModel) throw new Error(missingChatGPTModel);
			return parseModelContent(await retryOnce(() => viaChatGPT(chatgptModel, body)));
		}
		if (apiKey.kind === 'none') {
			console.warn('split: no ChatGPT connection or OPENAI_API_KEY configured');
			return [];
		}
		const content = await retryOnce(() => requestCompletion(fetch, apiKey, body));
		return content === null ? [] : parseModelContent(content);
	};
}
