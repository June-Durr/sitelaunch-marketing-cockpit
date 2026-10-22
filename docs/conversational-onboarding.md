# Conversational onboarding

Not built. This is the agreed shape of the next phase, written down so the
decisions survive the gap between now and building it.

## The idea

The assistant asks for what it is missing, in the conversation, at the moment it
is missing. A setting it needs is a question it can ask; a form somewhere else is
the fallback, not the first move.

Today the Cockpit does the opposite. It composes a message, notices it cannot
say who the message is from, and sends somebody to a settings panel to fix it.
That works and it is not how a person would ask.

## How it should ask

**In the conversation first.** When the assistant needs something it does not
have, it asks for it as part of the reply it is already giving, in the same one
focused question it is already allowed. "I do not know what to put at the top of
this message. What should it say you are called?"

**A confirmed answer goes to Settings.** Not to the conversation, and not to a
record about a contact. Answering the question writes it to the one identity
store, `AppSettings.introduction`, which is where the settings panel and the
Today band both read from. One store, three ways in.

**An unanswered question becomes a setup task, not a nag.** If the person does
not answer, the Cockpit remembers that it still needs to ask, and escalates on a
schedule rather than in the moment:

| When | What |
|---|---|
| The question is asked | Once, inside the reply. Nothing is repeated in that session. |
| A later visit | A gentle reminder: one quiet line, easy to pass over. |
| Later still | A card on Today, with a direct link to the exact setting and nothing else in the way. |

**Optional items can be snoozed and dismissed.** Snooze means ask me later.
Dismiss means stop asking. Both are honoured, and dismissing an optional item is
a decision rather than a deferral: it does not come back.

**Reminders stop when the thing is done.** Completing a setup item ends every
reminder for it, immediately, including one already on screen.

## What it must never do

**Interrupt an unsaved review.** A review card with a message somebody is in the
middle of editing is the one moment the Cockpit may not take the screen away.
Setup escalations wait for a moment when nothing is unsaved.

**Ask again for something it already has.** A saved answer ends the question
permanently. An answer that is saved and then edited is still an answer.

## What this rests on

The pieces that already exist and should be reused rather than rebuilt:

- `AppSettings.introduction`, the one identity store, with `readIdentity`,
  `writeIdentity` and `hasIdentity`.
- `subscribeToSettings`, so a panel or card that is already on screen hears
  about a saved answer without a reload.
- The assistant's one-question rule, in the instructions, which already limits
  the reply to a single focused question.
- `tasks`, for a setup item that needs to outlive a session, with the same
  reversibility every other task has.

## What is deliberately not decided here

How long "a later visit" and "later still" are, and whether a setup task is an
ordinary `tasks` row or something separate. Both want a look at the real
Cockpit with real setup items in it, rather than a number picked now.
