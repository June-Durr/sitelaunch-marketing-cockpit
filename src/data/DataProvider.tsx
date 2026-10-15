import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Dataset } from '../types/domain';
import { DataContext, type DataContextValue } from './context';
import { createLocalRepository } from './localRepository';
import {
  EMPTY_DATASET, type AnalyticsProvider, type LeadMirrorAction, type NewRow,
  type ReconcileMode, type Repository, type RowPatch, type SyncMode, type TableName,
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
      importDataset: repo.importDataset
        ? async (next: Dataset) => {
            const report = await repo.importDataset!(next);
            await refresh();
            return report;
          }
        : null,
      // Neither of these refreshes the dataset: synced analytics live in their own
      // tables and nothing in the editable dataset changes when they arrive.
      loadAnalytics: repo.loadAnalytics ? () => repo.loadAnalytics!() : null,
      triggerSync: repo.triggerSync
        ? (provider: AnalyticsProvider, mode: SyncMode) => repo.triggerSync!(provider, mode)
        : null,
      loadLeadMirror: repo.loadLeadMirror ? () => repo.loadLeadMirror!() : null,
      /**
       * Refreshes the dataset afterwards, unlike the analytics syncs.
       *
       * A reconciliation writes leads and activities, which are exactly the rows
       * every screen is showing, so not reloading would leave the Pipeline
       * displaying the pipeline from before the import.
       */
      triggerLeadMirror: repo.triggerLeadMirror
        ? async (
            action: LeadMirrorAction,
            options?: {
              mode?: ReconcileMode;
              expect?: { leadRows: number; touchRows: number };
            },
          ) => {
            const outcome = await repo.triggerLeadMirror!(action, options);
            if (action === 'reconcile' && outcome.applied !== null) await refresh();
            return outcome;
          }
        : null,
      loadCalendar: repo.loadCalendar ? () => repo.loadCalendar!() : null,
      /**
       * Refreshes afterwards, because a calendar sync writes the sync state onto
       * the tasks the screens are showing.
       */
      triggerCalendarSync: repo.triggerCalendarSync
        ? async () => {
            const outcome = await repo.triggerCalendarSync!();
            await refresh();
            return outcome;
          }
        : null,
      /**
       * No refresh. Starting an authorization changes nothing in the dataset, and
       * the browser is about to leave the page for Google anyway.
       */
      startCalendarOAuth: repo.startCalendarOAuth
        ? () => repo.startCalendarOAuth!()
        : null,
      /**
       * Refreshes afterwards. Disconnecting does not change a task's calendar
       * state, but the panel reads the connection row and the screens read the
       * tasks, and one reload keeps both telling the same story.
       */
      disconnectCalendar: repo.disconnectCalendar
        ? async () => {
            const outcome = await repo.disconnectCalendar!();
            await refresh();
            return outcome;
          }
        : null,
      /**
       * No refresh in here.
       *
       * The caller decides when to reload, because it also decides when the row
       * it just acted on should leave the queue. Refreshing inside the write
       * would pull the row out from under the pointer before the confirmation
       * had been drawn.
       */
      completeTaskDurably: repo.completeTaskDurably
        ? (input) => repo.completeTaskDurably!(input)
        : null,
      undoTaskOperation: repo.undoTaskOperation
        ? (taskId) => repo.undoTaskOperation!(taskId)
        : null,
      skipTaskDurably: repo.skipTaskDurably ? (taskId) => repo.skipTaskDurably!(taskId) : null,
      softDeleteTask: repo.softDeleteTask ? (taskId) => repo.softDeleteTask!(taskId) : null,
      loadRecentlyDeleted: repo.loadRecentlyDeleted
        ? () => repo.loadRecentlyDeleted!()
        : null,
      loadSyncPending: repo.loadSyncPending ? () => repo.loadSyncPending!() : null,
      drainSyncJobs: repo.drainSyncJobs ? () => repo.drainSyncJobs!() : null,

      /*
       * The assistant.
       *
       * Asking refreshes nothing, because asking changes nothing. The four
       * writes refresh afterwards, because each one changes rows the screens
       * are showing: a new contact belongs in the Pipeline the moment it
       * exists, and a recorded touch moves a follow-up date.
       */
      askAssistant: repo.askAssistant ? (input) => repo.askAssistant!(input) : null,
      captureContact: repo.captureContact
        ? async (input) => {
            const outcome = await repo.captureContact!(input);
            if (outcome.ok) await refresh();
            return outcome;
          }
        : null,
      recordConversation: repo.recordConversation
        ? async (input) => {
            const outcome = await repo.recordConversation!(input);
            if (outcome.ok) await refresh();
            return outcome;
          }
        : null,
      /* No refresh. A draft is not part of the dataset any screen reads. */
      saveDraft: repo.saveDraft
        ? (leadId, channel, body) => repo.saveDraft!(leadId, channel, body)
        : null,
      markDraftCopied: repo.markDraftCopied
        ? (draftId) => repo.markDraftCopied!(draftId)
        : null,
      markDraftSent: repo.markDraftSent
        ? async (draftId, token, sentOn, finalBody) => {
            const outcome = await repo.markDraftSent!(draftId, token, sentOn, finalBody);
            // A confirmed send writes an activity and moves the follow-up, so
            // the screens behind the panel are now out of date.
            if (outcome.sent) await refresh();
            return outcome;
          }
        : null,
      loadDrafts: repo.loadDrafts ? (leadId) => repo.loadDrafts!(leadId) : null,
      loadFacts: repo.loadFacts ? (leadId) => repo.loadFacts!(leadId) : null,
      loadAiUsage: repo.loadAiUsage ? (days) => repo.loadAiUsage!(days) : null,
    }),
    [data, error, loading, refresh, repo],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
