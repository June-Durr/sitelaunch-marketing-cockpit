/**
 * Supabase adapter. Selected automatically when VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY are set. Assumes supabase/migrations/0001_init.sql has
 * been applied; owner_id defaults to auth.uid() and RLS scopes every read.
 */

import type { Dataset } from '../types/domain';
import type {
  AnalyticsProvider, AnalyticsStatus, CalendarDisconnectOutcome, CalendarOAuthStart,
  CalendarStatus, CalendarSyncOutcome,
  ImportReport, LeadMirrorAction, LeadMirrorOutcome, LeadMirrorStatus, NewRow,
  ReconcileMode, Repository, RowPatch, SyncMode, SyncTriggerOutcome, TableMap,
  TableName,
} from './repository';
import { IMPORT_ORDER } from './repository';
import type {
  Ga4DailyTraffic, IntegrationConnection, SearchConsoleDaily, SyncRun,
} from '../types/integrations';
import { functionsBaseUrl, getSupabase } from './supabaseClient';

/** Table name -> its array in the in-memory Dataset. */
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

/** PostgREST takes one request per call, so long tables go up in batches. */
const IMPORT_BATCH_SIZE = 200;

/**
 * Every column holding another row's id, per table.
 *
 * These are what an id rewrite has to follow. Miss one and the row still imports,
 * but the link it carried is quietly broken, which is worse than a failed import
 * because nothing announces it.
 */
const REFERENCE_FIELDS: Record<TableName, string[]> = {
  accounts: [],
  content_items: ['account_id', 'cross_post_group_id'],
  performance_snapshots: ['content_item_id'],
  traffic_snapshots: ['content_item_id'],
  leads: ['content_item_id'],
  tasks: ['content_item_id', 'lead_id'],
  recommendations: [],
  activity_events: ['content_item_id', 'lead_id', 'task_id'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Only reached on a runtime without the Web Crypto API. Version 4 shape.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Old id -> new id, for every id in the dataset that Postgres would refuse.
 *
 * Browser-local mode accepts any string as an id, and the seed records use
 * readable ones like "acc-instagram-0001". Every id column in the database is a
 * uuid, so those have to be rewritten. The rewrite is done once, up front, for
 * the whole dataset, so an id and every reference to it always change together.
 * Ids that are already uuids are left exactly as they are.
 */
export function buildIdMap(data: Dataset): Map<string, string> {
  const map = new Map<string, string>();
  const consider = (value: unknown) => {
    if (typeof value !== 'string' || value === '' || UUID_RE.test(value)) return;
    if (!map.has(value)) map.set(value, newUuid());
  };

  for (const table of IMPORT_ORDER) {
    const rows = (data[TABLE_TO_COLLECTION[table]] ?? []) as unknown as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      consider(row.id);
      // Group ids are uuids in the database but name no row, so they are collected
      // here rather than from any table's primary key.
      for (const field of REFERENCE_FIELDS[table]) consider(row[field]);
    }
  }
  return map;
}

/**
 * owner_id is never sent. The column defaults to auth.uid() and the row level
 * security policy checks it on the way in, so letting the database fill it is
 * both simpler and the only version that cannot write a row under the wrong
 * account. A backup that somehow carries the field has it stripped here.
 */
export function forImport(
  table: TableName,
  row: Record<string, unknown>,
  idMap: Map<string, string>,
): Record<string, unknown> {
  const { owner_id: _ignored, ...rest } = row;
  const id = rest.id;
  if (typeof id === 'string' && idMap.has(id)) rest.id = idMap.get(id);
  for (const field of REFERENCE_FIELDS[table]) {
    const value = rest[field];
    if (typeof value === 'string' && idMap.has(value)) rest[field] = idMap.get(value);
  }
  return rest;
}

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

    countAll,

    async importDataset(data: Dataset): Promise<ImportReport> {
      const inserted = Object.fromEntries(
        IMPORT_ORDER.map((t) => [t, 0]),
      ) as Record<TableName, number>;

      // Refuse before writing anything if the account already holds data. This is
      // the guarantee that makes the import safe to run: an import that cannot
      // start cannot half-finish.
      const existing = await countAll();
      const blockedBy = IMPORT_ORDER.filter((t) => existing[t] > 0).map((table) => ({
        table,
        existing: existing[table],
      }));
      if (blockedBy.length > 0) {
        return { inserted, blockedBy, failure: null, rolledBack: null, remappedIds: 0 };
      }

      // Rewrite any id Postgres would refuse, once, for the whole dataset.
      const idMap = buildIdMap(data);

      // Ids of what this import wrote, so a failure can be undone precisely.
      const written: { table: TableName; ids: string[] }[] = [];

      for (const table of IMPORT_ORDER) {
        const rows = (data[TABLE_TO_COLLECTION[table]] ?? []) as unknown as Record<
          string,
          unknown
        >[];
        if (rows.length === 0) continue;

        const ids: string[] = [];
        try {
          for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
            const batch = rows
              .slice(i, i + IMPORT_BATCH_SIZE)
              .map((row) => forImport(table, row, idMap));
            const { data: created, error } = await db.from(table).insert(batch).select('id');
            if (error) throw new Error(error.message);
            for (const row of created ?? []) ids.push((row as { id: string }).id);
            inserted[table] = ids.length;
          }
          written.push({ table, ids });
        } catch (err) {
          // Partway through. Put the database back to the empty state it was in,
          // newest table first so children go before the parents they point at.
          written.push({ table, ids });
          const rolledBack = await undo(written);
          return {
            inserted,
            blockedBy: [],
            failure: {
              table,
              message: err instanceof Error ? err.message : String(err),
            },
            rolledBack,
            remappedIds: idMap.size,
          };
        }
      }

      return {
        inserted,
        blockedBy: [],
        failure: null,
        rolledBack: null,
        remappedIds: idMap.size,
      };
    },

    /**
     * What the automatic sync has been doing.
     *
     * Row level security limits every one of these to this account, and none of
     * these tables has a token column, so there is nothing here the browser
     * should not see. A table that has not been created yet is reported as empty
     * rather than as an error, so a project that has not applied migration 0005
     * still loads the rest of the screen.
     */
    async loadAnalytics(): Promise<AnalyticsStatus> {
      const [connections, runs, ga4, searchConsole] = await Promise.all([
        selectOptional<IntegrationConnection>(
          'integration_connections', 'provider', true, 50,
        ),
        selectOptional<SyncRun>('sync_runs', 'started_at', false, 50),
        selectOptional<Ga4DailyTraffic>('ga4_daily_traffic', 'date', false, 2000),
        selectOptional<SearchConsoleDaily>('search_console_daily', 'date', false, 2000),
      ]);
      return { connections, runs, ga4, searchConsole };
    },

    /**
     * The lead mirror's own connection row and its last few runs.
     *
     * Read only, and scoped to this provider so the panel does not pay for the
     * analytics tables it never shows. A project that has not applied migration
     * 0007 yet reports as empty rather than as an error, so the Data screen still
     * loads.
     */
    async loadLeadMirror(): Promise<LeadMirrorStatus> {
      const [connections, runs] = await Promise.all([
        selectOptionalWhere<IntegrationConnection>(
          'integration_connections', 'provider', 'google_sheets', 'updated_at', false, 1,
        ),
        selectOptionalWhere<SyncRun>(
          'sync_runs', 'provider', 'google_sheets', 'started_at', false, 20,
        ),
      ]);
      return { connection: connections[0] ?? null, runs };
    },

    /**
     * The follow-up calendar's own connection row and its last few runs.
     *
     * Scoped to this provider, so the panel does not pay for tables it never
     * shows. A project without migration 0005 applied reports as empty rather
     * than as an error.
     */
    async loadCalendar(): Promise<CalendarStatus> {
      const [connections, runs] = await Promise.all([
        selectOptionalWhere<IntegrationConnection>(
          'integration_connections', 'provider', 'google_calendar', 'updated_at', false, 1,
        ),
        selectOptionalWhere<SyncRun>(
          'sync_runs', 'provider', 'google_calendar', 'started_at', false, 20,
        ),
      ]);
      return { connection: connections[0] ?? null, runs };
    },

    /**
     * Ask the server to put the open follow-ups on the calendar.
     *
     * Sends this browser's session and nothing else. This person's Google
     * authorization lives behind the server's Vault helpers, so pressing this
     * button never puts a token in a browser.
     */
    async triggerCalendarSync(): Promise<CalendarSyncOutcome> {
      const empty = (status: string, error: string): CalendarSyncOutcome => ({
        ok: false, status, created: null, updated: null, failed: null, tasks: null, error,
      });

      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return empty('not_signed_in', 'Sign in first.');

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/sync-calendar`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'export' }),
        });
      } catch {
        return empty(
          'unreachable',
          'Could not reach the calendar function. It may not be deployed yet.',
        );
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const asNumber = (value: unknown) => (typeof value === 'number' ? value : null);
      return {
        ok: response.ok,
        status:
          typeof body.status === 'string'
            ? body.status
            : response.ok
              ? 'unknown'
              : `http_${response.status}`,
        created: asNumber(body.created),
        updated: asNumber(body.updated),
        failed: asNumber(body.failed),
        tasks: asNumber(body.tasks),
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /**
     * Begin connecting this person's own Google account.
     *
     * The browser gets back a URL to Google and nothing else. It does not build
     * that URL, because it carries a state the server has to have recorded first,
     * and a state the server never issued is one it must refuse. It does not hold
     * the OAuth client secret either, which is why the exchange happens in a
     * function and not here.
     */
    async startCalendarOAuth(): Promise<CalendarOAuthStart> {
      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) {
        return { status: 'not_signed_in', authorizeUrl: null, error: 'Sign in first.' };
      }

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/calendar-oauth`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'start' }),
        });
      } catch {
        return {
          status: 'unreachable',
          authorizeUrl: null,
          error: 'Could not reach the connection function. It may not be deployed yet.',
        };
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      /**
       * Only an address on Google's own consent host is accepted.
       *
       * The server builds it, so this should never matter. It is checked anyway
       * because this value is about to become a navigation, and a navigation
       * taken from a response is worth one line of paranoia.
       */
      const raw = typeof body.authorizeUrl === 'string' ? body.authorizeUrl : null;
      let authorizeUrl: string | null = null;
      if (raw) {
        try {
          const parsed = new URL(raw);
          if (parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com') {
            authorizeUrl = parsed.toString();
          }
        } catch {
          authorizeUrl = null;
        }
      }

      return {
        status:
          typeof body.status === 'string'
            ? body.status
            : response.ok
              ? 'unknown'
              : `http_${response.status}`,
        authorizeUrl: response.ok ? authorizeUrl : null,
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /**
     * Forget this person's Google authorization.
     *
     * Server side, because the token being revoked is one this browser has never
     * been allowed to see. Nothing is removed from the calendar: events already
     * in somebody's week stay there, and the response says so plainly rather than
     * letting the screen imply otherwise.
     */
    async disconnectCalendar(): Promise<CalendarDisconnectOutcome> {
      const fail = (status: string, error: string): CalendarDisconnectOutcome => ({
        ok: false, status, revokedAtGoogle: false, eventsRemoved: false, error,
      });

      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return fail('not_signed_in', 'Sign in first.');

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/calendar-oauth`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'disconnect' }),
        });
      } catch {
        return fail(
          'unreachable',
          'Could not reach the connection function. It may not be deployed yet.',
        );
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      return {
        ok: response.ok,
        status:
          typeof body.status === 'string'
            ? body.status
            : response.ok
              ? 'unknown'
              : `http_${response.status}`,
        revokedAtGoogle: body.revokedAtGoogle === true,
        eventsRemoved: body.eventsRemoved === true,
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /**
     * Ask the server to reconcile the Sheet in, or to rewrite it from here.
     *
     * Sends this browser's session and nothing else. The Google credential and
     * the spreadsheet id live in the function's own secrets, so a person pressing
     * the button never holds either and this request cannot carry them.
     */
    async triggerLeadMirror(
      action: LeadMirrorAction,
      options: {
        mode?: ReconcileMode;
        expect?: { leadRows: number; touchRows: number };
      } = {},
    ): Promise<LeadMirrorOutcome> {
      const empty = (status: string, error: string): LeadMirrorOutcome => ({
        ok: false,
        status,
        counts: null,
        ambiguous: [],
        rejected: [],
        warnings: [],
        gateReasons: [],
        applied: null,
        leadRows: null,
        touchRows: null,
        error,
      });

      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return empty('not_signed_in', 'Sign in first.');

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/sync-lead-mirror`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.expect ? { expect: options.expect } : {}),
          }),
        });
      } catch {
        return empty(
          'unreachable',
          'Could not reach the lead mirror function. It may not be deployed yet.',
        );
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const gate = body.gate as { reasons?: string[] } | undefined;
      const asNumber = (value: unknown) => (typeof value === 'number' ? value : null);

      return {
        ok: response.ok,
        status:
          typeof body.status === 'string'
            ? body.status
            : response.ok
              ? 'unknown'
              : `http_${response.status}`,
        counts: (body.counts as Record<string, number> | undefined) ?? null,
        ambiguous: Array.isArray(body.ambiguous)
          ? (body.ambiguous as LeadMirrorOutcome['ambiguous'])
          : [],
        rejected: Array.isArray(body.rejected)
          ? (body.rejected as LeadMirrorOutcome['rejected'])
          : [],
        warnings: Array.isArray(body.warnings) ? (body.warnings as string[]) : [],
        gateReasons: Array.isArray(gate?.reasons) ? (gate.reasons as string[]) : [],
        applied: (body.applied as LeadMirrorOutcome['applied']) ?? null,
        leadRows: asNumber(body.leadRows),
        touchRows: asNumber(body.touchRows),
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /**
     * Ask the server to sync now.
     *
     * Sends this browser's session and nothing else. The Google credential lives
     * in the function's own secrets, so a person pressing this button never holds
     * it and the network request cannot carry it.
     */
    async triggerSync(
      provider: AnalyticsProvider,
      mode: SyncMode,
    ): Promise<SyncTriggerOutcome> {
      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) {
        return { ok: false, status: 'not_signed_in', rowsWritten: null, error: 'Sign in first.' };
      }

      const name = provider === 'ga4' ? 'sync-ga4' : 'sync-search-console';
      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/${name}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
      } catch {
        // A function that has not been deployed yet fails here, and saying so is
        // more use than a raw network error.
        return {
          ok: false,
          status: 'unreachable',
          rowsWritten: null,
          error: 'Could not reach the sync function. It may not be deployed yet.',
        };
      }

      let body: { status?: string; rowsWritten?: number; error?: string } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        body = {};
      }

      return {
        ok: response.ok,
        status: body.status ?? (response.ok ? 'unknown' : `http_${response.status}`),
        rowsWritten: typeof body.rowsWritten === 'number' ? body.rowsWritten : null,
        error: body.error ?? null,
      };
    },
  };

  /**
   * Select from a table that may not exist yet.
   *
   * Migration 0005 is separate from 0001, so a project can be perfectly healthy
   * and still have no integration tables. Treating that as empty rather than as a
   * failure keeps the Data screen usable instead of blanking it over a feature
   * that has not been set up.
   */
  async function selectOptional<T>(
    table: string,
    orderBy: string,
    ascending: boolean,
    limit: number,
  ): Promise<T[]> {
    const { data, error } = await db
      .from(table)
      .select('*')
      .order(orderBy, { ascending, nullsFirst: false })
      .limit(limit);

    if (error) {
      // 42P01 is "relation does not exist". Anything else is a real problem.
      if (error.code === '42P01') return [];
      throw new Error(`${table}: ${error.message}`);
    }
    return (data ?? []) as T[];
  }

  /** selectOptional, narrowed to one column's value. Same tolerance of a missing table. */
  async function selectOptionalWhere<T>(
    table: string,
    column: string,
    value: string,
    orderBy: string,
    ascending: boolean,
    limit: number,
  ): Promise<T[]> {
    const { data, error } = await db
      .from(table)
      .select('*')
      .eq(column, value)
      .order(orderBy, { ascending, nullsFirst: false })
      .limit(limit);

    if (error) {
      // 42P01 is "relation does not exist"; 22P02 is an enum value this database
      // does not have yet, which is what an unapplied migration 0007 looks like.
      if (error.code === '42P01' || error.code === '22P02') return [];
      throw new Error(`${table}: ${error.message}`);
    }
    return (data ?? []) as T[];
  }

  /** Rows this account can see in each table. */
  async function countAll(): Promise<Record<TableName, number>> {
    const entries = await Promise.all(
      IMPORT_ORDER.map(async (table) => {
        // head:true asks for the count and no rows, so this stays cheap. The count
        // is what row level security lets this account see, which is exactly the
        // question being asked.
        const { count, error } = await db
          .from(table)
          .select('id', { count: 'exact', head: true });
        if (error) throw new Error(`${table}: ${error.message}`);
        return [table, count ?? 0] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<TableName, number>;
  }

  /** Delete exactly what an aborted import wrote, children before parents. */
  async function undo(
    written: { table: TableName; ids: string[] }[],
  ): Promise<{ ok: boolean; message: string | null }> {
    const problems: string[] = [];
    for (const { table, ids } of [...written].reverse()) {
      for (let i = 0; i < ids.length; i += IMPORT_BATCH_SIZE) {
        const batch = ids.slice(i, i + IMPORT_BATCH_SIZE);
        if (batch.length === 0) continue;
        const { error } = await db.from(table).delete().in('id', batch);
        if (error) problems.push(`${table}: ${error.message}`);
      }
    }
    return problems.length === 0
      ? { ok: true, message: null }
      : { ok: false, message: problems.join('; ') };
  }
}
