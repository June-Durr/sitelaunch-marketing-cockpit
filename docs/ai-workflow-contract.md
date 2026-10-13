# The AI drafting contract

What an assistant inside the Cockpit is allowed to read, allowed to write, and
required to refuse. Written before the feature exists, because the rules are the
hard part and the chat window is not.

Nothing described here is built yet. There is no AI chat in the Cockpit and no
Gmail integration. This document says what the existing workflow has been made
ready for, so that the thing built on top of it cannot quietly invent history.

---

## 1. What it reads before it drafts anything

In this order, every time:

1. **The lead as it is now.** Name, organisation, relationship, stage, preferred
   channel, follow-up mode, and whether identity is confirmed.
2. **The ordered history.** Every `activity_events` row for that lead, oldest
   first, with its `occurred_at`, `channel`, `evidence_source` and
   `approved_message` where one was stored. A row carrying `reversed_at` is
   read as a correction, not as something that happened.
3. **The evidence behind each of those.** `evidence_source` says where the claim
   came from: a screenshot, an email thread, or somebody's recollection. A draft
   that leans on a recollection should say so.
4. **The open follow-up task**, its due date, and why the rule set that date.

Drafting without reading the history is how an assistant writes "just following
up again" to somebody who has never been contacted.

## 2. Corrections from the person always win

When a person says something that contradicts the record, the person is right
and the record changes:

- The correction is **persisted**, not held in the conversation. A fact that
  lives only in a chat transcript is a fact the next session does not have.
- It is written against the **stable lead key** (`external_key`), not against a
  name, so a renamed lead keeps its history.
- The previous value is preserved where it mattered, through the same reversal
  machinery that `undo_task_operation` uses: "this turned out to be wrong" is
  itself a record.

## 3. One focused question, not an interrogation

When identity, channel or history is missing or self-contradictory, the
assistant asks **one** question and names exactly what it needs:

> I have two different contact names for Groovin' Bean. Which should I use?

It does not ask three questions, and it does not ask a question it could answer
by reading. If the answer does not arrive, it does not proceed on a guess: it
produces a **History needs confirmation** task and leaves the lead out of the
ready-to-contact queue.

## 4. Evidence is optional and takes any shape

Uploading a screenshot is one option among several, never a requirement. The
assistant accepts, with equal standing:

- pasted text of a conversation,
- a summary in the person's own words,
- a cropped or redacted screenshot,
- nothing at all, in which case it works from what is already recorded.

Whatever arrives, facts are extracted **with a source and a confidence**, and
both are stored. A fact read off a screenshot is not the same kind of fact as
one somebody half-remembers, and flattening the two is how a maybe becomes a
yes.

Imported evidence is **deduplicated against known history** before anything is
written. The same screenshot uploaded twice adds nothing the second time.

## 5. What it must never do

- **Invent a date.** If only a month is known, the record says the month.
- **Invent a reply.** Silence is silence. "No response visible" is a finding.
- **Invent a price, an identity, or a deliverable.**
- **Infer that a message was sent.** Copying a draft is not sending it. Opening
  a mail client is not sending it. Pressing Next in a chat is not sending it.
  The only thing that records a send is a person saying so.

That last one is not hypothetical. On 2026-10-12 four completions were recorded
for messages that had not been sent, and unpicking which was which took a
conversation. The rule exists because the cost of breaking it is already known.

## 6. "I sent this" is the trigger

When a person confirms a send, and only then:

1. The **exact approved wording** is stored in `activity_events.approved_message`,
   separately from any summary, so what was sent can be read back verbatim.
2. The **completion workflow runs**: `complete_task_operation` writes the
   activity, moves the lead, moves or closes the task and queues the syncs, in
   one transaction, keyed on a token so a repeat does not write twice.
3. The confirmation quotes what was **actually saved**, and offers Undo.

## 7. Voice input

A microphone sits beside the chat input. It transcribes into **editable text**:
the transcript is a draft of what the person meant to type, never a command that
executes itself.

While recording it shows that it is recording, and offers **Stop** and
**Cancel** as separate actions. Cancel discards; Stop keeps the text for
editing. Neither sends anything.

## 8. Gmail, later

When Gmail is connected it will add:

- **Threads**, so a reply is attached to the message it answers rather than
  floating as a new event.
- **A signature preference**, stored per person, applied to drafts.

Reading a thread will be evidence, under the same rules as section 4. It will
not be permission to write.

## 9. Permission is not contact

**Marketing permission is stored separately from contact source, and neither
implies the other.**

Having somebody's email address because they filled in an audit form is not
consent to add them to a newsletter. A lead's `source` says how they arrived; it
says nothing about what they agreed to receive. Any future marketing feature
reads a permission field that does not exist yet and must be added deliberately,
rather than inferring consent from the presence of an address.

Where permission is unknown, it stays unknown. Unknown is not no, and it is
certainly not yes.

---

## What this already rests on

| Rule above | What enforces it today |
|---|---|
| One write per confirmed send | `complete_task_operation`, keyed on an idempotency token |
| Corrections are reversible and recorded | `undo_task_operation`, `activity_events.reversed_at` |
| A correction never discards newer work | conflict detection on `updated_at` in `undo_task_operation` |
| Exact wording is kept | `activity_events.approved_message` |
| Evidence has a source | `activity_events.evidence_source` |
| Saving and syncing are different claims | `sync_jobs`, read as "Saved; calendar syncing" |
| Unknown stays unknown | nulls are never defaulted to zero or to a guess |
