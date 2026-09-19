/**
 * Metric arithmetic.
 *
 * Every function here ignores nulls rather than treating them as zero, and every
 * aggregate reports how many real observations it was computed from. A mean over
 * one value is still a mean; the caller needs `n` to know whether to trust it.
 */

import type {
  ContentItem, MetricKey, PerformanceSnapshot, SnapshotWindow,
} from '../types/domain';

export interface Aggregate {
  /** Null when there were no observations at all. */
  mean: number | null;
  sum: number | null;
  /** Count of non-null observations. */
  n: number;
  /** Rows considered, including those with no value for this metric. */
  considered: number;
}

export function aggregate(values: (number | null | undefined)[]): Aggregate {
  const observed = values.filter(
    (v): v is number => v !== null && v !== undefined && Number.isFinite(v),
  );
  if (observed.length === 0) {
    return { mean: null, sum: null, n: 0, considered: values.length };
  }
  const sum = observed.reduce((a, b) => a + b, 0);
  return { mean: sum / observed.length, sum, n: observed.length, considered: values.length };
}

/** Preference order when choosing one snapshot to represent a content item. */
const WINDOW_RANK: Record<SnapshotWindow, number> = {
  '30d': 4, '7d': 3, '24h': 2, custom: 1,
};

/**
 * The snapshot that best represents a content item: the widest measurement window
 * available, most recent first. Comparing a 7-day reading against a 24-hour one
 * would make later content look better purely for having been measured longer, so
 * cohort code should also check `window_type` before comparing.
 */
export function latestSnapshot(
  snapshots: PerformanceSnapshot[],
  contentItemId: string,
): PerformanceSnapshot | null {
  const mine = snapshots.filter((s) => s.content_item_id === contentItemId);
  if (mine.length === 0) return null;
  return mine.sort((a, b) => {
    const rank = WINDOW_RANK[b.window_type] - WINDOW_RANK[a.window_type];
    if (rank !== 0) return rank;
    return b.captured_at.localeCompare(a.captured_at);
  })[0];
}

export function snapshotsFor(
  snapshots: PerformanceSnapshot[],
  contentItemId: string,
): PerformanceSnapshot[] {
  return snapshots
    .filter((s) => s.content_item_id === contentItemId)
    .sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}

export function hasWindow(
  snapshots: PerformanceSnapshot[],
  contentItemId: string,
  window: SnapshotWindow,
): boolean {
  return snapshots.some(
    (s) => s.content_item_id === contentItemId && s.window_type === window,
  );
}

/** Sum of a metric across snapshots, null when nothing was ever recorded. */
export function metricOf(
  snapshot: PerformanceSnapshot | null,
  key: MetricKey,
): number | null {
  if (!snapshot) return null;
  const value = snapshot[key];
  return value === null || value === undefined ? null : value;
}

/**
 * Did this content item produce any recorded downstream action? Returns null when
 * nothing downstream was ever measured, which is a different answer from `false`.
 */
export function downstreamOutcome(
  snapshot: PerformanceSnapshot | null,
): { measured: boolean; any: boolean } {
  if (!snapshot) return { measured: false, any: false };
  const keys: MetricKey[] = [
    'link_clicks', 'website_sessions', 'form_starts', 'leads', 'qualified_leads',
  ];
  const values = keys.map((k) => snapshot[k]);
  const observed = values.filter((v) => v !== null && v !== undefined) as number[];
  return { measured: observed.length > 0, any: observed.some((v) => v > 0) };
}

/** Content eligible for comparison: published, measured, and not externally amplified. */
export function comparableContent(items: ContentItem[]): ContentItem[] {
  return items.filter(
    (c) =>
      !c.is_externally_amplified &&
      (c.status === 'published' || c.status === 'measured'),
  );
}
