/**
 * When to follow up, suggested rather than decided.
 *
 * WHY THIS IS NOT src/config/followUp.ts
 *
 * That file holds the Cockpit's recurring cadence, it has a twin in SQL, and it
 * answers a different question: how often should this lead be chased on an
 * ongoing basis. This answers the two one-off questions that come up around a
 * first contact, where the cadence is the wrong instrument.
 *
 * THE THIRTY DAY PROBLEM
 *
 * A newly captured contact used to be suggested thirty days out, because that is
 * the new_contact cadence. Beside "I told him I would text examples" that is
 * absurd: the promise is the thing that matters and it is already overdue by
 * tomorrow. The cadence is untouched; what changed is that a brand new contact
 * is no longer asked to wait a month for the thing they were promised.
 *
 * Every answer here is a suggestion. It says which basis it came from so the
 * screen can label it, it is editable, and it can be cleared.
 */

import { addDays } from '../lib/dates';

/* ------------------------------------------------------- the first contact --- */

export type FirstBasis =
  /** The person named a day. Nothing here second guesses that. */
  | 'stated'
  /** They promised to send or do something, so the follow-up is doing it. */
  | 'promise'
  /** Nothing promised and no day named. Soon, because the meeting is fresh. */
  | 'fresh';

export interface Suggestion<Basis extends string> {
  /** Null only when the caller asked for no suggestion at all. */
  date: string | null;
  basis: Basis;
  /** One sentence, shown on screen, saying where the date came from. */
  reason: string;
  /** False when a person named this date, which the screen labels differently. */
  suggested: boolean;
}

/**
 * How long a contact with no promise attached is left before a nudge.
 *
 * One day, not thirty. Somebody met last night is a warm contact for about a
 * week and a stranger again after that, and the Cockpit's job is to put them in
 * front of you while the meeting still means something.
 */
export const FRESH_CONTACT_DAYS = 1;

export interface FirstFollowUpInput {
  /** A day taken from the person's own words, if the extraction found one. */
  statedDate: string | null;
  /** What they said they would do, in their words. Null when nothing was promised. */
  promise: string | null;
  today: string;
}

/**
 * The first follow-up for somebody just met.
 *
 * A promise means today: the whole point of recording "I said I would send
 * examples" is that it is owed, and a reminder for next month is a reminder to
 * have already let somebody down.
 */
export function suggestFirstFollowUp(input: FirstFollowUpInput): Suggestion<FirstBasis> {
  const stated = (input.statedDate ?? '').trim();
  if (stated !== '') {
    return {
      date: stated,
      basis: 'stated',
      reason: 'You named this day, so it was not changed.',
      suggested: false,
    };
  }

  const promise = (input.promise ?? '').trim();
  if (promise !== '') {
    return {
      date: input.today,
      basis: 'promise',
      reason:
        `You said you would ${lowerFirst(promise)}. That is owed, so this is `
        + 'suggested for today rather than put on the usual rhythm. Change it or '
        + 'clear it if you meant otherwise.',
      suggested: true,
    };
  }

  return {
    date: addDays(input.today, FRESH_CONTACT_DAYS),
    basis: 'fresh',
    reason:
      'Nothing was promised and no day was named, so this is suggested for '
      + 'tomorrow, while meeting them is still recent. It is the app suggesting, '
      + 'not something you said.',
    suggested: true,
  };
}

/* --------------------------------------------------------- after a send --- */

export type AfterSendBasis =
  | 'stated'
  /** They have replied before, so the ordinary rhythm applies again. */
  | 'reply_on_file'
  /** The message asked something, so there is an answer to wait for. */
  | 'question_asked'
  /** A message that asked nothing. Longer, because there is less to wait for. */
  | 'no_question';

/** A question has an answer coming, so it is chased sooner than a statement. */
export const AFTER_QUESTION_DAYS = 3;
/** A message that asked nothing. Left longer, because nothing is pending. */
export const AFTER_STATEMENT_DAYS = 5;
/** Somebody who has replied before is back on the ordinary follow-up rhythm. */
export const AFTER_REPLY_DAYS = 7;

export interface AfterSendInput {
  /** The day the person says they sent it. */
  sentOn: string;
  /** The wording that went out, used only to see whether it asked anything. */
  body: string;
  /**
   * Confirmed replies on file for this contact.
   *
   * Zero means nothing has been recorded. It does not mean they did not reply,
   * and nothing in here says it does.
   */
  repliesRecorded: number;
  /** A day the person named for the next step, if they named one. */
  statedDate: string | null;
}

/** Does this message put a question to them? */
export function asksSomething(body: string): boolean {
  return body.includes('?');
}

/**
 * The next follow-up after a confirmed send.
 *
 * WHAT IT WILL NOT SAY
 *
 * That they have not replied. The Cockpit knows what has been recorded, which
 * is a different thing: nobody logs every reply, and treating an empty log as
 * silence is how a person gets chased for an answer they already gave.
 */
export function suggestAfterSend(input: AfterSendInput): Suggestion<AfterSendBasis> {
  const stated = (input.statedDate ?? '').trim();
  if (stated !== '') {
    return {
      date: stated,
      basis: 'stated',
      reason: 'You named this day for the next step.',
      suggested: false,
    };
  }

  if (input.repliesRecorded > 0) {
    return {
      date: addDays(input.sentOn, AFTER_REPLY_DAYS),
      basis: 'reply_on_file',
      reason:
        `They have replied before, so this is suggested ${AFTER_REPLY_DAYS} days `
        + 'out, which is the ordinary rhythm for somebody you are talking to.',
      suggested: true,
    };
  }

  if (asksSomething(input.body)) {
    return {
      date: addDays(input.sentOn, AFTER_QUESTION_DAYS),
      basis: 'question_asked',
      reason:
        `You asked them something, so this is suggested ${AFTER_QUESTION_DAYS} days `
        + 'out. Nothing is recorded either way yet, which is not the same as them '
        + 'not replying.',
      suggested: true,
    };
  }

  return {
    date: addDays(input.sentOn, AFTER_STATEMENT_DAYS),
    basis: 'no_question',
    reason:
      `That message asked nothing, so there is less to wait for: suggested `
      + `${AFTER_STATEMENT_DAYS} days out. Nothing is recorded either way yet, `
      + 'which is not the same as them not replying.',
    suggested: true,
  };
}

/** "Text him examples" reads better mid sentence as "text him examples". */
function lowerFirst(text: string): string {
  const trimmed = text.trim().replace(/\.$/, '');
  if (trimmed === '') return trimmed;
  // Only when the rest is not an acronym or a name: TEXT stays TEXT.
  if (trimmed.slice(0, 2) === trimmed.slice(0, 2).toUpperCase() && trimmed.length > 1) {
    return trimmed;
  }
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}
