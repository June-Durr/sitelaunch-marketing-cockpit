/**
 * Which measurement readings are overdue.
 *
 * One implementation, used by both the Today queue and recommendation rule R5.
 * They previously computed this separately and disagreed: Today chased readings on
 * an externally amplified historical post that the rules engine deliberately
 * ignored. Two answers to the same question is worse than either answer.
 */

import type { Dataset, SnapshotWindow } from '../types/domain';
import { daysBetween, measurementDueDate, toDayString, today } from '../lib/dates';

export type DueWindow = Extract<SnapshotWindow, '24h' | '7d' | '30d'>;

export const DUE_WINDOWS: DueWindow[] = ['24h', '7d', '30d'];

/** Past this, an unrecorded window is history rather than a task worth chasing. */
export const MEASUREMENT_CHASE_DAYS = 60;

export interface MeasurementGap {
  contentItemId: string;
  title: string;
  window: DueWindow;
  due: string;
  daysOverdue: number;
}

export function findMeasurementGaps(data: Dataset, now: string = today()): MeasurementGap[] {
  const gaps: MeasurementGap[] = [];

  for (const item of data.contentItems) {
    if (!item.published_at) continue;
    if (item.status !== 'published' && item.status !== 'measured') continue;

    // Amplified items are historical records kept outside the measurement
    // discipline. Rule R7 already explains their status; chasing readings on them
    // is noise, and the reach was never the content's own anyway.
    if (item.is_externally_amplified) continue;

    const snaps = data.snapshots.filter((s) => s.content_item_id === item.id);
    // The platform reports nothing at all for this item, so there is nothing to chase.
    if (snaps.some((s) => s.metrics_unavailable)) continue;

    for (const window of DUE_WINDOWS) {
      const due = measurementDueDate(item.published_at, window);
      if (due > now) continue;

      const overdue = daysBetween(due, now);
      if (overdue > MEASUREMENT_CHASE_DAYS) continue;

      // Covered by a reading of that window, or by any reading taken on or after
      // the due date, in which case the numbers for that period were seen.
      const covered = snaps.some(
        (s) => s.window_type === window || toDayString(s.captured_at) >= due,
      );
      if (covered) continue;

      gaps.push({
        contentItemId: item.id,
        title: item.title,
        window,
        due,
        daysOverdue: overdue,
      });
    }
  }

  return gaps.sort((a, b) => a.due.localeCompare(b.due));
}
