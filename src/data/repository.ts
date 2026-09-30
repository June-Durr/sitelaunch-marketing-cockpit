import type {
  Account, ActivityEvent, ContentItem, Dataset, Lead, PerformanceSnapshot,
  Recommendation, Task, TrafficSnapshot,
} from '../types/domain';

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
   * Supabase adapter only: copy a whole dataset in, for the one-time move off
   * browser-local storage.
   *
   * Insert only. It refuses to write anything at all if any target table already
   * holds a row, so it can never overwrite, delete or duplicate existing data.
   * Ids come across unchanged so every link between tables survives, and
   * owner_id is left off every row so the database stamps it with auth.uid().
   */
  importDataset?(data: Dataset): Promise<ImportReport>;
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
