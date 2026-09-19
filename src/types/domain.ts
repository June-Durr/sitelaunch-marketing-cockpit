/**
 * Domain types. Mirrors supabase/migrations/0001_init.sql.
 *
 * Metric fields are `number | null` everywhere. `null` means "not recorded" and must
 * never be coerced to 0: averages, comparisons and display all treat it as absent.
 */

export type Platform =
  | 'instagram' | 'facebook' | 'linkedin' | 'tiktok'
  | 'youtube' | 'x' | 'email' | 'blog' | 'other';

export type ContentFormat =
  | 'story' | 'reel' | 'carousel' | 'post' | 'article' | 'video' | 'other';

export type ContentStatus = 'draft' | 'scheduled' | 'published' | 'measured';

export type SnapshotWindow = '24h' | '7d' | '30d' | 'custom';

export type IngestSource = 'manual' | 'csv' | 'api';

export type LeadStage =
  | 'new_contact' | 'follow_up' | 'qualified' | 'call_scheduled'
  | 'proposal' | 'waiting' | 'won' | 'lost';

export type TaskType =
  | 'marketing_action' | 'publish' | 'follow_up' | 'measurement_check' | 'admin';

export type TaskStatus = 'open' | 'done' | 'skipped';

export type ConfidenceLabel = 'early_signal' | 'emerging_pattern' | 'reliable_pattern';

/**
 * What actually happened, as opposed to what is planned.
 *
 * A task is something you intend to do. An activity is a record that something
 * took place. The two are deliberately separate: a task list tells you about the
 * future and can be wrong, an activity log tells you about the past and should not
 * be. Nothing in this app ever invents an activity from historical data.
 */
export type ActivityType =
  | 'content_published' | 'networking_event' | 'contact_added' | 'follow_up_sent'
  | 'reply_received' | 'client_work' | 'website_update' | 'analytics_check'
  | 'lead_created' | 'proposal_sent' | 'revenue_received' | 'unavailable'
  | 'decision' | 'other';

/** Where an activity record came from. Never guessed. */
export type ActivitySource = 'manual' | 'task_completion' | 'calendar' | 'import' | 'api';

/** Calendar sync state. Nothing is connected yet, so everything starts not_synced. */
export type CalendarSyncStatus = 'not_synced' | 'pending' | 'synced' | 'error';

export interface Account {
  id: string;
  platform: Platform;
  handle: string;
  display_name: string | null;
  provider_account_id: string | null;
  is_active: boolean;
  notes: string | null;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

export interface ContentItem {
  id: string;
  account_id: string | null;
  cross_post_group_id: string | null;

  title: string;
  format: ContentFormat;
  status: ContentStatus;
  published_at: string | null;

  pillar: string | null;
  target_audience: string | null;
  hook: string | null;
  cta: string | null;

  destination_url: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;

  is_externally_amplified: boolean;
  amplifier_name: string | null;
  amplification_note: string | null;

  notes: string | null;
  screenshot_url: string | null;
  external_id: string | null;

  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

/** The metric columns of a snapshot, all optional observations. */
export interface SnapshotMetrics {
  views: number | null;
  reach: number | null;
  watch_time_seconds: number | null;
  three_second_views: number | null;
  interactions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  replies: number | null;
  profile_visits: number | null;
  link_clicks: number | null;
  website_sessions: number | null;
  form_starts: number | null;
  leads: number | null;
  qualified_leads: number | null;
}

export type MetricKey = keyof SnapshotMetrics;

export interface PerformanceSnapshot extends SnapshotMetrics {
  id: string;
  content_item_id: string;
  window_type: SnapshotWindow;
  captured_at: string;

  /** The platform does not report this metric at all, which is different from "not checked yet". */
  metrics_unavailable: boolean;
  unavailable_reason: string | null;

  ingest_source: IngestSource;
  notes: string | null;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

export interface TrafficSnapshot {
  id: string;
  content_item_id: string | null;

  range_start: string;
  range_end: string;

  source: string | null;
  medium: string | null;
  campaign: string | null;

  sessions: number | null;
  active_users: number | null;
  engagement_time_secs: number | null;
  engaged_sessions: number | null;
  cta_clicks: number | null;
  form_starts: number | null;
  generate_lead_events: number | null;
  qualified_inquiries: number | null;

  ingest_source: IngestSource;
  notes: string | null;
  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

export interface Lead {
  id: string;
  content_item_id: string | null;

  prospect_name: string;
  organization: string | null;
  email: string | null;
  phone: string | null;

  project: string | null;
  source: string | null;
  related_campaign: string | null;

  stage: LeadStage;
  next_action: string | null;
  next_action_date: string | null;

  proposed_value: number | null;
  closed_value: number | null;

  attribution_note: string | null;
  notes: string | null;

  is_seed: boolean;
  first_contact_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  content_item_id: string | null;
  lead_id: string | null;

  title: string;
  task_type: TaskType;
  status: TaskStatus;
  due_date: string;
  window_type: SnapshotWindow | null;
  notes: string | null;
  completed_at: string | null;

  /* Calendar fields. Reserved for a future sync; nothing writes them yet. */
  external_calendar_id: string | null;
  external_event_id: string | null;
  calendar_sync_status: CalendarSyncStatus;
  last_synced_at: string | null;
  sync_error: string | null;

  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

/** A record that something happened. See ActivityType for the distinction. */
export interface ActivityEvent {
  id: string;
  /** When it happened, not when it was typed in. */
  occurred_at: string;
  activity_type: ActivityType;
  title: string;
  details: string | null;
  source: ActivitySource;
  /** An id from whatever system this came from, for future syncs. */
  external_id: string | null;

  content_item_id: string | null;
  lead_id: string | null;
  task_id: string | null;

  /* Calendar fields, same reservation as on Task. */
  external_calendar_id: string | null;
  external_event_id: string | null;
  calendar_sync_status: CalendarSyncStatus;
  last_synced_at: string | null;
  sync_error: string | null;

  is_seed: boolean;
  created_at: string;
  updated_at: string;
}

/** One line of the arithmetic behind a recommendation. */
export interface EvidenceLine {
  label: string;
  value: string;
  /** Marks a value the app calculated rather than one a human observed. */
  derived?: boolean;
}

export interface RecommendationEvidence {
  lines: EvidenceLine[];
  content_item_ids: string[];
  /** Items deliberately kept out of the comparison, with the reason. */
  excluded: { id: string; title: string; reason: string }[];
}

export interface Recommendation {
  id: string;
  rule_id: string;
  headline: string;
  detail: string;
  suggested_action: string | null;
  confidence: ConfidenceLabel;

  cohort_platform: Platform | null;
  cohort_format: ContentFormat | null;
  sample_size: number;

  evidence: RecommendationEvidence;

  generated_at: string;
  dismissed_at: string | null;
  created_at: string;
}

/** Everything the UI reads. Loaded once, refreshed on mutation. */
export interface Dataset {
  accounts: Account[];
  contentItems: ContentItem[];
  snapshots: PerformanceSnapshot[];
  traffic: TrafficSnapshot[];
  leads: Lead[];
  tasks: Task[];
  recommendations: Recommendation[];
  activityEvents: ActivityEvent[];
}

// --- Display labels -------------------------------------------------------

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  email: 'Email',
  blog: 'Blog',
  other: 'Other',
};

export const FORMAT_LABELS: Record<ContentFormat, string> = {
  story: 'Story',
  reel: 'Reel',
  carousel: 'Carousel',
  post: 'Post',
  article: 'Article',
  video: 'Video',
  other: 'Other',
};

/** Lowercase plurals. "storys" is not a word, so the 's' is never just appended. */
export const FORMAT_PLURALS: Record<ContentFormat, string> = {
  story: 'stories',
  reel: 'reels',
  carousel: 'carousels',
  post: 'posts',
  article: 'articles',
  video: 'videos',
  other: 'items',
};

/** Format name in singular or plural, lowercase, for sentence use. */
export function formatNoun(format: ContentFormat, count: number): string {
  return count === 1 ? FORMAT_LABELS[format].toLowerCase() : FORMAT_PLURALS[format];
}

export const STATUS_LABELS: Record<ContentStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  published: 'Published',
  measured: 'Measured',
};

export const WINDOW_LABELS: Record<SnapshotWindow, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  custom: 'Custom',
};

export const STAGE_LABELS: Record<LeadStage, string> = {
  new_contact: 'New contact',
  follow_up: 'Follow-up',
  qualified: 'Qualified',
  call_scheduled: 'Call scheduled',
  proposal: 'Proposal',
  waiting: 'Waiting',
  won: 'Won',
  lost: 'Lost',
};

export const STAGE_ORDER: LeadStage[] = [
  'new_contact', 'follow_up', 'qualified', 'call_scheduled',
  'proposal', 'waiting', 'won', 'lost',
];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  marketing_action: 'Marketing action',
  publish: 'Publish',
  follow_up: 'Follow-up',
  measurement_check: 'Measurement check',
  admin: 'Admin',
};

/** Plain names for the activity types, with a line on what each one covers. */
export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  content_published: 'Published something',
  networking_event: 'Went to an event',
  contact_added: 'Added a contact',
  follow_up_sent: 'Sent a follow up',
  reply_received: 'Got a reply',
  client_work: 'Did client work',
  website_update: 'Updated the website',
  analytics_check: 'Checked the numbers',
  lead_created: 'New enquiry came in',
  proposal_sent: 'Sent a proposal',
  revenue_received: 'Got paid',
  unavailable: 'Was unavailable',
  decision: 'Made a decision',
  other: 'Something else',
};

export const ACTIVITY_TYPES = Object.keys(ACTIVITY_TYPE_LABELS) as ActivityType[];

/** Activity types that count as real business movement on the Today screen. */
export const MEANINGFUL_ACTIVITY: ActivityType[] = [
  'lead_created', 'proposal_sent', 'revenue_received', 'reply_received',
  'content_published', 'networking_event', 'follow_up_sent', 'decision',
];

export const ACTIVITY_SOURCE_LABELS: Record<ActivitySource, string> = {
  manual: 'Typed in by hand',
  task_completion: 'From finishing a task',
  calendar: 'From the calendar',
  import: 'Imported from a file',
  api: 'From a connected service',
};

export const CONFIDENCE_LABELS: Record<ConfidenceLabel, string> = {
  early_signal: 'Early Signal',
  emerging_pattern: 'Emerging Pattern',
  reliable_pattern: 'Reliable Pattern',
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  views: 'Views',
  reach: 'Reach / viewers',
  watch_time_seconds: 'Watch time (seconds)',
  three_second_views: 'Three-second views',
  interactions: 'Interactions',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
  saves: 'Saves',
  replies: 'Replies',
  profile_visits: 'Profile visits',
  link_clicks: 'Link clicks',
  website_sessions: 'Website sessions',
  form_starts: 'Form starts',
  leads: 'Leads',
  qualified_leads: 'Qualified leads',
};

export const METRIC_KEYS = Object.keys(METRIC_LABELS) as MetricKey[];


/**
 * What each metric is, in normal words, and why it matters.
 *
 * These are shown on screen next to the fields themselves, always visible. The
 * cockpit is built for someone who may not know marketing, so a number that cannot
 * explain itself is a number they cannot act on.
 */
export const METRIC_GUIDE: Record<MetricKey, { what: string; why: string }> = {
  views: {
    what: 'How many times it was seen. If one person watches twice, that counts twice.',
    why: 'Tells you how far it travelled, not whether anyone cared.',
  },
  reach: {
    what: 'How many separate people saw it.',
    why: 'Usually lower than views, and a truer picture of your actual audience size.',
  },
  watch_time_seconds: {
    what: 'Total seconds people spent watching.',
    why: 'Time is the honest version of attention. People do not fake it.',
  },
  three_second_views: {
    what: 'How many people watched at least three seconds instead of scrolling past.',
    why: 'Shows whether your opening seconds are doing their job.',
  },
  interactions: {
    what: 'Every tap, like, comment, share and save added together.',
    why: 'A rough total. The individual numbers below tell you much more.',
  },
  likes: {
    what: 'People who tapped the heart.',
    why: 'The cheapest signal there is. Easy to give, so it tells you the least.',
  },
  comments: {
    what: 'People who stopped and wrote something.',
    why: 'Costs real effort, so it means more than a like.',
  },
  shares: {
    what: 'People who sent it to someone else.',
    why: 'This is how you reach people who do not follow you yet.',
  },
  saves: {
    what: 'People who kept it to come back to later.',
    why: 'Usually means it was useful, not just enjoyable. Often your best early signal.',
  },
  replies: {
    what: 'People who messaged you back.',
    why: 'On stories this is often where an actual conversation starts.',
  },
  profile_visits: {
    what: 'People who went to look at who you are.',
    why: 'Someone checking you out is a step on the way to getting in touch.',
  },
  link_clicks: {
    what: 'People who tapped through to your website.',
    why: 'The first real sign of intent. They wanted to know more.',
  },
  website_sessions: {
    what: 'Visits to your site that came from this post.',
    why: 'Proof the post moved someone off the platform and onto your own ground.',
  },
  form_starts: {
    what: 'People who began filling in your contact form.',
    why: 'They were close. Worth knowing how many of these never finished.',
  },
  leads: {
    what: 'People who actually got in touch.',
    why: 'This is a business result. It outranks every number above it.',
  },
  qualified_leads: {
    what: 'People who got in touch and are a genuine fit for the work you do.',
    why: 'The number that matters most. Ten wrong-fit enquiries are worth less than one right one.',
  },
};

/** Metrics grouped by the question they answer, for entry and display. */
export interface MetricGroup {
  title: string;
  blurb: string;
  keys: MetricKey[];
}

export const METRIC_GROUPS: MetricGroup[] = [
  {
    title: 'Who saw it',
    blurb:
      'How far the post travelled. Useful background, but none of these are a result on their own.',
    keys: ['views', 'reach', 'three_second_views', 'watch_time_seconds'],
  },
  {
    title: 'What they did on the platform',
    blurb:
      'Whether people reacted. Shares and saves are worth more attention than likes, because they cost more effort.',
    keys: [
      'interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'profile_visits',
    ],
  },
  {
    title: 'What they did next',
    blurb:
      'Whether anyone actually moved toward becoming a customer. These are the numbers this whole tool is built around, and the ones most often left blank.',
    keys: [
      'link_clicks', 'website_sessions', 'form_starts', 'leads', 'qualified_leads',
    ],
  },
];

/** Metrics that indicate a business outcome, ranked above reach metrics. */
export const DOWNSTREAM_METRICS: MetricKey[] = [
  'qualified_leads', 'leads', 'form_starts', 'website_sessions', 'link_clicks',
];
