import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Dataset } from '../types/domain';
import { DataContext, type DataContextValue } from './context';
import { createLocalRepository } from './localRepository';
import {
  EMPTY_DATASET, type NewRow, type Repository, type RowPatch, type TableName,
} from './repository';
import { supabaseConfigured } from './supabaseClient';
import { createSupabaseRepository } from './supabaseRepository';

/** Credentials decide the adapter; nothing above this line knows which one won. */
function createRepository(): Repository {
  if (supabaseConfigured) {
    try {
      return createSupabaseRepository();
    } catch {
      return createLocalRepository();
    }
  }
  return createLocalRepository();
}

export function DataProvider({ children }: { children: ReactNode }) {
  // Lazy state initialiser, so the adapter is constructed exactly once.
  const [repo] = useState<Repository>(createRepository);

  const [data, setData] = useState<Dataset>(EMPTY_DATASET);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await repo.loadAll();
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    // Loading the dataset from the repository is exactly the external-system
    // synchronisation an effect is for; the state writes happen after the await,
    // not synchronously during the effect.
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh();
  }, [refresh]);

  const value = useMemo<DataContextValue>(
    () => ({
      data,
      mode: repo.mode,
      loading,
      error,
      refresh,
      insert: async <K extends TableName>(table: K, row: NewRow<K>) => {
        const created = await repo.insert(table, row);
        await refresh();
        return created;
      },
      insertMany: async <K extends TableName>(table: K, rows: NewRow<K>[]) => {
        const created = await repo.insertMany(table, rows);
        await refresh();
        return created;
      },
      update: async <K extends TableName>(table: K, id: string, patch: RowPatch<K>) => {
        const updated = await repo.update(table, id, patch);
        await refresh();
        return updated;
      },
      remove: async <K extends TableName>(table: K, id: string) => {
        await repo.remove(table, id);
        await refresh();
      },
      resetToSeed: repo.resetToSeed
        ? async () => {
            await repo.resetToSeed?.();
            await refresh();
          }
        : null,
      replaceAll: repo.replaceAll
        ? async (next: Dataset) => {
            await repo.replaceAll?.(next);
            await refresh();
          }
        : null,
    }),
    [data, error, loading, refresh, repo],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
