/**
 * Verified seed records, the TypeScript mirror of supabase/seed.sql.
 *
 * Only observed figures are entered. Everything unobserved stays null. The two
 * files must stay in step; if you change one, change the other.
 */

import type { Dataset, SnapshotMetrics } from '../types/domain';

const T = '2026-09-14T09:00:00.000Z'; // record-creation timestamp for seed rows

// Publish dates and capture times are date-only facts. Encoded as instants they sit
// at MIDDAY UTC so they resolve to the same calendar day in every timezone, because at
// UTC midnight they read as the previous day anywhere west of Greenwich, which
// would pull every measurement window forward by one.

/** All metrics absent. The starting point for every snapshot. */
export function blankMetrics(): SnapshotMetrics {
  return {
    views: null,
    reach: null,
    watch_time_seconds: null,
    three_second_views: null,
    interactions: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    replies: null,
    profile_visits: null,
    link_clicks: null,
    website_sessions: null,
    form_starts: null,
    leads: null,
    qualified_leads: null,
  };
}

const IG_ACCOUNT = 'acc-instagram-0001';
const FB_ACCOUNT = 'acc-facebook-0001';
const GROUP = 'grp-bts-story-2026-09';
export const SEED_IG_STORY = 'ci-bts-story-instagram';
export const SEED_FB_STORY = 'ci-bts-story-facebook';
export const SEED_OUTLIER = 'ci-outlier-only-in-dade';

export function buildSeedDataset(): Dataset {
  return {
    accounts: [
      {
        id: IG_ACCOUNT,
        platform: 'instagram',
        handle: '@sitelaunchstudios',
        display_name: 'SiteLaunch Studios (Instagram)',
        provider_account_id: null,
        is_active: true,
        notes: null,
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
      {
        id: FB_ACCOUNT,
        platform: 'facebook',
        handle: 'SiteLaunch Studios',
        display_name: 'SiteLaunch Studios (Facebook Page)',
        provider_account_id: null,
        is_active: true,
        notes:
          'Stories cross-posted from Instagram do not report content-level metrics here.',
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
    ],

    contentItems: [
      {
        id: SEED_IG_STORY,
        account_id: IG_ACCOUNT,
        cross_post_group_id: GROUP,
        title: 'SiteLaunch BTS Story',
        format: 'story',
        status: 'published',
        published_at: '2026-09-13T12:00:00.000Z',
        pillar: 'Behind the scenes',
        target_audience: 'Local service businesses considering a new website',
        hook: null,
        cta: 'Website link with tracked UTM',
        destination_url:
          'https://sitelaunchstudios.com/?utm_source=instagram&utm_medium=story&utm_campaign=bts_story_2026_09',
        utm_source: 'instagram',
        utm_medium: 'story',
        utm_campaign: 'bts_story_2026_09',
        is_externally_amplified: false,
        amplifier_name: null,
        amplification_note: null,
        notes:
          'Publish time of day not recorded. 24-hour reading taken from Instagram insights.',
        screenshot_url: null,
        external_id: null,
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
      {
        id: SEED_FB_STORY,
        account_id: FB_ACCOUNT,
        cross_post_group_id: GROUP,
        title: 'SiteLaunch BTS Story (Facebook cross-post)',
        format: 'story',
        status: 'published',
        published_at: '2026-09-13T12:00:00.000Z',
        pillar: 'Behind the scenes',
        target_audience: 'Local service businesses considering a new website',
        hook: null,
        cta: 'Website link with tracked UTM',
        destination_url:
          'https://sitelaunchstudios.com/?utm_source=facebook&utm_medium=story&utm_campaign=bts_story_2026_09',
        utm_source: 'facebook',
        utm_medium: 'story',
        utm_campaign: 'bts_story_2026_09',
        is_externally_amplified: false,
        amplifier_name: null,
        amplification_note: null,
        notes: 'Facebook reports no content-level metrics for this story.',
        screenshot_url: null,
        external_id: null,
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
      {
        id: SEED_OUTLIER,
        account_id: IG_ACCOUNT,
        cross_post_group_id: null,
        title: 'Instagram Story boosted by Only in Dade',
        format: 'story',
        status: 'measured',
        published_at: '2026-09-01T12:00:00.000Z',
        pillar: null,
        target_audience: null,
        hook: null,
        cta: null,
        destination_url: null,
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        is_externally_amplified: true,
        amplifier_name: 'Only in Dade',
        amplification_note:
          'Reach driven by a third-party account, not by the content or the audience. Excluded from all cohort averages.',
        notes:
          'No material business outcome reported. Kept as a record of what amplified reach looks like without downstream action.',
        screenshot_url: null,
        external_id: null,
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
    ],

    snapshots: [
      {
        ...blankMetrics(),
        id: 'ps-bts-ig-24h',
        content_item_id: SEED_IG_STORY,
        window_type: '24h',
        captured_at: '2026-09-14T12:00:00.000Z',
        views: 31,
        metrics_unavailable: false,
        unavailable_reason: null,
        ingest_source: 'manual',
        notes: 'Instagram story views at 24 hours. No other metric recorded.',
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
      {
        ...blankMetrics(),
        id: 'ps-bts-fb-24h',
        content_item_id: SEED_FB_STORY,
        window_type: '24h',
        captured_at: '2026-09-14T12:00:00.000Z',
        metrics_unavailable: true,
        unavailable_reason:
          'Facebook does not report content-level metrics for cross-posted Stories.',
        ingest_source: 'manual',
        notes: null,
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
      {
        ...blankMetrics(),
        id: 'ps-outlier-custom',
        content_item_id: SEED_OUTLIER,
        window_type: 'custom',
        captured_at: '2026-09-03T12:00:00.000Z',
        views: 30300,
        metrics_unavailable: false,
        unavailable_reason: null,
        ingest_source: 'manual',
        notes:
          'Approximate figure (~30,300). Externally amplified. No material business result reported.',
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
    ],

    traffic: [
      {
        id: 'ts-bts-facebook-story',
        content_item_id: SEED_FB_STORY,
        range_start: '2026-09-13',
        range_end: '2026-09-14',
        source: 'facebook',
        medium: 'story',
        campaign: 'bts_story_2026_09',
        sessions: 1,
        active_users: null,
        engagement_time_secs: null,
        engaged_sessions: null,
        cta_clicks: null,
        form_starts: null,
        generate_lead_events: null,
        qualified_inquiries: null,
        ingest_source: 'manual',
        notes:
          'GA4 source/medium facebook / story. Attributable lead: unknown, not shown in GA4.',
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
    ],

    leads: [],

    tasks: [
      {
        id: 'tk-bts-ig-7d',
        content_item_id: SEED_IG_STORY,
        lead_id: null,
        title: 'Record 7-day metrics for SiteLaunch BTS Story',
        task_type: 'measurement_check',
      follow_up_rule_managed: false,
        status: 'open',
        due_date: '2026-09-20',
        window_type: '7d',
        notes: 'Instagram story insights expire. Capture before the window closes.',
        completed_at: null,
        external_calendar_id: null,
        external_event_id: null,
        calendar_sync_status: 'not_synced',
        last_synced_at: null,
        sync_error: null,
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
      {
        id: 'tk-bts-fb-7d',
        content_item_id: SEED_FB_STORY,
        lead_id: null,
        title: 'Check GA4 for facebook / story sessions, 7-day window',
        task_type: 'measurement_check',
      follow_up_rule_managed: false,
        status: 'open',
        due_date: '2026-09-20',
        window_type: '7d',
        notes:
          'Facebook has no content-level metrics; GA4 is the only downstream signal.',
        completed_at: null,
        external_calendar_id: null,
        external_event_id: null,
        calendar_sync_status: 'not_synced',
        last_synced_at: null,
        sync_error: null,
        is_seed: true,
        created_at: T,
        updated_at: T,
      },
    ],

    recommendations: [],

    // No activity is shipped. Activity records what actually happened, and
    // inventing history from the seed would be exactly the lie this app avoids.
    activityEvents: [],
  };
}
