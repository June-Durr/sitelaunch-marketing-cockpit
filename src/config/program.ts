/**
 * The SiteLaunch program: a fixed 91 day run, not a rolling window.
 *
 * Everything on the Today screen counts against these dates. A trailing 90 day
 * window would quietly move every morning, so a number could improve or worsen
 * without anything actually happening. A fixed program does not do that.
 *
 * COUNTING RULES, stated once here so nothing has to guess:
 *
 *   Program day      INCLUSIVE of the start date. The start date is Day 1, not
 *                    Day 0. So 27 August 2026 is Day 1 and 19 September 2026 is
 *                    Day 24.
 *   Total days       INCLUSIVE of both ends. 27 August to 25 November is 91 days.
 *   Days remaining   EXCLUSIVE of today, counted forward to the target date. The
 *                    target date itself therefore reads 0 days remaining, and the
 *                    day after reads -1.
 *   Phase boundaries INCLUSIVE at both ends. A date on a phase end date belongs to
 *                    that phase, not the next one.
 *   Statistics       INCLUSIVE of both the start and target dates.
 */

import { daysBetween, isWithin, toDayString } from '../lib/dates';

export interface ProgramPhase {
  number: 1 | 2 | 3;
  name: string;
  /** Inclusive. */
  start: string;
  /** Inclusive. */
  end: string;
}

export interface ProgramConfig {
  name: string;
  /** Day 1 of the program, inclusive. */
  startDate: string;
  /** The review date, inclusive. Preserved exactly as agreed. */
  targetDate: string;
  /** What the program is meant to produce. Optional. */
  goal: string | null;
}

export const DEFAULT_PROGRAM: ProgramConfig = {
  name: 'SiteLaunch 90 Day Program',
  startDate: '2026-08-27',
  targetDate: '2026-11-25',
  goal: null,
};

/**
 * The three phases. Dates are fixed against the default program, because they
 * describe the agreed plan rather than being derived from arithmetic.
 */
export const PROGRAM_PHASES: ProgramPhase[] = [
  { number: 1, name: 'Productize and Retain', start: '2026-08-27', end: '2026-09-26' },
  { number: 2, name: 'Acquire and Measure', start: '2026-09-27', end: '2026-10-26' },
  { number: 3, name: 'Prove and Systemize', start: '2026-10-27', end: '2026-11-25' },
];

export type ProgramStatus = 'before' | 'active' | 'after';

export interface ProgramPosition {
  status: ProgramStatus;
  /** Day number, counting the start date as Day 1. Null before the program opens. */
  day: number | null;
  /** Total days in the program, both ends included. */
  totalDays: number;
  /** Whole days from today to the target date. 0 on the target date itself. */
  daysRemaining: number;
  /** Whole days until the program opens. 0 once it has opened. */
  daysUntilStart: number;
  phase: ProgramPhase | null;
  startDate: string;
  targetDate: string;
}

/** Total days in the program, counting both the start and target dates. */
export function programLength(config: ProgramConfig = DEFAULT_PROGRAM): number {
  return daysBetween(config.startDate, config.targetDate) + 1;
}

/**
 * Which phase a date falls in. Phase boundaries are inclusive at both ends, so a
 * date landing exactly on a phase end date belongs to that phase.
 */
export function phaseFor(
  day: string,
  phases: ProgramPhase[] = PROGRAM_PHASES,
): ProgramPhase | null {
  const d = day.slice(0, 10);
  return phases.find((p) => isWithin(d, p.start, p.end)) ?? null;
}

/**
 * Where a given date sits in the program.
 *
 * The single place program day is worked out. Nothing else should do this
 * arithmetic, and no screen should ever hardcode today's day number.
 */
export function programPosition(
  today: string,
  config: ProgramConfig = DEFAULT_PROGRAM,
): ProgramPosition {
  const day = today.slice(0, 10);
  const start = config.startDate.slice(0, 10);
  const target = config.targetDate.slice(0, 10);

  const beforeStart = day < start;
  const afterTarget = day > target;

  return {
    status: beforeStart ? 'before' : afterTarget ? 'after' : 'active',
    // Day 1 is the start date, so the difference is offset by one.
    day: beforeStart ? null : daysBetween(start, day) + 1,
    totalDays: programLength(config),
    daysRemaining: daysBetween(day, target),
    daysUntilStart: beforeStart ? daysBetween(day, start) : 0,
    phase: phaseFor(day),
    startDate: start,
    targetDate: target,
  };
}

/** Is a timestamp inside the program period? Both ends included. */
export function isInProgram(
  value: string | null,
  config: ProgramConfig = DEFAULT_PROGRAM,
): boolean {
  if (!value) return false;
  const day = value.length > 10 ? toDayString(value) : value.slice(0, 10);
  return isWithin(day, config.startDate.slice(0, 10), config.targetDate.slice(0, 10));
}

/** Validation for the editable program form. Returns a reason, or null when fine. */
export function validateProgram(config: ProgramConfig): string | null {
  if (!config.name.trim()) return 'Give the program a name.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.startDate)) return 'The start date is not a real date.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.targetDate)) return 'The target date is not a real date.';
  if (config.targetDate <= config.startDate) {
    return 'The target date has to come after the start date.';
  }
  return null;
}
