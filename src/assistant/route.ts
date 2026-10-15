/**
 * Which model tier pays for a turn.
 *
 * This decides one thing: cost. The assistant's behaviour comes from the same
 * schema and the same instructions whichever branch wins, so a wrong guess here
 * spends a fraction of a cent it did not need to, or saves one it should have
 * spent. It changes no record, and it cannot send a request anywhere different.
 *
 * WHY NOT ASK THE MODEL TO ROUTE
 *
 * Because that is a second request, and the whole saving is in not making one.
 * A classification call to pick a cheaper model costs more than the difference
 * it was picking between.
 *
 * WHY THE UNSURE CASE IS THE EXPENSIVE ONE
 *
 * The cheap tier is for summarising rows that were already selected. Everything
 * else decides what gets written about a person. If it is not clearly the first
 * kind, it is treated as the second.
 */

import type { AssistantOperation } from './wire';

/** Asking for wording. Checked first, because most of these are also questions. */
const WANTS_WORDING =
  /\b(draft|rewrite|reword|revise|write|compose|what should i (say|send|write)|how should i (say|word|reply)|reply to|respond to|follow up with|send (him|her|them|it)|make it (shorter|longer|warmer|softer|friendlier)|in spanish|en espa)\b/i;

/** Asking about what is already recorded. */
const ASKS_ABOUT_RECORDS =
  /\b(where did we leave off|where are we|what happened|what did i|when did i|last (talk|spoke|contact|touch)|who (owes|is|do i|should i)|what is (due|open|overdue)|any(thing| ) ?(due|overdue)|status of|how long since|remind me)\b/i;

const QUESTION_OPENER =
  /^(where|what|when|who|which|how|did|do|does|is|are|was|were|has|have|any|can|could|should)\b/i;

/** Long enough that it is a description of something rather than a question. */
const SHORT_ENOUGH = 240;

export function pickOperation(message: string): AssistantOperation {
  const text = message.trim();
  if (text === '') return 'capture';

  if (WANTS_WORDING.test(text)) return 'draft';

  const short = text.length <= SHORT_ENOUGH;
  const asksQuestion = text.endsWith('?') || QUESTION_OPENER.test(text);

  // A question about the record, kept short, is the one case the cheap tier is
  // for: the rows are already in the prompt and nothing new gets written.
  if (short && (ASKS_ABOUT_RECORDS.test(text) || asksQuestion)) return 'brief';

  return 'capture';
}
