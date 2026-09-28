import { parse, stringify } from 'yaml';

const OPEN = '---\n';
const CLOSE = '\n---\n';

// The body is kept byte-for-byte after the closing fence, so it may contain
// `---` lines. YAML output never has an unindented `---` line, so the first
// CLOSE is always the real fence.
export function formatDocument(data: Record<string, unknown>, body: string): string {
	const yaml = stringify(data).replace(/\n$/, '');
	return `${OPEN}${yaml}${CLOSE}${body}`;
}

export function parseDocument(text: string): { data: unknown; body: string } | null {
	if (!text.startsWith(OPEN)) return null;
	const close = text.indexOf(CLOSE, OPEN.length - 1);
	if (close === -1) return null;
	try {
		return {
			data: parse(text.slice(OPEN.length, close)),
			body: text.slice(close + CLOSE.length)
		};
	} catch {
		return null;
	}
}
