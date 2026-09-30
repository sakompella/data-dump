import { z } from 'zod';

// What a model proposes; the server keeps only proposals that are the user's own words.
export const proposedThought = z.object({
	label: z.string().max(200),
	text: z.string().max(20_000),
	todo: z.boolean()
});

export type ProposedThought = z.output<typeof proposedThought>;

// Each thought is one R2 write, and a Workers Free request may make only 50
// subrequests in total.
export const MAX_PROPOSALS = 40;
