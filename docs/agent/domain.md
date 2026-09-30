# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`docs/agent/CONTEXT.md`**: the glossary. This repo has a single context.
- **`docs/agent/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo. All agent docs live under `docs/agent/`, not at the repo root:

```
docs/agent/
├── CONTEXT.md
├── adr/
│   ├── 0001-<decision>.md
│   └── 0002-<decision>.md
├── domain.md
├── issue-tracker.md
└── triage-labels.md
```

`docs/PRODUCT-NOTES.md` (the user's own wording) stays in `docs/`. Files matching `_*.md` are local scratch and are never committed.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
