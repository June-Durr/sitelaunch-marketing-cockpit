# The AI drafting contract

What an assistant inside the Cockpit is allowed to read, allowed to write, and
required to refuse. Written before the feature existed, because the rules are
the hard part and the chat window is not.

Most of it is now built. The sections below are the rules; this section is the
state of the thing that obeys them, kept here rather than in a commit message
because anybody reading the rules needs to know which ones are enforced by code
today and which are still only agreed.

## What is built

**The panel.** An Ask button on every screen, opening a conversation beside the
page. It knows which screen you are on and which contact is open, and says both
in its header. It is absent entirely in browser-only mode, because there is no
server there to hold a model key.

**One model request per turn**, in one Edge Function, `supabase/functions/assistant`.
It holds `OPENAI_API_KEY`, builds the prompt, asks once, checks the answer and
records what it cost. It writes nothing except the usage row.

**Every write goes through a button.** The model proposes; the person edits and
presses Save. The four writes are `capture_contact`, `record_conversation`,
`save_message_draft` and `mark_draft_sent`, all of them the same transactional,
idempotent operations the rest of the app uses, all under row level security.
There is no path from an answer to a record that does not pass through a person.

**Provenance survives the trip.** The model has to say, per fact, whether the
contact stated it, the person formed the impression, or it worked the fact out
itself, and an inference has to quote the words it came from. The panel shows
which is which, and the person can untick any of them before saving.

**The checks are in code, not in this document.** The server drops a contact id
that was not in the prompt, a date in the future where a past date was asked
for, a day that is not a day, and a quote that is not in what the person wrote.
What it dropped is shown in the panel rather than swallowed.

**Cost is recorded from the first request**, per operation and per model, in
`ai_usage`, including failed calls, because a failed call is still billed. The
panel shows the last thirty days. There is no customer billing.

## What is not built

- **Voice input.** Section 7 describes what it will be. There is no microphone.
- **Gmail.** Section 8 still describes the future.
- **A History needs confirmation task.** Section 3's question is asked, and the
  assistant saves what it is sure of, but no task is produced when the answer
  does not arrive.
- **Google Contacts or vCard import.** Nothing imports an address book, and
  nothing claims a contact integration is connected.
- **Facts reviewed after the fact.** `extracted_facts` carries `accepted_at` and
  `rejected_at`, and today the decision is made before saving rather than in a
  queue afterwards.

## Which model, and why

Model choice is server configuration, in `server/integrations/openai.ts`, and
every part of it is overridable without a deploy:

| Operation | Default | Why |
|---|---|---|
| capture | `gpt-6.1-sol` | Decides what gets written about a real person, including what is a fact and what is a guess |
| draft | `gpt-6.1-sol` | The wording actually goes to a prospect, sometimes in Spanish |
| brief | `gpt-6-luna` | Summarises rows the Cockpit already selected and handed over: no retrieval, no judgement, twenty times cheaper |

`ASSISTANT_MODEL` replaces all three. `ASSISTANT_MODEL_CAPTURE`,
`ASSISTANT_MODEL_DRAFT` and `ASSISTANT_MODEL_BRIEF` replace one each and win
over the general one. Prices are a table in the same file, in millionths of a
dollar per million tokens, taken from the published list on 2026-10-14.

### What a turn costs, and what is actually known about that

A cost is recorded three ways, and they are not interchangeable:

- **Known.** The provider reported usage and the model is in the price table.
  `cost_micros` holds the arithmetic.
- **No price on file.** Usage is known, the model is not in the table. Tokens
  are recorded, `cost_micros` is null, and `note` says why. Not a failure.
- **No usage reported.** The request failed on the way back, or never got far
  enough to be measured. Tokens and cost are all null and `error` says what
  happened. This is the case worth being careful about: a request that times out
  after the model has generated tokens **is billed**, and a zero in that row
  would be a claim that it was free.

Which is why `ai_usage` holds nulls rather than zeros, and why the panel says
"at least" in front of the total whenever any row's cost is unknown. Migration
0018 enforces the other half: a row may only leave its cost unknown if it says
why.

The model split above is a judgement made before any live measurement, which is
exactly why the environment variables exist. Any figure for what a turn costs
should come from `ai_usage` and the current published rates, not from an
estimate written here.

## Where the contact records come from

The browser assembles the prompt out of the dataset it is already showing: the
contact it matched, that contact's history, the open drafts, what is due, and a
thin index of everybody. Matching is done by `src/lib/contactMatch.ts`, in plain
code, never by the model, because matching a name to a record is string
comparison and a language model does that approximately. One clear match is
pinned; two plausible ones become a question with buttons.

The honest limit is size. The index is a prompt, so it stops fitting somewhere
in the low thousands of contacts. The tool-calling seam in the model adapter is
where that goes next, and it is built and tested but unused.

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
| A guess cannot become a fact | `extracted_facts.provenance`, NOT NULL with no default, plus `inferred_facts_show_their_source` |
| Writing is not sending | `message_drafts.copied_at` and `sent_at` as separate columns, and `mark_draft_sent` as the only path to `sent` |
| One answer to "did I send it?" | `message_drafts_one_open_per_channel`, one open draft per contact per channel |
| A contact and their first meeting land together | `capture_contact`, one transaction, idempotent on a token held in `external_key` |
| The model cannot name a contact that does not exist | the server checks every id against the ones that were in the prompt |
| What a request cost is known | `ai_usage`, written server side, readable by its owner and writable by nobody in the browser |
| A cost nobody knows is not zero | nullable `cost_micros` with `unknown_cost_says_why`, and "at least" in front of a total that has one |
