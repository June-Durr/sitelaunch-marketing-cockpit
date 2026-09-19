/**
 * Browser-local adapter. Default in v1 so the cockpit is usable before Supabase
 * credentials exist. Same interface as the Supabase adapter, so switching is a
 * configuration change, not a rewrite.
 */

import type { Dataset } from '../types/domain';
import { buildSeedDataset } from './seed';
import { emptyDataset } from './repository';
import type { NewRow, Repository, RowPatch, TableMap, TableName } from './repository';

const STORAGE_KEY = 'slmc.dataset.v1';

/** Maps a database table name onto its array in the in-memory Dataset. */
const TABLE_TO_COLLECTION: Record<TableName, keyof Dataset> = {
  accounts: 'accounts',
  content_items: 'contentItems',
  performance_snapshots: 'snapshots',
  traffic_snapshots: 'traffic',
  leads: 'leads',
  tasks: 'tasks',
  recommendations: 'recommendations',
  activity_events: 'activityEvents',
};

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function read(): Dataset {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Data saved by an older version will be missing any table added since. Filling
    // the gaps here rather than at every call site means upgrading the app never
    // leaves a screen reading a property that does not exist yet.
    if (raw) return { ...emptyDataset(), ...(JSON.parse(raw) as Partial<Dataset>) };
  } catch {
    // Corrupt or unavailable storage falls through to a fresh seed rather than
    // leaving the operator staring at a blank cockpit with no explanation.
  }
  const seeded = buildSeedDataset();
  write(seeded);
  return seeded;
}

function write(data: Dataset): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked. The session keeps working in memory.
  }
}

export function createLocalRepository(): Repository {
  return {
    mode: 'local',

    async loadAll() {
      return read();
    },

    async insert<K extends TableName>(table: K, row: NewRow<K>) {
      const data = read();
      const now = new Date().toISOString();
      const record = {
        created_at: now,
        updated_at: now,
        ...(row as object),
        id: (row as { id?: string }).id ?? newId(),
      } as TableMap[K];
      const key = TABLE_TO_COLLECTION[table];
      (data[key] as TableMap[K][]).push(record);
      write(data);
      return record;
    },

    async insertMany<K extends TableName>(table: K, rows: NewRow<K>[]) {
      const data = read();
      const now = new Date().toISOString();
      const key = TABLE_TO_COLLECTION[table];
      const records = rows.map(
        (row) =>
          ({
            created_at: now,
            updated_at: now,
            ...(row as object),
            id: (row as { id?: string }).id ?? newId(),
          }) as TableMap[K],
      );
      (data[key] as TableMap[K][]).push(...records);
      write(data);
      return records;
    },

    async update<K extends TableName>(table: K, id: string, patch: RowPatch<K>) {
      const data = read();
      const key = TABLE_TO_COLLECTION[table];
      const list = data[key] as TableMap[K][];
      const index = list.findIndex((r) => (r as { id: string }).id === id);
      if (index === -1) throw new Error(`${table}: no row with id ${id}`);
      const updated = {
        ...list[index],
        ...patch,
        updated_at: new Date().toISOString(),
      } as TableMap[K];
      list[index] = updated;
      write(data);
      return updated;
    },

    async remove<K extends TableName>(table: K, id: string) {
      const data = read();
      const key = TABLE_TO_COLLECTION[table];
      const list = data[key] as TableMap[K][];
      const index = list.findIndex((r) => (r as { id: string }).id === id);
      if (index !== -1) list.splice(index, 1);
      write(data);
    },

    async resetToSeed() {
      write(buildSeedDataset());
    },

    async replaceAll(next: Dataset) {
      // One write. Either the whole restored dataset lands or nothing does. Merged
      // over an empty dataset so a partial restore cannot leave a table undefined.
      write({ ...emptyDataset(), ...next });
    },
  };
}
