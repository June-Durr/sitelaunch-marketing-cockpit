/** Date helpers. All "day" values are ISO `YYYY-MM-DD` strings in local time. */

import type { SnapshotWindow } from '../types/domain';

export function toDayString(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today(): string {
  return toDayString(new Date());
}

/**
 * The calendar day of a value that may already be one.
 *
 * toDayString takes an instant and asks what day it was here, which is right for
 * a timestamp and wrong for a date. '2026-10-05' parses as midnight UTC, and
 * midnight UTC is the evening of the 4th anywhere west of Greenwich, so running a
 * bare day through it moves it backwards. Everything in this app that schedules
 * from "the day something happened" has to accept either shape, because one
 * caller has a timestamp and the next has a date off a spreadsheet.
 */
export function dayOf(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ? value.trim()
    : toDayString(value);
}

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toDayString(d);
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function formatDay(day: string | null): string {
  if (!day) return 'No date';
  const d = new Date(`${day.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(value: string | null): string {
  if (!value) return 'No date';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** How a due date reads relative to today. */
export function relativeDue(day: string, from = today()): string {
  const diff = daysBetween(from, day);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return '1 day overdue';
  if (diff < 0) return `${Math.abs(diff)} days overdue`;
  return `In ${diff} days`;
}

export const WINDOW_OFFSET_DAYS: Record<Exclude<SnapshotWindow, 'custom'>, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
};

/** The day a given measurement window becomes due for content published on `publishedAt`. */
export function measurementDueDate(
  publishedAt: string,
  window: Exclude<SnapshotWindow, 'custom'>,
): string {
  return addDays(toDayString(publishedAt), WINDOW_OFFSET_DAYS[window]);
}

/** Inclusive `{ start, end }` of the trailing N-day window ending today. */
export function trailingWindow(days: number, end = today()): { start: string; end: string } {
  return { start: addDays(end, -(days - 1)), end };
}

export function isWithin(day: string | null, start: string, end: string): boolean {
  if (!day) return false;
  const d = day.slice(0, 10);
  return d >= start && d <= end;
}

/** ISO timestamp -> value for <input type="datetime-local">. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Value from <input type="datetime-local"> -> ISO timestamp, or null when blank. */
export function fromLocalInput(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
