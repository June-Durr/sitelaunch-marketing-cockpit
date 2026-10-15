/**
 * What a request is allowed to cost, and how much to book before it runs.
 *
 * Pure. The arithmetic and the wording live here; the locking and the counting
 * live in migration 0019; the decision to call a model or not lives in
 * assistantRun.ts. Three files because each one is testable on its own, and the
 * one that holds the money is the one that cannot be unit tested.
 *
 * WHY THE RESERVATION IS BIGGER THAN THE BILL
 *
 * The input size is known before the call and the output size is not, so the
 * output half is booked at its ceiling: whatever max_output_tokens allows. A
 * measured capture turn costs about 1.3 cents and books about 2.2. That gap is
 * the price of a ceiling that cannot be walked through, and it is given back
 * the moment the request settles.
 */

import { MODEL_PRICES, type ModelPrice } from './openai.ts';

/* ------------------------------------------------------------- the limits --- */

/** A dollar a day, until somebody says otherwise. */
export const DEFAULT_DAILY_LIMIT_MICROS = 1_000_000;

/**
 * Ten requests a minute.
 *
 * A measured turn takes between three and seventeen seconds and a person asks
 * one thing at a time, so ten in a minute is already far beyond human pace.
 * What it stops is a client that has got stuck in a loop.
 */
export const DEFAULT_MAX_PER_MINUTE = 10;

/**
 * How long a reservation is believed to be in flight.
 *
 * Longer than the model timeout plus the time to settle, so a slow request is
 * never treated as abandoned while it is still running.
 */
export const DEFAULT_HOLD_SECONDS = 120;

export interface SpendLimits {
  dailyMicros: number;
  maxPerMinute: number;
  holdSeconds: number;
}

export type ReadEnv = (name: string) => string | null;

/** Millionths of a dollar from a figure written in dollars. */
export function dollarsToMicros(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 1_000_000);
}

export function readLimits(readEnv: ReadEnv): SpendLimits {
  const dollars = readEnv('ASSISTANT_DAILY_LIMIT_USD');
  const fromDollars = dollars === null ? null : dollarsToMicros(dollars);

  const perMinute = Number(readEnv('ASSISTANT_MAX_PER_MINUTE') ?? '');
  const hold = Number(readEnv('ASSISTANT_HOLD_SECONDS') ?? '');

  return {
    // A limit that cannot be parsed falls back to the default rather than to
    // no limit. A typo in configuration must not remove the ceiling.
    dailyMicros: fromDollars ?? DEFAULT_DAILY_LIMIT_MICROS,
    maxPerMinute: Number.isInteger(perMinute) && perMinute > 0
      ? perMinute
      : DEFAULT_MAX_PER_MINUTE,
    holdSeconds: Number.isInteger(hold) && hold > 0 ? hold : DEFAULT_HOLD_SECONDS,
  };
}

/* -------------------------------------------------------- the reservation --- */

/**
 * The dearest rates on file, for a model that has none.
 *
 * A model nobody priced still has to book something, and booking zero would be
 * a hole in the ceiling exactly where the uncertainty is greatest. The most
 * expensive thing we know about is the honest worst case.
 */
function worstKnownPrice(): ModelPrice {
  let worst: ModelPrice = { input: 0, cachedInput: 0, output: 0 };
  for (const price of Object.values(MODEL_PRICES)) {
    if (price.input > worst.input) worst = { ...worst, input: price.input };
    if (price.output > worst.output) worst = { ...worst, output: price.output };
  }
  return worst;
}

/**
 * Roughly how many tokens a prompt of this many characters is.
 *
 * Three characters per token, which is deliberately below the four or so that
 * English actually averages. Under-counting characters per token over-counts
 * tokens, and a reservation should err upwards.
 */
export function estimateTokens(characters: number): number {
  return Math.ceil(Math.max(characters, 0) / 3);
}

export interface ReserveInput {
  model: string;
  /** Every character going into the request: instructions, context, turns. */
  promptCharacters: number;
  maxOutputTokens: number;
}

/** The worst this request could cost, in millionths of a dollar. */
export function reserveMicros(input: ReserveInput): number {
  const price = MODEL_PRICES[input.model] ?? worstKnownPrice();
  const inputTokens = estimateTokens(input.promptCharacters);
  // No cached discount is assumed. Caching makes a request cheaper, and a
  // reservation must not depend on a saving that may not happen.
  return (
    Math.ceil((inputTokens * price.input) / 1_000_000)
    + Math.ceil((Math.max(input.maxOutputTokens, 0) * price.output) / 1_000_000)
  );
}

/* ----------------------------------------------------------- the wording --- */

function money(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars >= 0.01) return `$${dollars.toFixed(2)}`;
  if (micros <= 0) return '$0.00';
  return 'under a cent';
}

/**
 * What a blocked request says, in words that name the number and the way out.
 *
 * Said in full rather than as a code, because a limit somebody cannot see the
 * shape of is a limit they will read as a bug.
 */
export function capMessage(spentMicros: number, limitMicros: number): string {
  return (
    `The assistant has reached its spending limit of ${money(limitMicros)} `
    + `in twenty four hours. About ${money(spentMicros)} of that is used or `
    + 'committed. Nothing was sent to the model and nothing was charged. The '
    + 'limit is a setting, ASSISTANT_DAILY_LIMIT_USD, and it frees up as the '
    + 'oldest requests pass twenty four hours old.'
  );
}

export function rateMessage(recent: number, allowed: number): string {
  return (
    `That is ${recent} requests in the last minute, and the limit is ${allowed}. `
    + 'Nothing was sent to the model and nothing was charged. Wait a moment and '
    + 'ask again; if this keeps happening with nobody pressing anything, '
    + 'something is retrying on its own.'
  );
}

export function duplicateMessage(): string {
  return (
    'That exact request has already been made, so it was not sent to the model '
    + 'again and nothing was charged twice. The answer to it is the one already '
    + 'on screen.'
  );
}
