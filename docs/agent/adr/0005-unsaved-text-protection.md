# Unsaved text is never lost

Losing the user's writing is the worst failure this app can have, so saving is deliberately more careful than a plain autosave. Several simpler versions lost or duplicated text in review; the regression tests (`*.regression.test.ts` and the jsdom tests in `src/web/`) pin each case. Do not simplify this code without them passing.

- Every ramble and thought has a revision. A stale save of an open ramble updates it only if the new text extends the stored text (a lost reply followed by more typing); otherwise it becomes a new ramble. A stale edit of a page returns a conflict and keeps the typed text.
- Each tab keeps unsaved text in `localStorage`. A backup record is removed only when the server confirmed that exact text, the user discarded it, or it was copied to another key and the copy was read back. A storage failure never deletes a record and never reads as empty. No record is overwritten: each page mount writes to a fresh key.
- Editors stay read-only until recovery finishes. Leaving a page flushes its pending save. "New ramble" freezes the old capture's text before saving and ending it.

## Consequences

- Backups from old tabs and mounts stay in `localStorage` until they are restored or discarded. A recovery list for them is not built yet.
