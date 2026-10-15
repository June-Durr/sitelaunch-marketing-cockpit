import { createContext, useContext } from 'react';
import type { Dataset } from '../types/domain';
import type {
  AnalyticsProvider, AnalyticsStatus, CalendarDisconnectOutcome, CalendarOAuthStart,
  CaptureInput, CaptureOutcome, CompletionInput, CompletionOutcome,
  ConversationInput, ConversationOutcome, DraftOutcome, UndoOutcome,
  CalendarStatus, CalendarSyncOutcome, ImportReport, LeadMirrorAction,
  LeadMirrorOutcome, LeadMirrorStatus, NewRow, ReconcileMode, RowPatch, SyncMode,
  SyncTriggerOutcome, TableMap, TableName,
} from './repository';
import type { ExtractedFact, MessageDraft } from '../types/assistant';
import type { AiUsageSummary, AssistantAnswer, AssistantRequest } from '../assistant/wire';
import { EMPTY_DATASET } from './repository';

export interface DataContextValue {
  data: Dataset;
  mode: 'local' | 'supabase';
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  insert: <K extends TableName>(table: K, row: NewRow<K>) => Promise<TableMap[K]>;
  insertMany: <K extends TableName>(table: K, rows: NewRow<K>[]) => Promise<TableMap[K][]>;
  update: <K extends TableName>(
    table: K, id: string, patch: RowPatch<K>,
  ) => Promise<TableMap[K]>;
  remove: <K extends TableName>(table: K, id: string) => Promise<void>;
  resetToSeed: (() => Promise<void>) | null;
  /** Null when the adapter cannot replace the whole dataset (Supabase). */
  replaceAll: ((data: Dataset) => Promise<void>) | null;
  /**
   * Null in browser-local mode, where replaceAll is the restore path instead.
   * On Supabase this copies a backup in without deleting or overwriting anything.
   */
  importDataset: ((data: Dataset) => Promise<ImportReport>) | null;
  /**
   * Null in browser-local mode, which has no server to sync from.
   *
   * Read separately from the dataset rather than folded into it, because these
   * rows are written by a server function and are not editable here.
   */
  loadAnalytics: (() => Promise<AnalyticsStatus>) | null;
  /** Null in browser-local mode. Asks the server to sync; never syncs in here. */
  triggerSync: ((provider: AnalyticsProvider, mode: SyncMode) => Promise<SyncTriggerOutcome>) | null;
  /** Null in browser-local mode, which has no server to hold a Google key. */
  loadLeadMirror: (() => Promise<LeadMirrorStatus>) | null;
  /** Null in browser-local mode. Asks the server; never calls Google in here. */
  triggerLeadMirror:
    | ((
        action: LeadMirrorAction,
        options?: { mode?: ReconcileMode; expect?: { leadRows: number; touchRows: number } },
      ) => Promise<LeadMirrorOutcome>)
    | null;
  /** Null in browser-local mode, which has no server to hold a Google key. */
  loadCalendar: (() => Promise<CalendarStatus>) | null;
  /** Null in browser-local mode. Asks the server; never calls Google in here. */
  triggerCalendarSync: (() => Promise<CalendarSyncOutcome>) | null;
  /** Null in browser-local mode. Returns somewhere to send them, not a token. */
  startCalendarOAuth: (() => Promise<CalendarOAuthStart>) | null;
  /** Null in browser-local mode. Forgets the authorization server side. */
  disconnectCalendar: (() => Promise<CalendarDisconnectOutcome>) | null;
  /**
   * Null in browser-local mode, which has no transaction to offer.
   *
   * When present, one call writes the activity, moves the lead, moves the task
   * and queues the syncs, or writes none of it. See src/data/taskActions.tsx for
   * what the screens do when it is absent.
   */
  completeTaskDurably: ((input: CompletionInput) => Promise<CompletionOutcome>) | null;
  /** Null in browser-local mode, where nothing recorded the previous state. */
  undoTaskOperation: ((taskId: string) => Promise<UndoOutcome>) | null;
  skipTaskDurably: ((taskId: string) => Promise<UndoOutcome>) | null;
  softDeleteTask: ((taskId: string) => Promise<UndoOutcome>) | null;
  loadRecentlyDeleted: (() => Promise<TableMap['tasks'][]>) | null;
  loadSyncPending: (() => Promise<{ calendar: boolean; leadMirror: boolean }>) | null;
  /** Null in browser-local mode. Asks the worker to run this owner's queue. */
  drainSyncJobs: (() => Promise<{ ran: boolean; succeeded: number; failed: number }>) | null;

  /**
   * Null in browser-local mode, which has no server to hold a model key.
   *
   * The panel shows what it can do from this: with no adapter there is no
   * assistant, and it says so rather than offering a box that cannot answer.
   */
  askAssistant: ((input: AssistantRequest) => Promise<AssistantAnswer>) | null;
  captureContact: ((input: CaptureInput) => Promise<CaptureOutcome>) | null;
  recordConversation: ((input: ConversationInput) => Promise<ConversationOutcome>) | null;
  saveDraft:
    | ((leadId: string, channel: string | null, body: string) => Promise<DraftOutcome>)
    | null;
  markDraftCopied: ((draftId: string) => Promise<DraftOutcome>) | null;
  markDraftSent:
    | ((
        draftId: string, token: string, sentOn: string, finalBody?: string | null,
      ) => Promise<DraftOutcome>)
    | null;
  loadDrafts: ((leadId: string) => Promise<MessageDraft[]>) | null;
  loadFacts: ((leadId: string) => Promise<ExtractedFact[]>) | null;
  loadAiUsage: ((days?: number) => Promise<AiUsageSummary>) | null;
}

export const DataContext = createContext<DataContextValue>({
  data: EMPTY_DATASET,
  mode: 'local',
  loading: true,
  error: null,
  refresh: async () => {},
  insert: async () => {
    throw new Error('DataProvider missing');
  },
  insertMany: async () => {
    throw new Error('DataProvider missing');
  },
  update: async () => {
    throw new Error('DataProvider missing');
  },
  remove: async () => {
    throw new Error('DataProvider missing');
  },
  resetToSeed: null,
  replaceAll: null,
  importDataset: null,
  loadAnalytics: null,
  triggerSync: null,
  loadLeadMirror: null,
  triggerLeadMirror: null,
  loadCalendar: null,
  triggerCalendarSync: null,
  startCalendarOAuth: null,
  disconnectCalendar: null,
  completeTaskDurably: null,
  undoTaskOperation: null,
  skipTaskDurably: null,
  softDeleteTask: null,
  loadRecentlyDeleted: null,
  loadSyncPending: null,
  drainSyncJobs: null,
  askAssistant: null,
  captureContact: null,
  recordConversation: null,
  saveDraft: null,
  markDraftCopied: null,
  markDraftSent: null,
  loadDrafts: null,
  loadFacts: null,
  loadAiUsage: null,
});

export function useData(): DataContextValue {
  return useContext(DataContext);
}
