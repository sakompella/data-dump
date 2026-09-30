import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ProposedThought } from '../../shared/proposals';
import {
	collectOutputText,
	createSseParser,
	parseModelContent,
	splitWithChatGPT
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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const sseText = (payloads: string[], newline = '\n') =>
	payloads.map((payload) => `data: ${payload}${newline}${newline}`).join('');

const sseEvents = (events: JsonValue[], newline = '\n') =>
	sseText(
		events.map((event) => JSON.stringify(event)),
		newline
	);

const deltaEvents = (deltas: string[]): JsonValue[] => [
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
					const events = sseEvents(deltaEvents(deltas), newline);
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
		const stream = streamOf([encoder.encode(sseEvents([failed]))]);
		await expect(collectOutputText(stream)).rejects.toThrow('quota');
	});

	it('rejects a stream that stops before the response finishes', async () => {
		const partial = sseText([
			JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }),
			'[DONE]'
		]);

		await expect(collectOutputText(streamOf([encoder.encode(partial)]))).rejects.toThrow();
	});
});

const PROPOSALS: ProposedThought[] = [{ label: 'Rev', text: 'Rev keeps stalling.', todo: false }];

const modelAnswer = JSON.stringify({ thoughts: PROPOSALS });

type Call = { url: string; token: string | null; body: { [key: string]: JsonValue } };

// Replies to /responses with scripted statuses, then with a streamed answer.
function fakeApi(statuses: number[]) {
	const calls: Call[] = [];

	const fetch: typeof globalThis.fetch = async (input, init) => {
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(input),
			token: headers.get('authorization'),
			body: JSON.parse(String(init?.body))
		});
		const status = statuses.shift() ?? 200;

		if (status !== 200) return new Response('nope', { status });
		const deltas = [modelAnswer.slice(0, 7), modelAnswer.slice(7)];

		return new Response(sseEvents(deltaEvents(deltas)), {
			headers: { 'content-type': 'text/event-stream' }
		});
	};

	return { fetch, calls };
}

function fakeTokens() {
	const tokens = { current: 'token-1', refreshes: 0 };

	return {
		tokens,
		chatgpt: {
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

const split = (api: ReturnType<typeof fakeApi>, tokens = fakeTokens().chatgpt, body = 'x') =>
	splitWithChatGPT({ body, model: 'gpt-test', tokens, fetch: api.fetch, apiBaseUrl: API });

describe('splitWithChatGPT', () => {
	it('sends only the fields a ChatGPT token accepts', async () => {
		const api = fakeApi([]);
		expect(await split(api, undefined, 'Rev keeps stalling.')).toEqual(PROPOSALS);
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

	it('refreshes once on a 401 and retries with the new token', async () => {
		const api = fakeApi([401]);
		const { chatgpt, tokens } = fakeTokens();
		expect(await split(api, chatgpt)).toEqual(PROPOSALS);
		expect(tokens.refreshes).toBe(1);
		expect(api.calls.map((call) => call.token)).toEqual(['Bearer token-1', 'Bearer token-2']);
	});

	it('rejects after a second 401', async () => {
		const api = fakeApi([401, 401]);
		await expect(split(api)).rejects.toThrow();
		expect(api.calls).toHaveLength(2);
	});

	it('retries a 5xx once, then rejects', async () => {
		const api = fakeApi([503, 503]);
		await expect(split(api)).rejects.toThrow('503');
		expect(api.calls).toHaveLength(2);
	});

	it('rejects a 4xx without retrying', async () => {
		const api = fakeApi([400]);
		await expect(split(api)).rejects.toThrow('400');
		expect(api.calls).toHaveLength(1);
	});
});

describe('parseModelContent', () => {
	it('keeps well-formed items and ignores the rest', () => {
		const content = JSON.stringify({
			thoughts: [{ label: 'a', text: 'b', todo: true }, { label: 1 }, 'nope']
		});

		expect(parseModelContent(content)).toEqual([{ label: 'a', text: 'b', todo: true }]);
	});

	it('returns nothing for unusable output', () => {
		expect(parseModelContent('not json')).toEqual([]);
		expect(parseModelContent('{"items": []}')).toEqual([]);
	});

	it('drops oversized items and caps the count so the server accepts the list', () => {
		const item = { label: 'a', text: 'b', todo: false };
		const huge = { ...item, text: 'x'.repeat(20_001) };
		const content = JSON.stringify({ thoughts: [huge, ...Array(150).fill(item)] });
		expect(parseModelContent(content)).toEqual(Array(100).fill(item));
	});
});
