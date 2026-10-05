/**
 * The lead mirror: one reconciliation in, and the mirror out, from then on.
 *
 * Three things can be asked of it, and the Cockpit never asks for more than one
 * at a time:
 *
 *   {"action":"reconcile","mode":"dry_run"}
 *     Read both tabs, work out what an import would do, write nothing, and
 *     report. Safe to run as often as you like.
 *
 *   {"action":"reconcile","mode":"live","expect":{"leadRows":21,"touchRows":15}}
 *     The same plan, applied, but only if the sheet is exactly the size the
 *     caller said it would be, there is no ambiguity and no row was rejected.
 *     Anything else stops before writing and reports the discrepancy. The
 *     expectation is required rather than defaulted, because a gate with a
 *     built-in answer is a gate that stops meaning anything once the data moves
 *     on.
 *
 *   {"action":"export"}
 *     Rewrite the mirror from Supabase. Called by the Sync lead mirror now button
 *     and, once that has worked, by a daily schedule.
 *
 * WHICH DIRECTION IS AUTHORITATIVE
 *
 * Supabase, always. The reconcile action exists once, to bring a hand-built
 * history in. After that only export runs, so an edit made in the spreadsheet is
 * overwritten by the next sync rather than silently becoming truth. There is no
 * code path in this function that lets a sheet cell change a newer Supabase value.
 *
 * WHAT NEVER LEAVES THIS FUNCTION
 *
 * The Google credential and the spreadsheet id. Both are read from the
 * environment, held for the life of the request and never returned, logged or
 * written to a table. The response carries counts, a status and sanitized text,
 * because the response reaches a browser.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

import {
  parseServiceAccountKey, ServiceAccountTokenSource,
} from '../../../server/integrations/googleAuth.ts';
import { redact, sanitizeError, safeLog } from '../../../server/integrations/sanitize.ts';
import { resolveCaller } from '../../../server/integrations/requestAuth.ts';
import {
  checkHeaders, FIRST_DATA_ROW, HEADER_ROW, LEAD_HEADERS, LEAD_TAB, parseLeadRows,
  parseTouchRows, planCounts, planIsSafeToApply, planReconciliation, TOUCH_HEADERS,
  TOUCH_TAB,
} from '../../../server/integrations/leadMirror.ts';
import {
  buildMirrorExport, leadColumnFormats, touchColumnFormats,
} from '../../../server/integrations/leadMirrorExport.ts';
import { columnLetter } from '../../../server/integrations/leadMirrorShared.ts';
import {
  applyColumnFormats, clearValues, fetchSpreadsheetMeta, fetchValues, SHEETS_SCOPE,
  updateValues, type SheetsDeps, type SheetTab,
} from '../../../server/integrations/sheets.ts';
import {
  createServiceClient, ensureConnection, markConnectionError, markConnectionSynced,
} from '../_shared/supabaseStore.ts';
import {
  applyPlan, fetchExistingLeads, fetchExportLeads, fetchExportTouches,
  fetchMirrorActivities, persistAssignedKeys, saveMirrorRun,
} from '../_shared/leadMirrorStore.ts';

const PROVIDER = 'google_sheets' as const;

/** Read generously: far more rows than the sheet holds, so growth needs no edit. */
const READ_ROWS = 2000;

type Action = 'reconcile' | 'export';
type ReconcileMode = 'dry_run' | 'live';

interface RequestBody {
  action?: Action;
  mode?: ReconcileMode;
  expect?: { leadRows?: number; touchRows?: number };
  /** The day the follow-up derivation is read as at. Defaults to today, UTC. */
  asOf?: string;
}

function env(name: string): string | null {
  const value = Deno.env.get(name);
  return value === undefined || value.trim() === '' ? null : value;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-sync-cron-secret',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
  return response;
}

/** The tab, or a refusal naming what the spreadsheet actually has. */
function requireTab(tabs: readonly SheetTab[], title: string): SheetTab {
  const found = tabs.find((tab) => tab.title === title);
  if (!found) {
    throw new Error(
      `The spreadsheet has no tab called "${title}". Found: ${tabs.map((t) => t.title).join(', ') || 'none'}.`,
    );
  }
  return found;
}

/** Read one tab's header row and its data region in the two calls they need. */
async function readTab(
  deps: SheetsDeps,
  tab: string,
  headers: readonly string[],
): Promise<{ check: ReturnType<typeof checkHeaders>; values: string[][] }> {
  const lastColumn = columnLetter(headers.length - 1);
  const headerRow = await fetchValues(deps, tab, `A${HEADER_ROW}:${lastColumn}${HEADER_ROW}`);
  const check = checkHeaders(headerRow[0] ?? [], headers);
  const values = await fetchValues(
    deps, tab, `A${FIRST_DATA_ROW}:${lastColumn}${READ_ROWS}`,
  );
  return { check, values };
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    const response = new Response(null, { status: 204 });
    for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
    return response;
  }
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: 'Function is not configured' }, 500);
  }

  // Verified with the anon client, so a forged token cannot borrow the service
  // role's authority.
  const verifyJwt = async (token: string): Promise<string | null> => {
    try {
      const anon = createClient(supabaseUrl, env('SUPABASE_ANON_KEY') ?? serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await anon.auth.getUser(token);
      return error ? null : (data.user?.id ?? null);
    } catch {
      return null;
    }
  };

  const caller = await resolveCaller(
    request.headers,
    { cronSecret: env('SYNC_CRON_SECRET'), cronOwnerId: env('SYNC_OWNER_ID') },
    verifyJwt,
  );
  // One answer for every kind of refusal, so probing learns nothing.
  if (!caller) return json({ error: 'Not authorised' }, 401);

  let body: RequestBody = {};
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    // An empty body means an export, which is what the scheduler sends.
  }

  const action: Action = body.action ?? 'export';
  const mode: ReconcileMode = body.mode ?? 'dry_run';
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(body.asOf ?? '')
    ? (body.asOf as string)
    : new Date().toISOString().slice(0, 10);

  const spreadsheetId = env('GOOGLE_SHEETS_SPREADSHEET_ID');
  if (!spreadsheetId) {
    return json({ error: 'GOOGLE_SHEETS_SPREADSHEET_ID is not set' }, 500);
  }

  const client = createServiceClient(supabaseUrl, serviceRoleKey);
  const startedAt = new Date().toISOString();
  const idempotencyKey =
    action === 'reconcile'
      ? `google_sheets:reconcile:${mode}:${asOf}`
      : `google_sheets:export:${asOf}`;

  /* --- credentials ------------------------------------------------------ */

  let deps: SheetsDeps;
  try {
    const rawKey = env('GOOGLE_SERVICE_ACCOUNT_KEY');
    if (!rawKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
    deps = {
      tokenSource: new ServiceAccountTokenSource(parseServiceAccountKey(rawKey)),
      spreadsheetId,
    };
  } catch (error) {
    const summary = sanitizeError(error);
    safeLog('lead mirror: credentials unusable', summary);
    await markConnectionError(client, caller.ownerId, PROVIDER, summary);
    return json({ action, status: 'failed', error: summary }, 500);
  }

  /**
   * Record that a connection exists before doing the work.
   *
   * The display name is the spreadsheet's own title, which is not a secret and is
   * what a person would recognise. The spreadsheet id is deliberately not stored:
   * it is a function secret, and a connection row is readable by the browser.
   */
  let connectionId: string | null = null;
  let spreadsheetTitle = '';
  let tabs: readonly SheetTab[] = [];
  try {
    const meta = await fetchSpreadsheetMeta(deps);
    spreadsheetTitle = meta.title;
    tabs = meta.tabs;
    connectionId = await ensureConnection(
      client,
      caller.ownerId,
      PROVIDER,
      // provider_account_id is shown on screen, so it is the readable title.
      meta.title || 'Lead mirror spreadsheet',
      deps.tokenSource.describe(),
      [SHEETS_SCOPE],
    );
  } catch (error) {
    const summary = sanitizeError(error);
    safeLog('lead mirror: could not reach the spreadsheet', summary);
    await markConnectionError(client, caller.ownerId, PROVIDER, summary);
    await saveMirrorRun(client, {
      ownerId: caller.ownerId,
      connectionId: null,
      idempotencyKey,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'failed',
      rowsRead: null,
      rowsWritten: null,
      errorSummary: summary,
      details: { action, mode },
    });
    return json({ action, status: 'failed', error: summary }, 502);
  }

  try {
    if (action === 'reconcile') {
      /* ============================== reconcile ======================== */

      const leadTab = await readTab(deps, LEAD_TAB, LEAD_HEADERS);
      const touchTab = await readTab(deps, TOUCH_TAB, TOUCH_HEADERS);

      const headers = {
        [LEAD_TAB]: leadTab.check,
        [TOUCH_TAB]: touchTab.check,
      };

      /**
       * A wrong header is a refusal, not something to work around.
       *
       * Reading by position into a sheet where a column moved would put phone
       * numbers in the proposed-value column and email addresses in notes, and
       * every one of those rows would look plausible.
       */
      if (!leadTab.check.ok || !touchTab.check.ok) {
        const summary =
          'The spreadsheet header does not match what the importer expects, so nothing was read.';
        await saveMirrorRun(client, {
          ownerId: caller.ownerId,
          connectionId,
          idempotencyKey,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'failed',
          rowsRead: 0,
          rowsWritten: 0,
          errorSummary: summary,
          details: { action, mode, headerProblem: true },
        });
        return json({ action, mode, status: 'failed', headers, error: summary }, 422);
      }

      const leads = parseLeadRows(leadTab.values);
      const touches = parseTouchRows(touchTab.values);

      const plan = planReconciliation({
        leads,
        touches,
        existingLeads: await fetchExistingLeads(client, caller.ownerId),
        existingActivities: await fetchMirrorActivities(client, caller.ownerId),
      });

      const counts = planCounts(plan);
      const gate =
        mode === 'live'
          ? planIsSafeToApply(plan, {
              leadRows: body.expect?.leadRows ?? -1,
              touchRows: body.expect?.touchRows ?? -1,
            })
          : { ok: true, reasons: [] };

      const report = {
        action,
        mode,
        headers,
        counts,
        ambiguous: plan.ambiguous.map((entry) => ({
          ...entry,
          reason: redact(entry.reason),
        })),
        rejected: plan.rejected.map((row) => ({ ...row, reason: redact(row.reason) })),
        warnings: plan.warnings.map(redact),
        gate,
      };

      if (mode === 'dry_run') {
        await saveMirrorRun(client, {
          ownerId: caller.ownerId,
          connectionId,
          idempotencyKey,
          startedAt,
          completedAt: new Date().toISOString(),
          // A dry run wrote nothing on purpose, which is not a failure and not a
          // success either. 'skipped' is the honest word for it.
          status: 'skipped',
          rowsRead: plan.leadRowsRead + plan.touchRowsRead,
          rowsWritten: 0,
          errorSummary: null,
          details: { action, mode, ...counts },
        });
        safeLog(`lead mirror: dry run read ${plan.leadRowsRead}+${plan.touchRowsRead} rows`);
        return json({ ...report, status: 'dry_run', applied: null });
      }

      if (!gate.ok) {
        /**
         * Stop before writing, and say why.
         *
         * Not recorded as a failure: nothing broke. The sheet is simply not in the
         * state the caller said it would be in, and that is exactly the situation
         * this gate exists to catch.
         */
        await saveMirrorRun(client, {
          ownerId: caller.ownerId,
          connectionId,
          idempotencyKey,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'skipped',
          rowsRead: plan.leadRowsRead + plan.touchRowsRead,
          rowsWritten: 0,
          errorSummary: null,
          details: { action, mode, blocked: true, ...counts },
        });
        safeLog('lead mirror: live reconciliation refused', gate.reasons.join(' '));
        return json({ ...report, status: 'blocked', applied: null }, 409);
      }

      const applied = await applyPlan(client, caller.ownerId, plan);
      const written = applied.leadsCreated + applied.leadsUpdated + applied.touchesCreated;

      await saveMirrorRun(client, {
        ownerId: caller.ownerId,
        connectionId,
        idempotencyKey,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'succeeded',
        rowsRead: plan.leadRowsRead + plan.touchRowsRead,
        rowsWritten: written,
        errorSummary: null,
        details: {
          action,
          mode,
          ...counts,
          leadsCreated: applied.leadsCreated,
          leadsUpdated: applied.leadsUpdated,
          touchesCreated: applied.touchesCreated,
        },
      });
      await markConnectionSynced(client, caller.ownerId, PROVIDER);

      safeLog(
        `lead mirror: reconciled ${applied.leadsCreated} new, ${applied.leadsUpdated} updated, ${applied.touchesCreated} touches`,
      );

      return json({
        ...report,
        status: 'applied',
        applied: {
          leadsCreated: applied.leadsCreated,
          leadsUpdated: applied.leadsUpdated,
          touchesCreated: applied.touchesCreated,
        },
      });
    }

    /* ================================= export ========================== */

    const leadSheet = requireTab(tabs, LEAD_TAB);
    const touchSheet = requireTab(tabs, TOUCH_TAB);

    /**
     * Check the header before writing, every time.
     *
     * The export writes by position. If somebody inserted a column, writing
     * anyway would scatter a person's contact details across the wrong columns
     * of a document they rely on, and it would look like the sync worked.
     */
    const leadHeaderRange =
      `A${HEADER_ROW}:${columnLetter(LEAD_HEADERS.length - 1)}${HEADER_ROW}`;
    const touchHeaderRange =
      `A${HEADER_ROW}:${columnLetter(TOUCH_HEADERS.length - 1)}${HEADER_ROW}`;
    const leadHeader = await fetchValues(deps, LEAD_TAB, leadHeaderRange);
    const touchHeader = await fetchValues(deps, TOUCH_TAB, touchHeaderRange);
    const headers = {
      [LEAD_TAB]: checkHeaders(leadHeader[0] ?? [], LEAD_HEADERS),
      [TOUCH_TAB]: checkHeaders(touchHeader[0] ?? [], TOUCH_HEADERS),
    };

    if (!headers[LEAD_TAB].ok || !headers[TOUCH_TAB].ok) {
      const summary =
        'The spreadsheet header does not match what the mirror expects, so nothing was written.';
      await markConnectionError(client, caller.ownerId, PROVIDER, summary);
      await saveMirrorRun(client, {
        ownerId: caller.ownerId,
        connectionId,
        idempotencyKey,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'failed',
        rowsRead: 0,
        rowsWritten: 0,
        errorSummary: summary,
        details: { action, headerProblem: true },
      });
      return json({ action, status: 'failed', headers, error: summary }, 422);
    }

    const [exportLeads, exportTouches] = await Promise.all([
      fetchExportLeads(client, caller.ownerId, asOf),
      fetchExportTouches(client, caller.ownerId),
    ]);

    const built = buildMirrorExport({
      leads: exportLeads,
      touches: exportTouches,
      leadGridRows: leadSheet.rowCount,
      touchGridRows: touchSheet.rowCount,
    });

    /**
     * Persist invented keys before writing the sheet.
     *
     * This write is additive: it fills external_key where it was null and never
     * changes one that exists. Doing it first means that if the Google call then
     * fails, the keys are still saved and the next attempt produces exactly the
     * same Lead ID column rather than a different one.
     */
    const keysWritten = await persistAssignedKeys(
      client, caller.ownerId, built.assignedKeys,
    );

    for (const tabWrite of [built.leadTab, built.touchTab]) {
      if (tabWrite.range !== null) {
        await updateValues(deps, tabWrite.tab, tabWrite.range, tabWrite.values);
      }
      // Empty whatever the previous export left behind below the new last row.
      if (tabWrite.clearRange !== null) {
        await clearValues(deps, tabWrite.tab, tabWrite.clearRange);
      }
    }

    // Formats last, over the rows just written, so a date never renders as 46292.
    // batchUpdate row indexes are 0-based, so the first data row is one less.
    const firstDataIndex = FIRST_DATA_ROW - 1;
    if (built.leadRows > 0) {
      await applyColumnFormats(
        deps, leadSheet.sheetId, firstDataIndex, firstDataIndex + built.leadRows,
        leadColumnFormats(),
      );
    }
    if (built.touchRows > 0) {
      await applyColumnFormats(
        deps, touchSheet.sheetId, firstDataIndex, firstDataIndex + built.touchRows,
        touchColumnFormats(),
      );
    }

    await saveMirrorRun(client, {
      ownerId: caller.ownerId,
      connectionId,
      idempotencyKey,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'succeeded',
      rowsRead: exportLeads.length + exportTouches.length,
      rowsWritten: built.leadRows + built.touchRows,
      errorSummary: null,
      details: {
        action,
        leadRows: built.leadRows,
        touchRows: built.touchRows,
        keysAssigned: keysWritten,
        asOf,
      },
    });
    await markConnectionSynced(client, caller.ownerId, PROVIDER);

    safeLog(
      `lead mirror: exported ${built.leadRows} leads and ${built.touchRows} touches via ${caller.via}`,
    );

    return json({
      action,
      status: 'succeeded',
      spreadsheetTitle,
      headers,
      leadRows: built.leadRows,
      touchRows: built.touchRows,
      keysAssigned: keysWritten,
      asOf,
    });
  } catch (error) {
    /**
     * A failed mirror sync must leave the Cockpit working.
     *
     * Nothing in this catch touches lead or activity data. It records that the
     * attempt failed and answers honestly. Supabase is the authoritative copy and
     * it is untouched, so the worst case is a spreadsheet that is out of date.
     */
    const summary = sanitizeError(error);
    safeLog(`lead mirror: ${action} failed`, summary);
    await markConnectionError(client, caller.ownerId, PROVIDER, summary);
    try {
      await saveMirrorRun(client, {
        ownerId: caller.ownerId,
        connectionId,
        idempotencyKey,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'failed',
        rowsRead: null,
        rowsWritten: null,
        errorSummary: summary,
        details: { action, mode },
      });
    } catch (recordError) {
      safeLog('lead mirror: could not even record the failure', sanitizeError(recordError));
    }
    return json({ action, mode, status: 'failed', error: summary }, 502);
  }
});
