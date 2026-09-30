import type { TodoState } from '../shared/domain';
import type { ProposedThought } from '../shared/proposals';

export interface ThoughtCopy {
	readonly label: string;
	readonly body: string;
	readonly todo: TodoState;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Finds the ramble passage the model meant, tolerating whitespace changes only.
// Returns the source slice so the stored copy is the user's exact text.
export function findSourcePassage(
	ramble: string,
	proposal: string
): { start: number; text: string } | null {
	const tokens = proposal.split(/\s+/).filter((token) => token !== '');

	if (tokens.length === 0) return null;
	const match = new RegExp(tokens.map(escapeRegExp).join('\\s+')).exec(ramble);

	return match ? { start: match.index, text: match[0] } : null;
}

const LABEL_WORDS = 5;

export const fallbackLabel = (text: string): string =>
	text.trim().split(/\s+/).slice(0, LABEL_WORDS).join(' ');

export const wholeRambleCopy = (ramble: string): ThoughtCopy => ({
	label: fallbackLabel(ramble),
	body: ramble,
	todo: 'none'
});

export interface KeptPassage {
	readonly start: number;
	readonly end: number;
	readonly copy: ThoughtCopy;
}

// Keeps only proposals that are the user's own words, in ramble order. A proposal
// whose passage is the same as, or inside, one already kept is dropped; passages
// that only partly overlap are kept, each as its own exact slice.
export function keptPassages(ramble: string, proposals: readonly ProposedThought[]): KeptPassage[] {
	const found = proposals.flatMap((proposal) => {
		const passage = findSourcePassage(ramble, proposal.text);

		if (!passage) return [];
		const label = proposal.label.trim() || fallbackLabel(passage.text);
		const todo: TodoState = proposal.todo ? 'open' : 'none';
		const end = passage.start + passage.text.length;

		return [{ start: passage.start, end, copy: { label, body: passage.text, todo } }];
	});

	// Earlier start first, and the longer passage first at the same start, so a
	// passage can only sit inside one that was already kept.
	const ordered = [...found].sort((a, b) => a.start - b.start || b.end - a.end);
	const kept: KeptPassage[] = [];

	for (const passage of ordered) {
		const inside = kept.some((k) => k.start <= passage.start && passage.end <= k.end);

		if (!inside) kept.push(passage);
	}

	return kept;
}

export const copiesFromProposals = (
	ramble: string,
	proposals: readonly ProposedThought[]
): ThoughtCopy[] => keptPassages(ramble, proposals).map(({ copy }) => copy);
