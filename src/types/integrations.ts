/**
 * Integration types, mirroring supabase/migrations/0005_integrations.sql.
 *
 * GA4 and Search Console are connected and syncing daily; the rest of the
 * providers below are still to come. These describe the rows the server side sync
 * writes and the browser reads. No token ever appears here, because anything the
 * browser can read a user can read. See server/README.md.
 */

export type IntegrationProvider =
  | 'ga4' | 'search_console' | 'google_sheets' | 'google_calendar' | 'instagram'
  | 'facebook' | 'linkedin' | 'tiktok' | 'website_forms';

export type IntegrationStatus =
  | 'not_configured' | 'ready' | 'connected' | 'syncing' | 'error';

export type SyncStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export interface IntegrationConnection {
  id: string;
  provider: IntegrationProvider;
  provider_account_id: string | null;
  display_name: string | null;
  status: IntegrationStatus;
  granted_scopes: string[];
  connected_at: string | null;
  last_synced_at: string | null;
  error_message: string | null;
  error_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncRun {
  id: string;
  connection_id: string | null;
  provider: IntegrationProvider;
  started_at: string;
  completed_at: string | null;
  status: SyncStatus;
  rows_read: number | null;
  rows_written: number | null;
  error_summary: string | null;
  idempotency_key: string;
  /**
   * Counts a run produced that two numbers cannot carry, written server side
   * through the sanitizer. Shape varies by provider, so it is read defensively.
   */
  details: Record<string, unknown>;
  created_at: string;
}

/** One day of GA4 traffic for one source, medium and campaign. */
export interface Ga4DailyTraffic {
  id: string;
  connection_id: string | null;
  date: string;
  source: string;
  medium: string;
  campaign: string;
  sessions: number | null;
  active_users: number | null;
  new_users: number | null;
  engaged_sessions: number | null;
  engagement_time_secs: number | null;
  bounce_rate: number | null;
  conversions: number | null;
  generate_lead_events: number | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface SearchConsoleDaily {
  id: string;
  connection_id: string | null;
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  average_position: number | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  ga4: 'Google Analytics',
  search_console: 'Google Search Console',
  google_sheets: 'Google Sheets lead mirror',
  website_forms: 'Website enquiry forms',
  google_calendar: 'Google Calendar',
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
};

/** Plain wording for each state, so a status is never ambiguous. */
export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  not_configured: 'Not set up',
  ready: 'Ready to connect',
  connected: 'Connected',
  syncing: 'Syncing now',
  error: 'Something went wrong',
};

export const STATUS_EXPLANATIONS: Record<IntegrationStatus, string> = {
  not_configured: 'Nothing has been set up for this yet.',
  ready: 'The server side has what it needs. Connecting is the next step.',
  connected: 'Connected and bringing data in.',
  syncing: 'Fetching data right now.',
  error: 'The last attempt failed. The reason is recorded against the connection.',
};

/**
 * The order these should be connected in, and why.
 *
 * Website numbers first, because they are the ones tied to enquiries, and enquiries
 * are the only thing in this app that counts as a business result. Social platforms
 * last, because their content level numbers are the least reliable and the least
 * connected to revenue. The first two are done, which is why the list is split.
 */
export const RECOMMENDED_ORDER: IntegrationProvider[] = [
  'ga4',
  'search_console',
  'google_sheets',
  'website_forms',
  'google_calendar',
  'instagram',
  'facebook',
  'linkedin',
  'tiktok',
];

/**
 * The two that sync themselves, and whose real state belongs to GoogleSyncPanel.
 *
 * Anything listing providers for the user to act on should leave these out rather
 * than render a second, duller copy of a state that is already on screen.
 */
export const SYNCING_PROVIDERS: IntegrationProvider[] = [
  'ga4', 'search_console', 'google_sheets',
];

/** RECOMMENDED_ORDER minus the two that already sync. Still in the same order. */
export const REMAINING_ORDER: IntegrationProvider[] = RECOMMENDED_ORDER.filter(
  (p) => !SYNCING_PROVIDERS.includes(p),
);

export const PROVIDER_NOTES: Record<IntegrationProvider, string> = {
  ga4: 'Daily website visits by source, so a post can be tied to real traffic.',
  search_console: 'What people searched for before they landed on the site.',
  google_sheets:
    'A readable mirror of the pipeline, rewritten from the database. Never read back as truth.',
  website_forms: 'Enquiries from the site, landing straight in the Pipeline.',
  google_calendar: 'Tasks out to the calendar, events back in as activity.',
  instagram: 'Post level numbers, so they stop being typed in by hand.',
  facebook: 'Page level numbers. Stories will stay unavailable whatever happens.',
  linkedin: 'Later. Worth it only if LinkedIn becomes a real channel.',
  tiktok: 'Later, and only if it earns a place.',
};
