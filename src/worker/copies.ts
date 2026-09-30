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

// Keeps only proposals that are the user's own words, in ramble order.
export function copiesFromProposals(
	ramble: string,
	proposals: readonly ProposedThought[]
): ThoughtCopy[] {
	return proposals
		.flatMap((proposal) => {
			const passage = findSourcePassage(ramble, proposal.text);

			if (!passage) return [];
			const label = proposal.label.trim() || fallbackLabel(passage.text);
			const todo: TodoState = proposal.todo ? 'open' : 'none';

			return [{ start: passage.start, copy: { label, body: passage.text, todo } }];
		})
		.sort((a, b) => a.start - b.start)
		.map(({ copy }) => copy);
}
