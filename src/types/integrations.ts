/**
 * Integration types, mirroring supabase/migrations/0005_integrations.sql.
 *
 * Nothing is connected. These describe the rows a server side sync will write and
 * the browser will read. No token ever appears here, because anything the browser
 * can read a user can read. See server/README.md.
 */

export type IntegrationProvider =
  | 'ga4' | 'search_console' | 'google_calendar' | 'instagram'
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
 * connected to revenue.
 */
export const RECOMMENDED_ORDER: IntegrationProvider[] = [
  'ga4',
  'search_console',
  'website_forms',
  'google_calendar',
  'instagram',
  'facebook',
  'linkedin',
  'tiktok',
];

export const PROVIDER_NOTES: Record<IntegrationProvider, string> = {
  ga4: 'Daily website visits by source, so a post can be tied to real traffic.',
  search_console: 'What people searched for before they landed on the site.',
  website_forms: 'Enquiries from the site, landing straight in the Pipeline.',
  google_calendar: 'Tasks out to the calendar, events back in as activity.',
  instagram: 'Post level numbers, so they stop being typed in by hand.',
  facebook: 'Page level numbers. Stories will stay unavailable whatever happens.',
  linkedin: 'Later. Worth it only if LinkedIn becomes a real channel.',
  tiktok: 'Later, and only if it earns a place.',
};
