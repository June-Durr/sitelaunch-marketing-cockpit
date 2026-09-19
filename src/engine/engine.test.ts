/**
 * Tests for the invariants this tool exists to protect. These are not incidental
 * details, each one, if broken, would make the cockpit quietly lie.
 */

import { describe, expect, it } from 'vitest';
import type { Account, ContentItem, Dataset, PerformanceSnapshot } from '../types/domain';
import { EMPTY_DATASET } from '../data/repository';
import { blankMetrics, buildSeedDataset, SEED_OUTLIER } from '../data/seed';
import { aggregate } from '../lib/metrics';
import { parseMetricInput } from '../lib/format';
import { csvNumber, parseCsv } from '../lib/csv';
import { buildCohorts } from './cohorts';
import { MIN_PATTERN, generateRecommendations, pickNextStep } from './recommendations';
import { findMeasurementGaps } from './measurement';

const T = '2026-09-01T00:00:00.000Z';

function account(id: string, platform: Account['platform'] = 'instagram'): Account {
  return {
    id, platform, handle: `@${id}`, display_name: null, provider_account_id: null,
    is_active: true, notes: null, is_seed: false, created_at: T, updated_at: T,
  };
}

function content(id: string, over: Partial<ContentItem> = {}): ContentItem {
  return {
    id, account_id: 'acc', cross_post_group_id: null, title: id, format: 'carousel',
    status: 'measured', published_at: '2026-09-01T00:00:00.000Z', pillar: null,
    target_audience: null, hook: null, cta: null, destination_url: null,
    utm_source: null, utm_medium: null, utm_campaign: null,
    is_externally_amplified: false, amplifier_name: null, amplification_note: null,
    notes: null, screenshot_url: null, external_id: null, is_seed: false,
    created_at: T, updated_at: T, ...over,
  };
}

function snapshot(
  contentId: string,
  metrics: Partial<PerformanceSnapshot> = {},
): PerformanceSnapshot {
  return {
    ...blankMetrics(),
    id: `snap-${contentId}`, content_item_id: contentId, window_type: '7d',
    captured_at: '2026-09-08T00:00:00.000Z', metrics_unavailable: false,
    unavailable_reason: null, ingest_source: 'manual', notes: null, is_seed: false,
    created_at: T, updated_at: T, ...metrics,
  };
}

function dataset(items: ContentItem[], snaps: PerformanceSnapshot[]): Dataset {
  return { ...EMPTY_DATASET, accounts: [account('acc')], contentItems: items, snapshots: snaps };
}

/* ------------------------------------------------------------------------ */

describe('unknown is never zero', () => {
  it('excludes nulls from averages instead of counting them as 0', () => {
    const result = aggregate([10, null, 20, undefined]);
    expect(result.mean).toBe(15); // not 7.5
    expect(result.n).toBe(2);
    expect(result.considered).toBe(4);
  });

  it('returns a null mean when nothing was observed, rather than 0', () => {
    expect(aggregate([null, null]).mean).toBeNull();
    expect(aggregate([]).sum).toBeNull();
  });

  it('keeps a real recorded zero distinct from a blank', () => {
    expect(parseMetricInput('')).toBeNull();
    expect(parseMetricInput('   ')).toBeNull();
    expect(parseMetricInput('0')).toBe(0);
    expect(aggregate([0, null]).mean).toBe(0);
    expect(aggregate([0, null]).n).toBe(1);
  });

  it('imports blank CSV cells as null', () => {
    const { rows } = parseCsv('source,sessions\nfacebook,\ninstagram,4');
    expect(rows[0].sessions).toBeNull();
    expect(csvNumber(rows[0].sessions)).toBeNull();
    expect(csvNumber(rows[1].sessions)).toBe(4);
    expect(csvNumber('0')).toBe(0);
  });
});

describe('externally amplified content is quarantined', () => {
  const items = [
    content('a', { is_externally_amplified: false }),
    content('b', { is_externally_amplified: false }),
    content('boosted', {
      is_externally_amplified: true,
      amplifier_name: 'Only in Dade',
    }),
  ];
  const snaps = [
    snapshot('a', { views: 100 }),
    snapshot('b', { views: 200 }),
    snapshot('boosted', { views: 30_300 }),
  ];

  it('leaves the amplified item out of the cohort average entirely', () => {
    const [cohort] = buildCohorts(dataset(items, snaps));
    expect(cohort.members.map((m) => m.item.id)).toEqual(['a', 'b']);
    expect(cohort.stats.views.mean).toBe(150); // not 10,200
  });

  it('records why it was excluded rather than dropping it silently', () => {
    const [cohort] = buildCohorts(dataset(items, snaps));
    const excluded = cohort.excluded.find((e) => e.id === 'boosted');
    expect(excluded?.reason).toContain('Only in Dade');
  });
});

describe('cohorts never mix platforms, formats or windows', () => {
  it('separates the same format on different platforms', () => {
    const data: Dataset = {
      ...EMPTY_DATASET,
      accounts: [account('ig', 'instagram'), account('li', 'linkedin')],
      contentItems: [
        content('one', { account_id: 'ig' }),
        content('two', { account_id: 'li' }),
      ],
      snapshots: [snapshot('one', { views: 10 }), snapshot('two', { views: 90 })],
    };
    expect(buildCohorts(data).map((c) => c.key).sort()).toEqual([
      'instagram:carousel',
      'linkedin:carousel',
    ]);
  });

  it('holds back an item measured at a different window', () => {
    const items = ['a', 'b', 'c'].map((id) => content(id));
    const snaps = [
      snapshot('a', { views: 10, window_type: '7d' }),
      snapshot('b', { views: 20, window_type: '7d' }),
      snapshot('c', { views: 5_000, window_type: '30d' }),
    ];
    const [cohort] = buildCohorts(dataset(items, snaps));
    expect(cohort.window).toBe('7d');
    expect(cohort.members.map((m) => m.item.id)).toEqual(['a', 'b']);
    expect(cohort.excluded.find((e) => e.id === 'c')?.reason).toContain('30 days');
  });
});

describe('evidence thresholds', () => {
  const buildCohortOf = (n: number, views: number[]) => {
    const items = Array.from({ length: n }, (_, i) => content(`c${i}`));
    const snaps = items.map((item, i) => snapshot(item.id, { views: views[i] }));
    return dataset(items, snaps);
  };

  it('refuses to name a pattern below five comparable items', () => {
    const recs = generateRecommendations(buildCohortOf(4, [10, 20, 30, 400]));
    const ids = recs.map((r) => r.rule_id);
    expect(ids).toContain('R6_insufficient_evidence');

    const insufficient = recs.find((r) => r.rule_id === 'R6_insufficient_evidence');
    expect(insufficient?.detail).toContain('1 more comparable');
    expect(insufficient?.confidence).toBe('early_signal');
  });

  it('never claims content "works" anywhere below the threshold', () => {
    const recs = generateRecommendations(buildCohortOf(3, [10, 20, 500]));
    const prose = recs.map((r) => `${r.headline} ${r.detail} ${r.suggested_action ?? ''}`).join(' ');
    expect(prose).not.toMatch(/\bworks\b|\bperforms better\b|\bscale (this|it)\b/i);
  });

  it('labels a five-item cohort as an emerging pattern, not a reliable one', () => {
    const data = buildCohortOf(5, [10, 10, 10, 10, 900]);
    const recs = generateRecommendations(data);
    const viewRule = recs.find((r) => r.rule_id === 'R4_views_without_action');
    expect(viewRule?.confidence).toBe('emerging_pattern');
    expect(viewRule?.sample_size).toBe(MIN_PATTERN);
  });

  it('attaches the numbers behind every statement', () => {
    for (const rec of generateRecommendations(buildCohortOf(6, [1, 2, 3, 4, 5, 600]))) {
      expect(rec.evidence.lines.length).toBeGreaterThan(0);
      expect(typeof rec.sample_size).toBe('number');
    }
  });
});

describe('views never outrank outcomes', () => {
  it('flags high views with no downstream action instead of praising them', () => {
    const items = Array.from({ length: 5 }, (_, i) => content(`c${i}`));
    const snaps = [
      snapshot('c0', { views: 10, link_clicks: 1 }),
      snapshot('c1', { views: 10, link_clicks: 1 }),
      snapshot('c2', { views: 10, link_clicks: 1 }),
      snapshot('c3', { views: 10, link_clicks: 1 }),
      snapshot('c4', { views: 5_000, link_clicks: 0, website_sessions: 0, leads: 0 }),
    ];
    const recs = generateRecommendations(dataset(items, snaps));
    const flagged = recs.find((r) => r.rule_id === 'R4_views_without_action');
    expect(flagged?.detail).toContain('c4');
    expect(flagged?.detail).toMatch(/attention, not outcome/i);
  });

  it('ranks a downstream-outcome rule above a views rule', () => {
    // c4 converted; c5 drew the most attention and converted nothing. Both rules
    // fire, and the outcome one has to come first.
    const items = Array.from({ length: 6 }, (_, i) => content(`c${i}`));
    const snaps = [
      snapshot('c0', { views: 10, leads: 0 }),
      snapshot('c1', { views: 10, leads: 0 }),
      snapshot('c2', { views: 10, leads: 0 }),
      snapshot('c3', { views: 10, leads: 0 }),
      snapshot('c4', { views: 200, leads: 3 }),
      snapshot('c5', { views: 9_000, leads: 0, link_clicks: 0, website_sessions: 0 }),
    ];
    const ruleIds = generateRecommendations(dataset(items, snaps)).map((r) => r.rule_id);
    expect(ruleIds.indexOf('R1_downstream_winner')).toBeLessThan(
      ruleIds.indexOf('R4_views_without_action'),
    );
  });
});

describe('the shipped seed data', () => {
  const seed = buildSeedDataset();

  it('records only the one Instagram figure that was actually observed', () => {
    const snap = seed.snapshots.find((s) => s.id === 'ps-bts-ig-24h');
    expect(snap?.views).toBe(31);
    expect(snap?.likes).toBeNull();
    expect(snap?.link_clicks).toBeNull();
    expect(snap?.leads).toBeNull();
  });

  it('marks the Facebook cross-post unavailable rather than blank or zero', () => {
    const snap = seed.snapshots.find((s) => s.id === 'ps-bts-fb-24h');
    expect(snap?.metrics_unavailable).toBe(true);
    expect(snap?.views).toBeNull();
    expect(snap?.unavailable_reason).toMatch(/Facebook/);
  });

  it('keeps the cross-post as two records so per-account metrics are not merged', () => {
    const group = seed.contentItems.filter((c) => c.cross_post_group_id);
    expect(group).toHaveLength(2);
    expect(new Set(group.map((c) => c.account_id)).size).toBe(2);
  });

  it('holds the amplified story out of every average', () => {
    const cohorts = buildCohorts(seed);
    for (const cohort of cohorts) {
      expect(cohort.members.map((m) => m.item.id)).not.toContain(SEED_OUTLIER);
    }
    const igStories = cohorts.find((c) => c.key === 'instagram:story');
    expect(igStories?.stats.views.mean).toBe(31); // not ~15,165
  });

  it('produces no performance claim from two seed records', () => {
    const recs = generateRecommendations(seed, '2026-09-14');
    expect(recs.some((r) => r.rule_id === 'R1_downstream_winner')).toBe(false);
    expect(recs.some((r) => r.rule_id === 'R6_insufficient_evidence')).toBe(true);
    expect(recs.some((r) => r.rule_id === 'R7_amplification_notice')).toBe(true);
  });

  it('does not report the 7-day check as overdue before 2026-09-20', () => {
    const before = generateRecommendations(seed, '2026-09-14');
    expect(before.some((r) => r.rule_id === 'R5_measurement_gap')).toBe(false);

    const after = generateRecommendations(seed, '2026-09-21');
    const gap = after.find((r) => r.rule_id === 'R5_measurement_gap');
    expect(gap?.detail).toContain('SiteLaunch BTS Story');
  });
});

describe('the single next step', () => {
  it('puts an expiring measurement ahead of everything else', () => {
    const seed = buildSeedDataset();
    const step = pickNextStep(seed, '2026-09-21');
    expect(step?.title).toContain('7-day metrics');
    expect(step?.why).toMatch(/permanently harder/i);
  });

  it('prefers a waiting lead over publishing more content', () => {
    const seed = buildSeedDataset();
    const withLead: Dataset = {
      ...seed,
      tasks: [],
      leads: [
        {
          id: 'l1', content_item_id: null, prospect_name: 'Rivera Roofing',
          organization: null, email: null, phone: null, project: 'Site rebuild',
          source: null, related_campaign: null, stage: 'proposal',
          next_action: 'Send the revised proposal', next_action_date: '2026-09-10',
          proposed_value: 6000, closed_value: null, attribution_note: null, notes: null,
          is_seed: false, first_contact_at: '2026-09-01', closed_at: null,
          created_at: T, updated_at: T,
        },
      ],
    };
    const step = pickNextStep(withLead, '2026-09-14');
    expect(step?.title).toBe('Send the revised proposal');
  });
});

describe('the measurement queue', () => {
  const seed = buildSeedDataset();

  it('does not chase readings on an externally amplified record', () => {
    // The Only in Dade story is two weeks old and its windows are long gone. It is
    // kept as history, not as a task.
    const gaps = findMeasurementGaps(seed, '2026-09-14');
    expect(gaps.map((g) => g.contentItemId)).not.toContain(SEED_OUTLIER);
    expect(gaps).toHaveLength(0);
  });

  it('skips an item the platform reports nothing for', () => {
    const gaps = findMeasurementGaps(seed, '2026-09-25');
    // The Facebook cross-post is flagged metrics_unavailable, so it never queues.
    expect(gaps.map((g) => g.title)).not.toContain(
      'SiteLaunch BTS Story (Facebook cross-post)',
    );
  });

  it('queues the Instagram 7-day reading once it is actually due', () => {
    expect(findMeasurementGaps(seed, '2026-09-19')).toHaveLength(0);
    const due = findMeasurementGaps(seed, '2026-09-21');
    expect(due.map((g) => `${g.title} ${g.window}`)).toContain(
      'SiteLaunch BTS Story 7d',
    );
  });

  it('stops chasing a window that is far past recovering', () => {
    const stale = findMeasurementGaps(seed, '2027-01-01');
    expect(stale).toHaveLength(0);
  });

  it('agrees with recommendation rule R5, which reads the same function', () => {
    for (const day of ['2026-09-14', '2026-09-21', '2026-10-05']) {
      const gaps = findMeasurementGaps(seed, day);
      const fired = generateRecommendations(seed, day).some(
        (r) => r.rule_id === 'R5_measurement_gap',
      );
      expect(fired).toBe(gaps.length > 0);
    }
  });
});

describe('recommendation prose', () => {
  it('pluralises format names properly rather than appending an s', () => {
    const prose = generateRecommendations(buildSeedDataset(), '2026-09-14')
      .map((r) => `${r.headline} ${r.detail} ${r.suggested_action ?? ''}`)
      .join(' ');
    expect(prose).toMatch(/stories/);
    expect(prose).not.toMatch(/storys/);
  });

  it('never writes "storys", "carousels" aside, for any format', () => {
    for (const bad of ['storys', 'Storys']) {
      expect(
        generateRecommendations(buildSeedDataset(), '2026-09-14')
          .map((r) => r.headline)
          .join(' '),
      ).not.toContain(bad);
    }
  });
});
