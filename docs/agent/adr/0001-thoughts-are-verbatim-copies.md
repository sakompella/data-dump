# Thoughts are verbatim copies of the user's words

The user's writing is the content; model output must not replace it. When a ramble is split, the model only proposes which passages belong together and a short label. The Worker keeps a proposal only if its text is found in the ramble (whitespace differences tolerated) and stores the exact source slice, never the model's text. If nothing usable comes back, the whole ramble becomes one thought. A proposal is dropped only when its passage is identical to or inside one already kept; partial overlaps stay as separate slices, so no distinct passage is lost. Labels may be generated.

For v0.1 each thought is its own copy: editing a thought does not change its ramble, and editing a ramble does not change thoughts already copied from it. The user chose copies now and "one original, many views" later.

## Considered options

- Summaries or a generated synthesis as the stored thought: rejected by the user ("my writing, not the agent summary").
- Thoughts as views onto one editable original: preferred long term, deferred because copies are simpler for v0.1.
