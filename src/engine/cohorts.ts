/**
 * Cohort construction.
 *
 * A cohort is the only thing this application ever compares within: same platform,
 * same format, same measurement window, externally amplified items removed. Every
 * exclusion is recorded with its reason so the recommendation screen can show why a
 * given post was not part of the comparison.
 */

import type {
  ContentFormat, ContentItem, Dataset, MetricKey, PerformanceSnapshot,
  Platform, SnapshotWindow,
} from '../types/domain';
import { FORMAT_PLURALS, METRIC_KEYS, PLATFORM_LABELS, WINDOW_LABELS } from '../types/domain';
import { aggregate, latestSnapshot, type Aggregate } from '../lib/metrics';

export interface CohortMember {
  item: ContentItem;
  snapshot: PerformanceSnapshot;
  /**
   * Website sessions the operator explicitly linked to this item in Website
   * Outcomes. Derived by summing linked rows, never inferred from a campaign tag
   * the operator did not attach.
   */
  linkedSessions: number | null;
  linkedLeads: number | null;
}

export interface Exclusion {
  id: string;
  title: string;
  reason: string;
}

export interface Cohort {
  key: string;
  platform: Platform;
  format: ContentFormat;
  /** The window every member shares. Mixed windows are never compared. */
  window: SnapshotWindow;
  label: string;
  members: CohortMember[];
  excluded: Exclusion[];
  stats: Record<MetricKey, Aggregate>;
  distinctPillars: string[];
}

const WINDOW_RANK: Record<SnapshotWindow, number> = {
  '30d': 4, '7d': 3, '24h': 2, custom: 1,
};

function platformOf(data: Dataset, item: ContentItem): Platform | null {
  const account = data.accounts.find((a) => a.id === item.account_id);
  return account?.platform ?? null;
}

/**
 * Sum of a metric across traffic rows the operator linked to this content item.
 * Returns null when no linked row carried the metric, because "no linked data" is
 * not the same claim as "zero sessions".
 */
function linkedTraffic(
  data: Dataset,
  contentItemId: string,
  key: 'sessions' | 'generate_lead_events',
): number | null {
  const rows = data.traffic.filter((t) => t.content_item_id === contentItemId);
  const values = rows.map((t) => t[key]).filter((v): v is number => v !== null);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

export function buildCohorts(data: Dataset): Cohort[] {
  type Bucket = {
    platform: Platform;
    format: ContentFormat;
    candidates: { item: ContentItem; snapshot: PerformanceSnapshot | null }[];
    excluded: Exclusion[];
  };

  const buckets = new Map<string, Bucket>();

  for (const item of data.contentItems) {
    const platform = platformOf(data, item);
    if (!platform) continue; // no account, no platform, nothing to compare against
    if (item.status === 'draft' || item.status === 'scheduled') continue;

    const key = `${platform}:${item.format}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { platform, format: item.format, candidates: [], excluded: [] };
      buckets.set(key, bucket);
    }

    if (item.is_externally_amplified) {
      bucket.excluded.push({
        id: item.id,
        title: item.title,
        reason: `Externally amplified by ${item.amplifier_name ?? 'a third party'}. Reach was not earned by the content, so including it would distort every average.`,
      });
      continue;
    }

    bucket.candidates.push({ item, snapshot: latestSnapshot(data.snapshots, item.id) });
  }

  const cohorts: Cohort[] = [];

  for (const [key, bucket] of buckets) {
    const excluded = [...bucket.excluded];
    const measured: { item: ContentItem; snapshot: PerformanceSnapshot }[] = [];

    for (const candidate of bucket.candidates) {
      if (!candidate.snapshot) {
        excluded.push({
          id: candidate.item.id,
          title: candidate.item.title,
          reason: 'No performance snapshot recorded yet.',
        });
      } else if (candidate.snapshot.metrics_unavailable) {
        excluded.push({
          id: candidate.item.id,
          title: candidate.item.title,
          reason:
            candidate.snapshot.unavailable_reason ??
            'The platform does not report content-level metrics for this item.',
        });
      } else {
        measured.push({ item: candidate.item, snapshot: candidate.snapshot });
      }
    }

    // One window per cohort. A 7-day reading compared against a 24-hour reading
    // would reward age, not performance, so the minority windows are set aside.
    const window = dominantWindow(measured.map((m) => m.snapshot.window_type));
    if (!window) continue;

    const members: CohortMember[] = [];
    for (const entry of measured) {
      if (entry.snapshot.window_type !== window) {
        excluded.push({
          id: entry.item.id,
          title: entry.item.title,
          reason: `Measured at ${WINDOW_LABELS[entry.snapshot.window_type]}, while this comparison uses ${WINDOW_LABELS[window]}.`,
        });
        continue;
      }
      members.push({
        item: entry.item,
        snapshot: entry.snapshot,
        linkedSessions: linkedTraffic(data, entry.item.id, 'sessions'),
        linkedLeads: linkedTraffic(data, entry.item.id, 'generate_lead_events'),
      });
    }

    const stats = {} as Record<MetricKey, Aggregate>;
    for (const metric of METRIC_KEYS) {
      stats[metric] = aggregate(members.map((m) => m.snapshot[metric]));
    }

    cohorts.push({
      key,
      platform: bucket.platform,
      format: bucket.format,
      window,
      label: `${PLATFORM_LABELS[bucket.platform]} ${FORMAT_PLURALS[bucket.format]} at ${WINDOW_LABELS[window]}`,
      members,
      excluded,
      stats,
      distinctPillars: [
        ...new Set(members.map((m) => m.item.pillar).filter((p): p is string => Boolean(p))),
      ],
    });
  }

  return cohorts.sort((a, b) => b.members.length - a.members.length);
}

/** Most common window; ties go to the wider one. */
function dominantWindow(windows: SnapshotWindow[]): SnapshotWindow | null {
  if (windows.length === 0) return null;
  const counts = new Map<SnapshotWindow, number>();
  for (const w of windows) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || WINDOW_RANK[b[0]] - WINDOW_RANK[a[0]],
  )[0][0];
}

/** Effective website sessions for a member: the snapshot value, else the linked rows. */
export function memberSessions(member: CohortMember): number | null {
  return member.snapshot.website_sessions ?? member.linkedSessions;
}

export function memberLeads(member: CohortMember): number | null {
  return member.snapshot.leads ?? member.linkedLeads;
}
