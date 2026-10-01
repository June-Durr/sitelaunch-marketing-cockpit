/**
 * Which days a sync asks a provider for.
 *
 * WHY YESTERDAY AND NOT TODAY
 *
 * Today is still being written. GA4 and Search Console both keep collecting for
 * the current day, so a figure read at 09:00 disagrees with the same figure read
 * at 23:00, and neither is wrong. Storing either one produces a row that looks
 * settled but is not. Every window therefore ends at yesterday, and the current
 * day is excluded outright rather than stored and corrected later.
 *
 * WHY SEVEN DAYS ON EVERY RUN
 *
 * Providers restate recent history as data settles: late attribution, spam
 * filtering, bot reclassification. A sync that only ever asked for yesterday would
 * capture each day once, at its least accurate. Re-asking for the previous seven
 * completed days lets those corrections land, and because every write is an upsert
 * against the unique key, asking again is free.
 */

import type { DateWindow } from './types.ts';

/** The first day SiteLaunch wants history from. */
export const BACKFILL_START = '2026-08-27';

/** How many completed days a scheduled run re-asks for, including yesterday. */
export const LOOKBACK_DAYS = 7;

/** A date as YYYY-MM-DD, read in UTC. */
export function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Parse YYYY-MM-DD as midnight UTC. Returns null for anything else. */
export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 2026-02-31, which Date would otherwise roll forward.
  return toIsoDate(parsed) === value ? parsed : null;
}

export function addDays(date: string, days: number): string {
  const parsed = parseIsoDate(date);
  if (!parsed) throw new Error(`Not a date: ${date}`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return toIsoDate(parsed);
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) throw new Error(`Not a date: ${from} or ${to}`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * The last day that is finished everywhere the data is counted.
 *
 * UTC is used deliberately. A GA4 property reports in its own timezone, and if
 * that timezone is behind UTC then UTC yesterday is a day it has already closed.
 * Being at most one day conservative is the safe direction to be wrong in: a day
 * arrives later than it could have, rather than arriving half counted.
 */
export function lastCompleteDay(now: Date): string {
  return addDays(toIsoDate(now), -1);
}

/** True when this date is finished and therefore safe to store. */
export function isCompleteDay(date: string, now: Date): boolean {
  return daysBetween(date, lastCompleteDay(now)) >= 0;
}

/** The rolling window a scheduled run asks for: the last seven completed days. */
export function dailyWindow(now: Date): DateWindow {
  const end = lastCompleteDay(now);
  return { start: addDays(end, -(LOOKBACK_DAYS - 1)), end };
}

/**
 * The one-off window that fills in history, from the agreed start to yesterday.
 *
 * Returns null when yesterday is still before the backfill start, which is the
 * honest answer to "what should I fetch" when there is nothing yet to fetch.
 */
export function backfillWindow(now: Date, start: string = BACKFILL_START): DateWindow | null {
  const end = lastCompleteDay(now);
  return daysBetween(start, end) < 0 ? null : { start, end };
}

/**
 * Trim a requested window so it can never reach into today.
 *
 * Callers may pass a window in from outside, for instance a Sync now button or a
 * manual backfill. This is the one place that decides what is allowed, so no
 * caller can talk the sync into storing a partial day.
 */
export function clampToCompleteDays(window: DateWindow, now: Date): DateWindow | null {
  const limit = lastCompleteDay(now);
  const start = parseIsoDate(window.start);
  const end = parseIsoDate(window.end);
  if (!start || !end) throw new Error('Window needs two YYYY-MM-DD dates');

  const cappedEnd = daysBetween(window.end, limit) < 0 ? limit : window.end;
  if (daysBetween(window.start, cappedEnd) < 0) return null;
  return { start: window.start, end: cappedEnd };
}

/**
 * The key that identifies this logical run.
 *
 * Deterministic on purpose: a retry of the same window produces the same key, so
 * it updates that run's row in sync_runs rather than adding a second one, while a
 * different window is plainly a different run. sync_runs is unique on
 * (owner_id, idempotency_key), which is what makes that work.
 */
export function idempotencyKey(
  provider: string,
  mode: 'daily' | 'backfill' | 'manual',
  window: DateWindow,
): string {
  return `${provider}:${mode}:${window.start}:${window.end}`;
}
