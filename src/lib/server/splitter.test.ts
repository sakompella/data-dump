import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	collectOutputText,
	createSplitter,
	createSseParser,
	missingChatGPTModel,
	type ProposedThought
} from './splitter';

const API = 'https://api.test/v1';

const encoder = new TextEncoder();

const streamOf = (chunks: Uint8Array[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		}
	});

const sseText = (payloads: unknown[], newline = '\n') =>
	payloads
		.map(
			(payload) =>
				`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}${newline}${newline}`
		)
		.join('');

const deltaEvents = (deltas: string[]) => [
	{ type: 'response.created' },
	...deltas.map((delta) => ({ type: 'response.output_text.delta', delta })),
	{ type: 'response.completed', response: { status: 'completed' } }
];

describe('createSseParser', () => {
	it('joins multi-line data and skips comments and other fields', () => {
		const parse = createSseParser();
		expect(parse(': keep-alive\nevent: x\nid: 1\ndata: a\ndata:b\n\n')).toEqual(['a\nb']);
		expect(parse('data: open')).toEqual([]);
		expect(parse('\r')).toEqual([]);
		expect(parse('\n\r\n')).toEqual(['open']);
	});
});

describe('collectOutputText', () => {
	it('yields the same text for any chunking, line ending, and comment placement', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.string({ unit: 'binary' }), { maxLength: 6 }),
				fc.constantFrom('\n', '\r\n', '\r'),
				fc.boolean(),
				fc.boolean(),
				fc.array(fc.nat(), { maxLength: 12 }),
				async (deltas, newline, withComment, withDone, cuts) => {
					const events = sseText(deltaEvents(deltas), newline);
					const comment = withComment ? `: ping${newline}` : '';
					const done = withDone ? sseText(['[DONE]'], newline) : '';
					const bytes = encoder.encode(comment + events + done);

					const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort(
						(a, b) => a - b
					);

					const chunks = [0, ...points, bytes.length]
						.slice(1)
						.map((end, i, ends) => bytes.slice(i === 0 ? 0 : ends[i - 1], end));

					expect(await collectOutputText(streamOf(chunks))).toBe(deltas.join(''));
				}
			)
		);
	});

	it('rejects a failed response', async () => {
		const failed = { type: 'response.failed', response: { error: { message: 'quota' } } };
		const stream = streamOf([encoder.encode(sseText([failed]))]);
		await expect(collectOutputText(stream)).rejects.toThrow('quota');
	});

	it('rejects a stream that stops before the response finishes', async () => {
		const partial = sseText([{ type: 'response.output_text.delta', delta: 'x' }, '[DONE]']);
		await expect(collectOutputText(streamOf([encoder.encode(partial)]))).rejects.toThrow();
	});
});

const PROPOSALS: ProposedThought[] = [{ label: 'Rev', text: 'Rev keeps stalling.', todo: false }];

const modelAnswer = JSON.stringify({ thoughts: PROPOSALS });

type Call = { url: string; token: string | null; body: Record<string, unknown> };

// Routes /responses to scripted statuses; other calls are recorded as chat completions.
function fakeApi(statuses: number[]) {
	const calls: Call[] = [];

	const fetch: typeof globalThis.fetch = async (input, init) => {
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(input),
			token: headers.get('authorization'),
			body: JSON.parse(String(init?.body))
		});

		if (String(input).endsWith('/chat/completions')) {
			return Response.json({ choices: [{ message: { content: modelAnswer } }] });
		}

		const status = statuses.shift() ?? 200;

		if (status !== 200) return new Response('nope', { status });
		const deltas = [modelAnswer.slice(0, 7), modelAnswer.slice(7)];

		return new Response(sseText(deltaEvents(deltas)), {
			headers: { 'content-type': 'text/event-stream' }
		});
	};

	return { fetch, calls };
}

function fakeTokens(connected: boolean) {
	const tokens = { current: 'token-1', refreshes: 0 };

	return {
		tokens,
		chatgpt: {
			isConnected: async () => connected,
			accessToken: async () => tokens.current,
			accessTokenAfterRejection: async (rejected: string) => {
				if (rejected === tokens.current) {
					tokens.refreshes += 1;
					tokens.current = `token-${tokens.refreshes + 1}`;
				}

				return tokens.current;
			}
		}
	};
}

const env = { CHATGPT_MODEL: 'gpt-test', OPENAI_API_KEY: 'sk-key', OPENAI_MODEL: 'api-model' };

describe('createSplitter', () => {
	it('prefers a connected ChatGPT account and sends only the fields it accepts', async () => {
		const api = fakeApi([]);

		const split = createSplitter({
			env,
			chatgpt: fakeTokens(true).chatgpt,
			fetch: api.fetch,
			chatgptApiBaseUrl: API
		});

		expect(await split('Rev keeps stalling.')).toEqual(PROPOSALS);
		expect(api.calls).toHaveLength(1);
		expect(api.calls[0].url).toBe(`${API}/responses`);
		expect(api.calls[0].token).toBe('Bearer token-1');
		expect(Object.keys(api.calls[0].body).sort()).toEqual(
			['input', 'instructions', 'model', 'store', 'stream'].sort()
		);
		expect(api.calls[0].body).toMatchObject({
			model: 'gpt-test',
			input: 'Rev keeps stalling.',
			stream: true,
			store: false
		});
	});

	it('uses the API key when ChatGPT is not connected', async () => {
		const api = fakeApi([]);
		const split = createSplitter({ env, chatgpt: fakeTokens(false).chatgpt, fetch: api.fetch });
		expect(await split('Rev keeps stalling.')).toEqual(PROPOSALS);
		expect(api.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
	});

	it('returns nothing when neither is configured', async () => {
		const split = createSplitter({ env: {}, chatgpt: fakeTokens(false).chatgpt });
		expect(await split('x')).toEqual([]);
	});

	it('rejects when ChatGPT is connected but no model is set', async () => {
		const split = createSplitter({ env: {}, chatgpt: fakeTokens(true).chatgpt });
		await expect(split('x')).rejects.toThrow(missingChatGPTModel);
	});

	it('refreshes once on a 401 and retries with the new token', async () => {
		const api = fakeApi([401]);
		const { chatgpt, tokens } = fakeTokens(true);
		const split = createSplitter({ env, chatgpt, fetch: api.fetch, chatgptApiBaseUrl: API });
		expect(await split('Rev keeps stalling.')).toEqual(PROPOSALS);
		expect(tokens.refreshes).toBe(1);
		expect(api.calls.map((call) => call.token)).toEqual(['Bearer token-1', 'Bearer token-2']);
	});

	it('rejects after a second 401', async () => {
		const api = fakeApi([401, 401]);

		const split = createSplitter({
			env,
			chatgpt: fakeTokens(true).chatgpt,
			fetch: api.fetch,
			chatgptApiBaseUrl: API
		});

		await expect(split('x')).rejects.toThrow();
		expect(api.calls).toHaveLength(2);
	});

	it('retries a 5xx once, then rejects', async () => {
		const api = fakeApi([503, 503]);

		const split = createSplitter({
			env,
			chatgpt: fakeTokens(true).chatgpt,
			fetch: api.fetch,
			chatgptApiBaseUrl: API
		});

		await expect(split('x')).rejects.toThrow('503');
		expect(api.calls).toHaveLength(2);
	});

	it('rejects a 4xx without retrying', async () => {
		const api = fakeApi([400]);

		const split = createSplitter({
			env,
			chatgpt: fakeTokens(true).chatgpt,
			fetch: api.fetch,
			chatgptApiBaseUrl: API
		});

		await expect(split('x')).rejects.toThrow('400');
		expect(api.calls).toHaveLength(1);
	});
});
