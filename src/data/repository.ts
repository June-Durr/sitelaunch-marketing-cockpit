import type {
  Account, ActivityEvent, ContentItem, Dataset, Lead, PerformanceSnapshot,
  Recommendation, Task, TrafficSnapshot,
} from '../types/domain';
import type {
  Ga4DailyTraffic, IntegrationConnection, SearchConsoleDaily, SyncRun,
} from '../types/integrations';

export interface TableMap {
  accounts: Account;
  content_items: ContentItem;
  performance_snapshots: PerformanceSnapshot;
  traffic_snapshots: TrafficSnapshot;
  leads: Lead;
  tasks: Task;
  recommendations: Recommendation;
  activity_events: ActivityEvent;
}

export type TableName = keyof TableMap;

/** A row as supplied by the UI: the database fills in id and timestamps. */
export type NewRow<K extends TableName> =
  Omit<TableMap[K], 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<TableMap[K], Extract<keyof TableMap[K], 'id'>>>;

export type RowPatch<K extends TableName> = Partial<Omit<TableMap[K], 'id'>>;

/** The order rows have to be written in so a child never lands before its parent. */
export const IMPORT_ORDER: TableName[] = [
  'accounts',
  'content_items',
  'leads',
  'tasks',
  'performance_snapshots',
  'traffic_snapshots',
  'recommendations',
  'activity_events',
];

/**
 * What an import did, table by table.
 *
 * Three outcomes are possible and the caller has to be able to tell them apart:
 * it refused before writing anything (`blockedBy` is non-empty), it wrote
 * everything (`failure` is null), or it hit a problem partway and undid its own
 * work (`failure` is set and `rolledBack` says whether the undo succeeded).
 */
export interface ImportReport {
  inserted: Record<TableName, number>;
  /** Tables that already held rows. Non-empty means nothing at all was written. */
  blockedBy: { table: TableName; existing: number }[];
  /** The table that failed, if one did. */
  failure: { table: TableName; message: string } | null;
  /** Null when no rollback was needed. */
  rolledBack: { ok: boolean; message: string | null } | null;
  /**
   * How many ids had to be rewritten because the database only accepts uuids and
   * browser-local mode does not. References were rewritten to match, so nothing
   * came unlinked, but the ids themselves differ from the backup.
   */
  remappedIds: number;
}

/** The two providers that sync automatically. */
export type AnalyticsProvider = 'ga4' | 'search_console';

/**
 * Which window a sync should ask for.
 *
 * 'daily' is the rolling week of completed days, 'backfill' is everything since
 * the agreed start date. The server decides what those mean; the browser only
 * names one. The sync window rules live with the server integration code, which
 * this file deliberately does not reference by path, because the browser must
 * never import across that boundary.
 */
export type SyncMode = 'daily' | 'backfill';

/**
 * Everything the Cockpit knows about automatic syncing, read straight from the
 * tables the server function writes.
 */
export interface AnalyticsStatus {
  connections: IntegrationConnection[];
  /** Most recent first, already trimmed to a useful number. */
  runs: SyncRun[];
  ga4: Ga4DailyTraffic[];
  searchConsole: SearchConsoleDaily[];
}

/** What came back from asking the server to sync. Never carries a credential. */
export interface SyncTriggerOutcome {
  ok: boolean;
  status: string;
  rowsWritten: number | null;
  /** Already sanitized server side. Safe to display. */
  error: string | null;
}

/* ------------------------------------------------------- the lead mirror --- */

/** What can be asked of the lead mirror function. */
export type LeadMirrorAction = 'reconcile' | 'export';

/** A reconciliation either reports or applies. There is no third option. */
export type ReconcileMode = 'dry_run' | 'live';

/** One spreadsheet row the import will not touch, and why, in words. */
export interface MirrorRowProblem {
  tab: string;
  rowNumber: number;
  label: string;
  reason: string;
}

export interface MirrorAmbiguity extends MirrorRowProblem {
  /** Ids of the leads a row could have meant, so it can be resolved by hand. */
  candidateIds: string[];
}

/**
 * What the mirror function reported. Never carries a credential.
 *
 * Every field is optional-shaped, because this is parsed from a server response
 * and a Cockpit that assumes a shape it did not get is a Cockpit that shows a
 * blank screen instead of an error.
 */
export interface LeadMirrorOutcome {
  ok: boolean;
  /** 'dry_run', 'applied', 'blocked', 'succeeded', 'failed' or a transport word. */
  status: string;
  counts: Record<string, number> | null;
  ambiguous: MirrorAmbiguity[];
  rejected: MirrorRowProblem[];
  warnings: string[];
  /** Why a live reconciliation refused to write. Empty when it did not. */
  gateReasons: string[];
  applied: { leadsCreated: number; leadsUpdated: number; touchesCreated: number } | null;
  /** Rows written to each tab by an export. */
  leadRows: number | null;
  touchRows: number | null;
  /** Already sanitized server side. Safe to display. */
  error: string | null;
}

/** Connection and run history for the mirror alone. */
export interface LeadMirrorStatus {
  connection: IntegrationConnection | null;
  /** Most recent first. */
  runs: SyncRun[];
}

/* ---------------------------------------------------- the follow-up calendar --- */

/** What the calendar sync reported. Never carries a credential. */
export interface CalendarSyncOutcome {
  ok: boolean;
  /** 'succeeded', 'failed', 'not_configured', or a transport word. */
  status: string;
  /** Events newly put on the calendar. */
  created: number | null;
  /** Events already there and brought up to date. */
  updated: number | null;
  failed: number | null;
  /** Open follow-up tasks considered. */
  tasks: number | null;
  /** Already sanitized server side. Safe to display. */
  error: string | null;
}

/** Connection and run history for the calendar alone. */
export interface CalendarStatus {
  connection: IntegrationConnection | null;
  /** Most recent first. */
  runs: SyncRun[];
}

/**
 * Where to send somebody to approve the calendar connection.
 *
 * The URL is built by the server, because it carries the OAuth client id and a
 * state the server has to have recorded first. A browser that invented its own
 * would produce a state nothing can verify.
 */
export interface CalendarOAuthStart {
  /** 'ready', 'not_configured', 'not_signed_in', or a transport word. */
  status: string;
  /** Google's consent screen. Null unless the status is 'ready'. */
  authorizeUrl: string | null;
  /** Already sanitized server side. Safe to display. */
  error: string | null;
}

/** What disconnecting reported. */
export interface CalendarDisconnectOutcome {
  ok: boolean;
  status: string;
  /**
   * Whether Google was also told to cancel the authorization.
   *
   * False does not mean the disconnection failed. The token is forgotten here
   * either way, which is what actually stops the Cockpit writing anything. This
   * says whether the courteous half worked, so the screen can be honest about it
   * rather than implying more than happened.
   */
  revokedAtGoogle: boolean;
  /** Always false in this version. Nothing is ever removed from a calendar. */
  eventsRemoved: boolean;
  error: string | null;
}

/**
 * The single data boundary of the application.
 *
 * Two adapters implement it in v1: browser-local storage (default, no account
 * required) and Supabase. A third adapter backed by platform APIs can be added
 * later without any screen changing, which is the whole point of the boundary.
 */
export interface Repository {
  readonly mode: 'local' | 'supabase';
  loadAll(): Promise<Dataset>;
  insert<K extends TableName>(table: K, row: NewRow<K>): Promise<TableMap[K]>;
  insertMany<K extends TableName>(table: K, rows: NewRow<K>[]): Promise<TableMap[K][]>;
  update<K extends TableName>(table: K, id: string, patch: RowPatch<K>): Promise<TableMap[K]>;
  remove<K extends TableName>(table: K, id: string): Promise<void>;
  /** Local adapter only: restore the verified seed records. */
  resetToSeed?(): Promise<void>;
  /**
   * Local adapter only: replace the entire dataset in one write, for restoring a
   * backup. Whole-dataset replacement, so a restore cannot leave half the tables
   * from the old data and half from the new.
   */
  replaceAll?(data: Dataset): Promise<void>;
  /** Rows currently held per table. Used to prove a database is empty before an import. */
  countAll?(): Promise<Record<TableName, number>>;
  /**
   * Supabase adapter only: everything the Cockpit shows about automatic syncing.
   *
   * Read only, and deliberately separate from loadAll. This data is written by a
   * server side function, never by the browser, so it does not belong in the
   * dataset the rest of the app edits.
   */
  loadAnalytics?(): Promise<AnalyticsStatus>;
  /**
   * Supabase adapter only: ask the server to sync now.
   *
   * The browser sends its own session and nothing else. It holds no Google
   * credential, so this is a request for work rather than the work itself.
   */
  triggerSync?(provider: AnalyticsProvider, mode: SyncMode): Promise<SyncTriggerOutcome>;
  /**
   * Supabase adapter only: copy a whole dataset in, for the one-time move off
   * browser-local storage.
   *
   * Insert only. It refuses to write anything at all if any target table already
   * holds a row, so it can never overwrite, delete or duplicate existing data.
   * Ids come across unchanged so every link between tables survives, and
   * owner_id is left off every row so the database stamps it with auth.uid().
   */
  importDataset?(data: Dataset): Promise<ImportReport>;
  /**
   * Supabase adapter only: the Google Sheet mirror's own connection and runs.
   *
   * Kept separate from loadAnalytics rather than folded into it, because that call
   * drags thousands of rows of daily traffic along with it and this panel needs
   * none of them.
   */
  loadLeadMirror?(): Promise<LeadMirrorStatus>;
  /**
   * Supabase adapter only: ask the server to reconcile or to rewrite the mirror.
   *
   * The browser holds no Google credential and does not know the spreadsheet id,
   * so this is a request for work rather than the work itself. A live
   * reconciliation must state what it expects to find, and the server refuses to
   * write if the sheet does not match.
   */
  triggerLeadMirror?(
    action: LeadMirrorAction,
    options?: { mode?: ReconcileMode; expect?: { leadRows: number; touchRows: number } },
  ): Promise<LeadMirrorOutcome>;
  /**
   * Supabase adapter only: the follow-up calendar's connection and runs.
   *
   * Read only. The browser never learns which calendar it is beyond the id the
   * server recorded, and never holds a Google credential.
   */
  loadCalendar?(): Promise<CalendarStatus>;
  /**
   * Supabase adapter only: ask the server to put open follow-ups on the calendar.
   *
   * A request for work rather than the work itself. The browser sends its own
   * session and nothing else.
   */
  triggerCalendarSync?(): Promise<CalendarSyncOutcome>;
  /**
   * Supabase adapter only: begin connecting this person's Google account.
   *
   * Returns somewhere to send them, and nothing else. No token, no client secret
   * and no client id ever comes back through here, and the browser is not trusted
   * to assemble the request: the server records a one-use state first, so a
   * callback it did not start cannot be completed.
   */
  startCalendarOAuth?(): Promise<CalendarOAuthStart>;
  /**
   * Supabase adapter only: forget this person's Google authorization.
   *
   * Server side, because the token the browser is asking to have revoked is one
   * the browser has never been allowed to see. Events already on the calendar are
   * deliberately left alone.
   */
  disconnectCalendar?(): Promise<CalendarDisconnectOutcome>;
}

/** A fresh empty dataset. Use this rather than writing the shape out by hand. */
export function emptyDataset(): Dataset {
  return {
    accounts: [],
    contentItems: [],
    snapshots: [],
    traffic: [],
    leads: [],
    tasks: [],
    recommendations: [],
    activityEvents: [],
  };
}

export const EMPTY_DATASET: Dataset = {
  accounts: [],
  contentItems: [],
  snapshots: [],
  traffic: [],
  leads: [],
  tasks: [],
  recommendations: [],
  activityEvents: [],
};
