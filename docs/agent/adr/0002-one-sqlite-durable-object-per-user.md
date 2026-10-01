# One SQLite Durable Object per user

All of a user's rambles and thoughts live in one SQLite-backed Durable Object (`UserData`), addressed by the user's Access subject. The object handles one request at a time and every rule runs as synchronous SQL in `src/worker/rules.ts`, so saving, ending, and splitting are each one transaction. Revisions on every row reject stale writes.

## Considered options

- Markdown files with YAML frontmatter in R2: built and tested, then replaced. R2 has no multi-key transactions, deletes cannot be conditional, and a key accepts at most one write per second, so it needed etag-conditional writes, split publication ids, tombstones, and rate-limit retries.
- Workers KV: eventually consistent (changes can take 60 seconds or more to appear elsewhere) and no atomic operations. Wrong for autosave.
- A Markdown mirror in R2 next to the object: dropped. The user does not need files ("we dont have to store markdown files"); an export can come later.
- D1 was not evaluated in depth.

## Consequences

- There are no files outside the app. Getting data out needs an export feature.
- Schema migrations in `rules.ts` are append-only once deployed. Nothing has been deployed yet, so version 1 can still change until the first deploy.
