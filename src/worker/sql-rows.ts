import { z } from 'zod';

// The schema stores only text, integers, and nulls; anything else is a bug.
export const sqlRows = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])));
