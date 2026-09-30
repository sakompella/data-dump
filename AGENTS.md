# data-dump

A small personal website for dumping messy thoughts and getting them back later.

- Product language lives in `docs/agent/CONTEXT.md`. Use its terms (ramble, thought, to-do).
- Product decisions and the user's own wording live in `docs/PRODUCT-NOTES.md`. Preserve the user's wording; mark tentative ideas as tentative.
- Do not edit `README.md` unless explicitly asked.
- Files matching `_*.md` are local scratch (decision logs, summaries) and are never committed.
- The user's writing is the primary content. Model output supports it and must not replace it.

## Agent skills

### Issue tracker

GitHub Issues on `sakompella/data-dump`, used through the `gh` CLI. See `docs/agent/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agent/triage-labels.md`.

### Domain docs

Single-context. The glossary is `docs/agent/CONTEXT.md` and ADRs go in `docs/agent/adr/`. See `docs/agent/domain.md`.
