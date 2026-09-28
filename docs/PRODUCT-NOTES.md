# Product notes

These notes preserve the user's product thinking. Exploratory statements are not settled requirements.

## 2026-09-29: Writing, rambles, and possible actions

### User's wording

> A ramble is defined as just a contiguous string of streams that may have any number of thoughts or tasks or whatever associated with it. I'm not sure what really splits them from each other but I guess it would mostly be by topic and time. Waiting a whole day for the same ramble is totally egregious. You can connect different parts together but it's egregious. I just want to reemphasize that we totally want to refocus on what I write rather than what the agent writes or synthesis or whatever. The focus is on what I write/say. So again on the ramble, maybe it's a combination of just time and topic. I don't know. Maybe it's like a new file but a new ramble where I'm marking off that there are different splits. I don't know. The annoying answer is that it depends.

> Those should probably all end up as different things but again I want to reemphasize that my writing, not the agent summary, not agent synthesis, is important. My writing, my ability to think, my thoughts, etc. Part of the focus is on making sure that I am able to continue being able to critically think.

> That is a v0.2 problem. I don't know, a daily reminder or something. I don't know, 1 midday, 1 at night. I don't know, that's not set in stone. That's the later problem.

> The first should be resurfaced as something I need to take action on at some point. Maybe I need to do a triage system or something. I don't know, but that seems like too much work for v0.1. Both should probably go to to-dos. Clear commitment should not be necessary.

> Also not all of these should become ADRs. Some of them should just be maybe background writing. Please preserve my thoughts as closely as you can. ADR for the thing that I am sure of.

### Context for the references above

- “Those” refers to distinct subjects within one ramble, such as Rev, an EA argument, and replying to Michael.
- “That is a v0.2 problem” refers to external reminders that bring the user back to the app. Midday and nighttime are possibilities, not a chosen schedule.
- “The first” refers to “Maybe email Michael,” compared with “I need to email Michael.” Both may belong in to-dos without presenting the tentative action as a firm commitment.

### Settled direction

- The user's writing and speech are the primary content. Organization and model responses support remembering and continuing the user's thinking.
- Clear commitment is not required for inclusion in to-dos.
- External reminders are deferred to v0.2; their schedule is undecided.

### Still open

- How time, topic, and explicit user splits determine ramble boundaries. Leaving an entry open until the following day is not an acceptable default.
- How separate thoughts remain connected to the original ramble and to related thoughts elsewhere.
- Whether a triage mechanism is useful later. It is not a requirement for v0.1.
- Earlier discussion labeled text capture with imperfect transcripts “v0.2”; the latest discussion refers to a v0.1 without triage or reminders. The complete release boundary has not been settled.

## 2026-09-29: Thoughts drawn from a ramble

### Question asked

When one ramble covers several subjects (Rev, the EA argument, "maybe email Michael"), is each resulting thought an independent editable copy, or a view onto the intact ramble at the relevant passage?

### User's wording

> One original, many views makes the best sense down the line but for a v0.1 copy, makes the best sense.

### Settled direction

- v0.1: each thought drawn from a ramble is its own editable copy. Editing a thought does not change the ramble.
- Later: one original with many views is the preferred long-term model.

### Consequences to keep in mind (not decisions)

- Moving from copies to views later is harder once copies have been edited. Keeping the ramble unchanged and remembering which ramble each thought came from keeps that move possible.
- If thoughts are copied from a ramble that is still being written, re-copying could overwrite edits. When copying happens therefore depends on when a ramble ends.

## Background from the earlier Codex thread

Recorded after rereading the source thread; neither item is a requirement.

- On opening an unresolved thread, the user earlier wrote: "Short synthesis: original passages are not as important unless I go back explicitly to go read it." The later message puts the user's own writing first. Read together: the user's words are the content, but the full original need not always be in view.
- Reading material came up early: a Readwise backlog, links seen on Twitter, occasional PDFs. Scope for reading material has not been discussed.

## 2026-09-29: v0.1 scope round

### User's wording

> 1. new ramble action + gap of some time (10m?)
> 2. yea
> 3. yea. idk yaml frontmatter markdown?
> 4. yea idk. no backlink forced updates for now
> 5. Bish
> 6. focus on desktop frinedly web, mobile friendly web later. this is v0.1, real MVP stuff.
> 7. idk man maybe skil
> 8. skip for now
> 9. ??
> 10. ?? wtf is "version 1" nevr said any shit. v0.1 is a bare minimum viable product stuff

### Context for the answers

1. What ends a ramble.
2. The model splits a ramble into thoughts in the background; the user corrects mistakes.
3. Whether a copied thought links back to its ramble. The user floated Markdown with YAML frontmatter as the way to record that link.
4. Whether the ramble stays editable after thoughts are copied from it.
5. Default thought display. Read as "B-ish": the user's copied sentences with a short model-written label above them.
6. Target devices.
7. How half-remembered thoughts are found. Read as "maybe skip".
8. Unprompted resurfacing of older thoughts inside the app.
9. Model help with thinking (pushback, steelmanning). The question was unclear; re-ask plainly.
10. "Version 1" was an assistant's phrase that the user had annotated "v0.2". The user does not use it as a release name.

### Settled direction

- v0.1 is the bare minimum viable product.
- A ramble ends on an explicit new-ramble action or after an idle gap, roughly 10 minutes. The number is tentative.
- The model splits rambles into thoughts without asking; the user corrects.
- Each thought keeps a link to its source ramble.
- Rambles stay editable. Edits to a ramble do not update thoughts already copied from it, and edits to a thought do not update the ramble.
- v0.1 targets desktop web. Mobile-friendly web comes later.
- Search and in-app resurfacing are out of v0.1.

### Still open

- Storage format. Markdown with YAML frontmatter was suggested, not decided.
- Thinking help is parked as not MVP. The user said "ask me only MVP stuff"; parking it was the assistant's call, and the user may object.
