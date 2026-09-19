/**
 * Supabase adapter. Selected automatically when VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY are set. Assumes supabase/migrations/0001_init.sql has
 * been applied; owner_id defaults to auth.uid() and RLS scopes every read.
 */

import type { Dataset } from '../types/domain';
import type { NewRow, Repository, RowPatch, TableMap, TableName } from './repository';
import { getSupabase } from './supabaseClient';

export function createSupabaseRepository(): Repository {
  const db = getSupabase();

  async function selectAll<K extends TableName>(
    table: K,
    orderBy: { column: string; ascending: boolean },
  ): Promise<TableMap[K][]> {
    const { data, error } = await db
      .from(table)
      .select('*')
      .order(orderBy.column, { ascending: orderBy.ascending, nullsFirst: false });
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data ?? []) as TableMap[K][];
  }

  return {
    mode: 'supabase',

    async loadAll(): Promise<Dataset> {
      const [
        accounts, contentItems, snapshots, traffic, leads, tasks, recommendations,
        activityEvents,
      ] = await Promise.all([
        selectAll('accounts', { column: 'created_at', ascending: true }),
        selectAll('content_items', { column: 'published_at', ascending: false }),
        selectAll('performance_snapshots', { column: 'captured_at', ascending: false }),
        selectAll('traffic_snapshots', { column: 'range_start', ascending: false }),
        selectAll('leads', { column: 'created_at', ascending: false }),
        selectAll('tasks', { column: 'due_date', ascending: true }),
        selectAll('recommendations', { column: 'generated_at', ascending: false }),
        selectAll('activity_events', { column: 'occurred_at', ascending: false }),
      ]);
      return {
        accounts, contentItems, snapshots, traffic, leads, tasks, recommendations,
        activityEvents,
      };
    },

    async insert<K extends TableName>(table: K, row: NewRow<K>) {
      const { data, error } = await db.from(table).insert(row).select().single();
      if (error) throw new Error(`${table}: ${error.message}`);
      return data as TableMap[K];
    },

    async insertMany<K extends TableName>(table: K, rows: NewRow<K>[]) {
      if (rows.length === 0) return [];
      const { data, error } = await db.from(table).insert(rows).select();
      if (error) throw new Error(`${table}: ${error.message}`);
      return (data ?? []) as TableMap[K][];
    },

    async update<K extends TableName>(table: K, id: string, patch: RowPatch<K>) {
      const { data, error } = await db
        .from(table)
        // The generic patch type cannot narrow to one table's row shape here; the
        // Repository interface has already constrained the keys to that table.
        .update(patch as Record<string, unknown>)
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(`${table}: ${error.message}`);
      return data as TableMap[K];
    },

    async remove<K extends TableName>(table: K, id: string) {
      const { error } = await db.from(table).delete().eq('id', id);
      if (error) throw new Error(`${table}: ${error.message}`);
    },
  };
}
