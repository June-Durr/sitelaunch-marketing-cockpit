/**
 * Deterministic recommendation rules. No model, no training, no prediction.
 *
 * Every statement produced here carries the cohort it was computed from, the
 * sample size, and the numbers. Three hard constraints govern the wording:
 *
 *   1. Below MIN_PATTERN comparable items nothing may be said to "work", "perform
 *      better" or be worth "scaling". The permitted verbs are *suggests*, *may*,
 *      and *not yet measurable*.
 *   2. Leads and qualified conversations outrank reach. A rule never recommends
 *      repeating something on view count alone.
 *   3. Externally amplified content is excluded from every average and said to be.
 */

import type {
  ConfidenceLabel, Dataset, MetricKey, Recommendation, RecommendationEvidence,
} from '../types/domain';
import { FORMAT_PLURALS, PLATFORM_LABELS, WINDOW_LABELS, formatNoun } from '../types/domain';
import { aggregate } from '../lib/metrics';
import { formatMean, formatNumber } from '../lib/format';
import { toDayString, today } from '../lib/dates';
import { findMeasurementGaps } from './measurement';
import { buildCohorts, memberLeads, memberSessions, type Cohort, type CohortMember } from './cohorts';

/** Comparable items required before a pattern may be named at all. */
export const MIN_PATTERN = 5;
/** Comparable items required before a pattern is called reliable. */
export const MIN_RELIABLE = 12;

export type GeneratedRecommendation = Omit<
  Recommendation,
  'id' | 'created_at' | 'dismissed_at'
>;

function confidenceFor(sampleSize: number, distinctPillars: number): ConfidenceLabel {
  if (sampleSize >= MIN_RELIABLE && distinctPillars >= 2) return 'reliable_pattern';
  if (sampleSize >= MIN_PATTERN) return 'emerging_pattern';
  return 'early_signal';
}

function cohortEvidence(cohort: Cohort, lines: RecommendationEvidence['lines']): RecommendationEvidence {
  return {
    lines: [
      {
        label: 'Comparison set',
        value: `${PLATFORM_LABELS[cohort.platform]} ${FORMAT_PLURALS[cohort.format]}, measured at ${WINDOW_LABELS[cohort.window]}`,
      },
      { label: 'Items compared', value: String(cohort.members.length), derived: true },
      ...lines,
    ],
    content_item_ids: cohort.members.map((m) => m.item.id),
    excluded: cohort.excluded,
  };
}

function isAbsentOrZero(value: number | null): boolean {
  return value === null || value === 0;
}

function meanOf(members: CohortMember[], key: MetricKey) {
  return aggregate(members.map((m) => m.snapshot[key]));
}

/* ======================================================================== */

export function generateRecommendations(
  data: Dataset,
  now: string = today(),
): GeneratedRecommendation[] {
  const cohorts = buildCohorts(data);
  const out: GeneratedRecommendation[] = [];
  const generated_at = new Date().toISOString();

  for (const cohort of cohorts) {
    out.push(...ruleDownstreamWinners(cohort, generated_at));
    out.push(...ruleTrafficProducers(cohort, generated_at));
    out.push(...ruleEngagedButInert(cohort, generated_at));
    out.push(...ruleViewsWithoutAction(cohort, generated_at));
    out.push(...ruleInsufficientEvidence(cohort, generated_at));
    out.push(...ruleAmplificationNotice(cohort, generated_at));
  }

  out.push(...ruleMeasurementGaps(data, now, generated_at));

  // Downstream outcomes first, data problems next, caveats last. Views never lead.
  const priority: Record<string, number> = {
    R1_downstream_winner: 1,
    R2_traffic_producer: 2,
    R5_measurement_gap: 3,
    R3_engaged_but_inert: 4,
    R4_views_without_action: 5,
    R6_insufficient_evidence: 6,
    R7_amplification_notice: 7,
  };
  return out.sort((a, b) => (priority[a.rule_id] ?? 9) - (priority[b.rule_id] ?? 9));
}

/* ------------------------------------------------- R1 downstream winners -- */

function ruleDownstreamWinners(cohort: Cohort, generated_at: string): GeneratedRecommendation[] {
  if (cohort.members.length < MIN_PATTERN) return [];

  const leadValues = cohort.members.map((m) => memberLeads(m));
  const qualifiedValues = cohort.members.map((m) => m.snapshot.qualified_leads);
  const leadStats = aggregate(leadValues);
  const qualifiedStats = aggregate(qualifiedValues);
  if (leadStats.mean === null && qualifiedStats.mean === null) return [];

  const winners = cohort.members.filter((m) => {
    const leads = memberLeads(m);
    const qualified = m.snapshot.qualified_leads;
    return (
      (qualified !== null && qualifiedStats.mean !== null && qualified > qualifiedStats.mean) ||
      (leads !== null && leadStats.mean !== null && leads > leadStats.mean)
    );
  });
  if (winners.length === 0) return [];

  const best = winners.sort(
    (a, b) => (memberLeads(b) ?? 0) - (memberLeads(a) ?? 0),
  )[0];
  const confidence = confidenceFor(cohort.members.length, cohort.distinctPillars.length);

  return [
    {
      rule_id: 'R1_downstream_winner',
      headline: `${best.item.title} produced more recorded leads than comparable ${FORMAT_PLURALS[cohort.format]}`,
      detail:
        `Across ${cohort.members.length} ${PLATFORM_LABELS[cohort.platform]} ${FORMAT_PLURALS[cohort.format]} measured at ${WINDOW_LABELS[cohort.window]}, ` +
        `this item recorded ${formatNumber(memberLeads(best))} leads against a comparison average of ${formatMean(leadStats.mean)} ` +
        `(from ${leadStats.n} items where leads were actually recorded). ` +
        `This is the only signal in the tool that reflects business outcome rather than attention.`,
      suggested_action: `Do the same format, theme and ask again for "${best.item.title}" and record the same metrics so the comparison holds.`,
      confidence,
      cohort_platform: cohort.platform,
      cohort_format: cohort.format,
      sample_size: cohort.members.length,
      evidence: cohortEvidence(cohort, [
        { label: `${best.item.title}, enquiries`, value: formatNumber(memberLeads(best)) },
        { label: 'Average for similar posts', value: formatMean(leadStats.mean), derived: true },
        { label: 'Items with a recorded lead figure', value: `${leadStats.n} of ${cohort.members.length}` },
        {
          label: 'Items above the average',
          value: winners.map((w) => w.item.title).join('; '),
        },
      ]),
      generated_at,
    },
  ];
}

/* -------------------------------------------------- R2 traffic producers -- */

function ruleTrafficProducers(cohort: Cohort, generated_at: string): GeneratedRecommendation[] {
  const sessionStats = aggregate(cohort.members.map((m) => memberSessions(m)));
  const clickStats = meanOf(cohort.members, 'link_clicks');
  if (sessionStats.n === 0 && clickStats.n === 0) return [];

  const producers = cohort.members.filter((m) => {
    const sessions = memberSessions(m);
    const clicks = m.snapshot.link_clicks;
    return (
      (sessions !== null && sessions > 0 && sessionStats.mean !== null && sessions >= sessionStats.mean) ||
      (clicks !== null && clicks > 0 && clickStats.mean !== null && clicks >= clickStats.mean)
    );
  });
  if (producers.length === 0) return [];

  const enough = cohort.members.length >= MIN_PATTERN;
  const confidence = confidenceFor(cohort.members.length, cohort.distinctPillars.length);
  const names = producers.map((p) => p.item.title).join('; ');

  return [
    {
      rule_id: 'R2_traffic_producer',
      headline: enough
        ? `${producers.length === 1 ? 'One item' : `${producers.length} items`} sent measurable traffic to the website`
        : `Measurable website traffic recorded, on too few items to call a pattern`,
      detail:
        `${names} carried recorded website sessions or link clicks. ` +
        (enough
          ? `Compared against ${cohort.members.length} ${PLATFORM_LABELS[cohort.platform]} ${FORMAT_PLURALS[cohort.format]} at ${WINDOW_LABELS[cohort.window]}.`
          : `Only ${cohort.members.length} comparable ${FORMAT_PLURALS[cohort.format]} exist, so this suggests rather than shows a link between the format and traffic. ${MIN_PATTERN - cohort.members.length} more comparable items are needed.`) +
        ` Traffic here means sessions or clicks recorded against this specific item, not account-wide totals.`,
      suggested_action: enough
        ? `Repeat this format with the same tracked CTA, and keep the UTM campaign distinct so the next comparison is cleaner.`
        : `Keep publishing this format with tracked UTMs. Re-check once ${MIN_PATTERN} comparable items exist.`,
      confidence,
      cohort_platform: cohort.platform,
      cohort_format: cohort.format,
      sample_size: cohort.members.length,
      evidence: cohortEvidence(cohort, [
        { label: 'Average website sessions', value: formatMean(sessionStats.mean), derived: true },
        { label: 'Items with a recorded sessions figure', value: `${sessionStats.n} of ${cohort.members.length}` },
        { label: 'Average link clicks', value: formatMean(clickStats.mean), derived: true },
        ...producers.map((p) => ({
          label: `${p.item.title}, visits and clicks`,
          value: `${formatNumber(memberSessions(p))} / ${formatNumber(p.snapshot.link_clicks)}`,
        })),
      ]),
      generated_at,
    },
  ];
}

/* ------------------------------------------------- R3 engaged but inert --- */

function ruleEngagedButInert(cohort: Cohort, generated_at: string): GeneratedRecommendation[] {
  const saveStats = meanOf(cohort.members, 'saves');
  const shareStats = meanOf(cohort.members, 'shares');
  if (saveStats.n === 0 && shareStats.n === 0) return [];

  // Prefer a pillar-level statement when pillars exist: "educational carousels
  // produced more saves than other carousels" is more actionable than a single post.
  const byPillar = new Map<string, CohortMember[]>();
  for (const m of cohort.members) {
    if (!m.item.pillar) continue;
    const list = byPillar.get(m.item.pillar) ?? [];
    list.push(m);
    byPillar.set(m.item.pillar, list);
  }

  for (const [pillar, group] of byPillar) {
    if (group.length < 2) continue;
    const rest = cohort.members.filter((m) => m.item.pillar !== pillar);
    if (rest.length === 0) continue;

    const groupSaves = aggregate(group.map((m) => m.snapshot.saves));
    const restSaves = aggregate(rest.map((m) => m.snapshot.saves));
    const groupShares = aggregate(group.map((m) => m.snapshot.shares));
    const restShares = aggregate(rest.map((m) => m.snapshot.shares));

    const savesHigher =
      groupSaves.mean !== null && restSaves.mean !== null && groupSaves.mean > restSaves.mean;
    const sharesHigher =
      groupShares.mean !== null && restShares.mean !== null && groupShares.mean > restShares.mean;
    if (!savesHigher && !sharesHigher) continue;

    const noTraffic = group.every(
      (m) => isAbsentOrZero(memberSessions(m)) && isAbsentOrZero(m.snapshot.link_clicks),
    );
    if (!noTraffic) continue;

    const metric = savesHigher ? 'saves' : 'shares';
    const groupStat = savesHigher ? groupSaves : groupShares;
    const restStat = savesHigher ? restSaves : restShares;

    return [
      {
        rule_id: 'R3_engaged_but_inert',
        headline: `${pillar} ${PLATFORM_LABELS[cohort.platform]} ${FORMAT_PLURALS[cohort.format]} earn ${metric} but no measurable website traffic`,
        detail:
          `${pillar} items averaged ${formatMean(groupStat.mean)} ${metric} against ${formatMean(restStat.mean)} for other ${FORMAT_PLURALS[cohort.format]} in this cohort, ` +
          `yet none of them has a recorded website session or link click. ` +
          `That gap is about the call to action and the tracking, not about the content: engagement is happening and stopping on the platform.`,
        suggested_action: `Repeat the format with a clearer tracked CTA and a distinct UTM campaign, then record link clicks and sessions at the next measurement window.`,
        confidence: confidenceFor(cohort.members.length, cohort.distinctPillars.length),
        cohort_platform: cohort.platform,
        cohort_format: cohort.format,
        sample_size: cohort.members.length,
        evidence: cohortEvidence(cohort, [
          { label: `${pillar}, average ${metric}`, value: formatMean(groupStat.mean), derived: true },
          { label: `Everything else, average ${metric}`, value: formatMean(restStat.mean), derived: true },
          { label: `${pillar} items`, value: String(group.length) },
          { label: 'Recorded website sessions across those items', value: 'None' },
        ]),
        generated_at,
      },
    ];
  }

  // No pillar grouping available, so fall back to naming individual items.
  const inert = cohort.members.filter((m) => {
    const saves = m.snapshot.saves;
    const shares = m.snapshot.shares;
    const engaged =
      (saves !== null && saveStats.mean !== null && saves > saveStats.mean) ||
      (shares !== null && shareStats.mean !== null && shares > shareStats.mean);
    return (
      engaged &&
      isAbsentOrZero(memberSessions(m)) &&
      isAbsentOrZero(m.snapshot.link_clicks)
    );
  });
  if (inert.length === 0) return [];

  return [
    {
      rule_id: 'R3_engaged_but_inert',
      headline: `${inert.length === 1 ? 'An item' : `${inert.length} items`} earned above-average shares or saves with no measurable traffic`,
      detail:
        `${inert.map((m) => m.item.title).join('; ')} sat above the comparison average for shares or saves, ` +
        `while recording no website sessions and no link clicks. ` +
        `Treat this as a tracking and CTA gap rather than a verdict on the content.`,
      suggested_action: `Add a tracked link with a distinct UTM campaign to the next item in this format, and record link clicks at the ${WINDOW_LABELS[cohort.window]} check.`,
      confidence: confidenceFor(cohort.members.length, cohort.distinctPillars.length),
      cohort_platform: cohort.platform,
      cohort_format: cohort.format,
      sample_size: cohort.members.length,
      evidence: cohortEvidence(cohort, [
        { label: 'Average saves', value: formatMean(saveStats.mean), derived: true },
        { label: 'Average shares', value: formatMean(shareStats.mean), derived: true },
        ...inert.map((m) => ({
          label: `${m.item.title}, saves and shares`,
          value: `${formatNumber(m.snapshot.saves)} / ${formatNumber(m.snapshot.shares)}`,
        })),
      ]),
      generated_at,
    },
  ];
}

/* --------------------------------------------- R4 views without action ---- */

function ruleViewsWithoutAction(cohort: Cohort, generated_at: string): GeneratedRecommendation[] {
  const viewStats = meanOf(cohort.members, 'views');
  if (viewStats.mean === null) return [];

  const flagged = cohort.members.filter((m) => {
    const views = m.snapshot.views;
    if (views === null || viewStats.mean === null || views <= viewStats.mean) return false;
    return (
      isAbsentOrZero(m.snapshot.link_clicks) &&
      isAbsentOrZero(memberSessions(m)) &&
      isAbsentOrZero(memberLeads(m))
    );
  });
  if (flagged.length === 0) return [];

  return [
    {
      rule_id: 'R4_views_without_action',
      headline: `${flagged.length === 1 ? 'An item' : `${flagged.length} items`} drew above-average views with nothing recorded downstream`,
      detail:
        `${flagged.map((m) => m.item.title).join('; ')} exceeded the comparison average of ${formatMean(viewStats.mean)} views, ` +
        `but has no recorded link clicks, website sessions or leads. ` +
        `Views are attention, not outcome, and this tool does not treat them as a result. ` +
        `Careful though: a blank does not mean nothing happened, it may just mean nobody checked. Confirm before deciding the post failed.`,
      suggested_action: `Check whether the downstream metrics were actually measured. If they were, put a tracked CTA on the next item in this format rather than repeating the hook.`,
      confidence: confidenceFor(cohort.members.length, cohort.distinctPillars.length),
      cohort_platform: cohort.platform,
      cohort_format: cohort.format,
      sample_size: cohort.members.length,
      evidence: cohortEvidence(cohort, [
        { label: 'Average views', value: formatMean(viewStats.mean), derived: true },
        { label: 'Items with a recorded views figure', value: `${viewStats.n} of ${cohort.members.length}` },
        ...flagged.map((m) => ({
          label: `${m.item.title}, views then clicks then visits`,
          value: `${formatNumber(m.snapshot.views)} / ${formatNumber(m.snapshot.link_clicks)} / ${formatNumber(memberSessions(m))}`,
        })),
      ]),
      generated_at,
    },
  ];
}

/* ------------------------------------------------- R5 measurement gaps ---- */

function ruleMeasurementGaps(
  data: Dataset,
  now: string,
  generated_at: string,
): GeneratedRecommendation[] {
  const overdue = findMeasurementGaps(data, now);
  if (overdue.length === 0) return [];

  return [
    {
      rule_id: 'R5_measurement_gap',
      headline: `${overdue.length} measurement ${overdue.length === 1 ? 'check is' : 'checks are'} overdue`,
      detail:
        `These readings were due and have not been recorded: ` +
        `${overdue.map((o) => `${o.title} (${WINDOW_LABELS[o.window]}, due ${o.due})`).join('; ')}. ` +
        `This is a data problem, not a performance result. Stories in particular expire, and an unrecorded 24-hour reading cannot be recovered later.`,
      suggested_action: `Record the missing snapshots, or mark the metric unavailable if the platform genuinely does not report it.`,
      confidence: 'early_signal',
      cohort_platform: null,
      cohort_format: null,
      sample_size: overdue.length,
      evidence: {
        lines: overdue.map((o) => ({
          label: `${o.title}, the ${WINDOW_LABELS[o.window]} check`,
          value: `due ${o.due}`,
        })),
        content_item_ids: [],
        excluded: [],
      },
      generated_at,
    },
  ];
}

/* --------------------------------------------- R6 insufficient evidence --- */

function ruleInsufficientEvidence(cohort: Cohort, generated_at: string): GeneratedRecommendation[] {
  if (cohort.members.length >= MIN_PATTERN) return [];

  const needed = MIN_PATTERN - cohort.members.length;
  return [
    {
      rule_id: 'R6_insufficient_evidence',
      headline: `Not yet measurable: ${PLATFORM_LABELS[cohort.platform]} ${FORMAT_PLURALS[cohort.format]}`,
      detail:
        `There ${cohort.members.length === 1 ? 'is 1 comparable item' : `are ${cohort.members.length} comparable items`} in this format, ` +
        `and ${MIN_PATTERN} are required before this tool will draw a conclusion from them. ` +
        `${needed} more comparable ${needed === 1 ? 'item' : 'items'} measured at ${WINDOW_LABELS[cohort.window]} would allow a first pattern.` +
        (cohort.excluded.length
          ? ` ${cohort.excluded.length} ${cohort.excluded.length === 1 ? 'post was' : 'posts were'} left out. Open the numbers below to see why.`
          : ''),
      suggested_action: `Publish and measure ${needed} more ${PLATFORM_LABELS[cohort.platform]} ${formatNoun(cohort.format, needed)} with consistent tracking before drawing conclusions.`,
      confidence: 'early_signal',
      cohort_platform: cohort.platform,
      cohort_format: cohort.format,
      sample_size: cohort.members.length,
      evidence: cohortEvidence(cohort, [
        { label: 'Items required for a pattern', value: String(MIN_PATTERN) },
        { label: 'Items still needed', value: String(needed), derived: true },
      ]),
      generated_at,
    },
  ];
}

/* ------------------------------------------- R7 amplification notice ------ */

function ruleAmplificationNotice(cohort: Cohort, generated_at: string): GeneratedRecommendation[] {
  const amplified = cohort.excluded.filter((e) => e.reason.startsWith('Externally amplified'));
  if (amplified.length === 0) return [];

  return [
    {
      rule_id: 'R7_amplification_notice',
      headline: `${amplified.length} externally amplified ${amplified.length === 1 ? 'item is' : 'items are'} excluded from ${PLATFORM_LABELS[cohort.platform]} ${formatNoun(cohort.format, 1)} averages`,
      detail:
        `${amplified.map((a) => a.title).join('; ')} ${amplified.length === 1 ? 'is' : 'are'} held out of every comparison in this format. ` +
        `Reach that came from another account's audience says nothing about whether the content earns attention on its own, and averaging it in would quietly raise the bar for every future post.` +
        ` The ${amplified.length === 1 ? 'item remains' : 'items remain'} visible in the Content Log, labelled.`,
      suggested_action: null,
      confidence: 'early_signal',
      cohort_platform: cohort.platform,
      cohort_format: cohort.format,
      sample_size: cohort.members.length,
      evidence: {
        lines: amplified.map((a) => ({ label: a.title, value: 'Excluded from averages' })),
        content_item_ids: amplified.map((a) => a.id),
        excluded: amplified,
      },
      generated_at,
    },
  ];
}

/* --------------------------------------------------------- next step ----- */

export interface NextStep {
  title: string;
  why: string;
  href: string;
}

/**
 * The single most important thing to do next. Ordered by consequence: an expiring
 * measurement is unrecoverable, a cold lead is recoverable but decaying, and
 * publishing is the thing that eventually produces both.
 */
export function pickNextStep(data: Dataset, now: string = today()): NextStep | null {
  const openTasks = data.tasks.filter((t) => t.status === 'open');

  const overdueMeasurement = openTasks
    .filter((t) => t.task_type === 'measurement_check' && t.due_date <= now)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  if (overdueMeasurement) {
    return {
      title: overdueMeasurement.title,
      why:
        overdueMeasurement.due_date < now
          ? `This was due on ${overdueMeasurement.due_date}. Platforms delete these numbers after a while, so this is the one job on your list that gets permanently harder every day you leave it.`
          : `Due today. Write the numbers down while the platform still shows them.`,
      href: '/tasks',
    };
  }

  const staleLead = data.leads
    .filter(
      (l) =>
        !['won', 'lost'].includes(l.stage) &&
        l.next_action_date !== null &&
        l.next_action_date <= now,
    )
    .sort((a, b) => (a.next_action_date ?? '').localeCompare(b.next_action_date ?? ''))[0];
  if (staleLead) {
    return {
      title: staleLead.next_action ?? `Follow up with ${staleLead.prospect_name}`,
      why: `${staleLead.prospect_name} was due a follow-up on ${staleLead.next_action_date}. Chasing someone who already knows who you are beats posting for strangers.`,
      href: '/pipeline',
    };
  }

  const todaysAction = openTasks
    .filter(
      (t) =>
        (t.task_type === 'publish' || t.task_type === 'marketing_action') &&
        t.due_date <= now,
    )
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  if (todaysAction) {
    return {
      title: todaysAction.title,
      why: `Scheduled for ${todaysAction.due_date}. Nothing is overdue and nobody is waiting on you, so getting this out is the best use of today.`,
      href: '/tasks',
    };
  }

  const unmeasured = data.contentItems.filter(
    (c) =>
      c.status === 'published' &&
      c.published_at &&
      !data.snapshots.some((s) => s.content_item_id === c.id),
  );
  if (unmeasured.length > 0) {
    return {
      title: `Record a first snapshot for "${unmeasured[0].title}"`,
      why: `You posted this on ${toDayString(unmeasured[0].published_at as string)} and never wrote down how it did. Until something is measured, the app has nothing to compare.`,
      href: '/content',
    };
  }

  const cohorts = buildCohorts(data);
  const thinnest = cohorts.filter((c) => c.members.length < MIN_PATTERN)[0];
  if (thinnest) {
    return {
      title: `Publish another ${PLATFORM_LABELS[thinnest.platform]} ${formatNoun(thinnest.format, 1)}`,
      why: `You have ${thinnest.members.length} of the ${MIN_PATTERN} similar posts the app needs before it can tell you anything useful about this format. More measured posts is the only way through.`,
      href: '/content',
    };
  }

  return null;
}
