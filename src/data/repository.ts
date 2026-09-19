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
