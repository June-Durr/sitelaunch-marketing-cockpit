/**
 * The Google Sheets calls the lead mirror needs, and nothing more.
 *
 * Four operations: read a range, write a range, clear a range, and set a column's
 * number format. There is deliberately no "create sheet", no "delete sheet" and
 * no way to change a tab's properties, because the mirror has to preserve a sheet
 * a person built by hand. The title, the introductory notes, the frozen rows and
 * the filter views live in rows and properties this module never addresses, so
 * they survive by construction rather than by being carefully put back.
 *
 * WHERE THE CREDENTIAL LIVES
 *
 * Nowhere in here. Every function takes a GoogleTokenSource and asks it for a
 * bearer token at call time. The token comes from a service-account key held in
 * Supabase Edge Function secrets and read from the environment inside the
 * function. It is not in src/, not a VITE_ variable, not a database column and
 * not in any committed file. See server/README.md and googleAuth.ts.
 *
 * WHY ALMOST EVERY RESPONSE BODY IS DISCARDED ON FAILURE
 *
 * Google quotes the request back in its errors, and a Sheets request can carry a
 * person's email address and phone number. So the body is thrown away, as in the
 * GA4 and Search Console readers, with one narrow exception described at
 * googleReasons below: the fixed machine-readable reason codes, which are the
 * difference between "nobody shared the sheet" and "the API is switched off" and
 * which cannot carry anything sensitive because of the shape they are required to
 * have.
 */

import type { GoogleTokenSource } from './googleAuth.ts';

/**
 * Read and write, because the mirror is rewritten from the database.
 *
 * This is the one place in the project that asks Google for a write scope. The
 * analytics syncs are read-only and stay that way; a spreadsheet that is written
 * cannot be, and the Sheet was shared with the service account as an editor for
 * exactly this purpose.
 */
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const SHEETS_ENDPOINT = 'https://sheets.googleapis.com/v4/spreadsheets';

export interface SheetsDeps {
  tokenSource: GoogleTokenSource;
  spreadsheetId: string;
  fetchImpl?: typeof fetch;
}

/**
 * Quote a tab name for an A1 range.
 *
 * "Lead Mirror" has a space in it, so it has to be quoted or the API reads
 * "Lead" as the tab and "Mirror!A1" as nonsense. A single quote inside a tab name
 * is doubled, which is the A1 escaping rule.
 */
export function a1Range(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

/** A column index (0-based) as a spreadsheet letter. 0 is A, 26 is AA. */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Google's own reason codes for a failure, and nothing else from the body.
 *
 * A 403 from Sheets means one of two very different things: the spreadsheet was
 * never shared with the service account, or the Sheets API is not enabled on the
 * project. Both look identical from the status code, and guessing wrong costs an
 * afternoon. Google says which in `error.status` and `error.details[].reason`, as
 * fixed upper-case enum tokens: PERMISSION_DENIED, SERVICE_DISABLED,
 * ACCESS_TOKEN_SCOPE_INSUFFICIENT and so on.
 *
 * WHY THIS IS SAFE WHEN THE REST OF THE BODY IS NOT
 *
 * The filter is the shape, not the field name. A value is kept only if it is
 * upper-case letters and underscores, three to forty characters. An email address
 * cannot match that. Neither can a PEM block, a JWT, a bearer token, a phone
 * number or anybody's name, because all of them contain characters the pattern
 * rejects. So this cannot leak a credential or a contact detail even if Google
 * starts putting one in a field called `reason`.
 */
export function googleReasons(body: unknown): string[] {
  const safe = /^[A-Z][A-Z_]{2,39}$/;
  const found = new Set<string>();

  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error) return [];

  const status = error.status;
  if (typeof status === 'string' && safe.test(status)) found.add(status);

  const details = error.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const reason = (detail as { reason?: unknown } | null)?.reason;
      if (typeof reason === 'string' && safe.test(reason)) found.add(reason);
    }
  }

  return [...found];
}

async function call(
  deps: SheetsDeps,
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch;
  const token = await deps.tokenSource.getAccessToken([SHEETS_SCOPE]);

  const response = await doFetch(`${SHEETS_ENDPOINT}/${deps.spreadsheetId}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    // The status, plus Google's own reason codes and nothing else from the body.
    let reasons: string[] = [];
    try {
      reasons = googleReasons(await response.json());
    } catch {
      // No body, or not JSON. The status on its own still says something.
    }
    const because = reasons.length === 0 ? '' : `: ${reasons.join(', ')}`;
    throw new Error(
      `Google Sheets ${init.method} ${path.split('?')[0]} failed (HTTP ${response.status})${because}`,
    );
  }

  // A clear or an update answers with a small JSON body that nothing here needs,
  // but reading it keeps the connection tidy.
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** One tab, as the spreadsheet describes itself. */
export interface SheetTab {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
  frozenRowCount: number;
}

interface SpreadsheetMetaResponse {
  properties?: { title?: string };
  sheets?: {
    properties?: {
      sheetId?: number;
      title?: string;
      gridProperties?: {
        rowCount?: number;
        columnCount?: number;
        frozenRowCount?: number;
      };
    };
  }[];
}

export interface SpreadsheetMeta {
  title: string;
  tabs: SheetTab[];
}

/**
 * Which tabs exist, and how big they are.
 *
 * Read before anything else so a missing or renamed tab is a clear refusal rather
 * than a confusing empty read, and so a write knows how many rows it may clear
 * without running past the end of the grid.
 */
export async function fetchSpreadsheetMeta(deps: SheetsDeps): Promise<SpreadsheetMeta> {
  const body = (await call(deps, '?fields=properties.title,sheets.properties', {
    method: 'GET',
  })) as SpreadsheetMetaResponse | null;

  const tabs: SheetTab[] = [];
  for (const sheet of body?.sheets ?? []) {
    const props = sheet.properties;
    if (!props || typeof props.title !== 'string' || typeof props.sheetId !== 'number') continue;
    tabs.push({
      sheetId: props.sheetId,
      title: props.title,
      rowCount: props.gridProperties?.rowCount ?? 0,
      columnCount: props.gridProperties?.columnCount ?? 0,
      frozenRowCount: props.gridProperties?.frozenRowCount ?? 0,
    });
  }

  return { title: body?.properties?.title ?? '', tabs };
}

interface ValuesResponse {
  values?: unknown[][];
}

/**
 * A range, as the strings a person would see in the cells.
 *
 * FORMATTED_VALUE rather than the raw serial numbers, because a column of dates
 * in a hand-built sheet is not reliably a column of dates: some cells are real
 * dates and some are text that looks like one. Reading what is displayed means
 * one parser handles both, and parseSheetDate refuses anything it cannot read
 * rather than guessing a day.
 *
 * Google trims trailing empty rows and cells, so the result is ragged. Callers
 * read it through a padding helper rather than indexing it directly.
 */
export async function fetchValues(
  deps: SheetsDeps,
  tab: string,
  range: string,
): Promise<string[][]> {
  const encoded = encodeURIComponent(a1Range(tab, range));
  const body = (await call(
    deps,
    `/values/${encoded}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { method: 'GET' },
  )) as ValuesResponse | null;

  return (body?.values ?? []).map((row) =>
    (row ?? []).map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
  );
}

/**
 * Write a rectangle of values.
 *
 * USER_ENTERED, so a date written as 10/06/26 lands as a real date the sheet can
 * sort and filter, and a number lands as a number. RAW would make every cell text,
 * which looks identical and quietly breaks every filter the person set up.
 */
export async function updateValues(
  deps: SheetsDeps,
  tab: string,
  range: string,
  values: (string | number | null)[][],
): Promise<void> {
  const encoded = encodeURIComponent(a1Range(tab, range));
  await call(deps, `/values/${encoded}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: { range: a1Range(tab, range), majorDimension: 'ROWS', values },
  });
}

/**
 * Empty a range's values, leaving its formatting alone.
 *
 * Used for the rows below the data when the pipeline has shrunk. values:clear
 * removes contents and nothing else, so the date formats and the filter range
 * stay as they were and the next export writes into a sheet that still looks
 * like itself.
 */
export async function clearValues(deps: SheetsDeps, tab: string, range: string): Promise<void> {
  const encoded = encodeURIComponent(a1Range(tab, range));
  await call(deps, `/values/${encoded}:clear`, { method: 'POST', body: {} });
}

/** A number format to apply down one column of the data region. */
export interface ColumnFormat {
  /** 0-based column index within the sheet. */
  column: number;
  type: 'DATE' | 'NUMBER' | 'CURRENCY' | 'TEXT';
  pattern: string;
}

/**
 * Re-apply the data region's number formats.
 *
 * A hand-built sheet usually has its formats applied to the cells that existed
 * when somebody set them up. Rows added later fall outside that and render a date
 * as 46001, which is the single most common way a mirror stops being readable.
 * Setting the formats explicitly over the rows just written is cheaper than
 * explaining to somebody why their dates turned into five-digit numbers.
 *
 * Only numberFormat is touched. Fonts, colours, borders, frozen rows and filters
 * are not in the field mask, so nothing else can change.
 */
export async function applyColumnFormats(
  deps: SheetsDeps,
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  formats: ColumnFormat[],
): Promise<void> {
  if (formats.length === 0 || endRowIndex <= startRowIndex) return;

  await call(deps, ':batchUpdate', {
    method: 'POST',
    body: {
      requests: formats.map((format) => ({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex,
            endRowIndex,
            startColumnIndex: format.column,
            endColumnIndex: format.column + 1,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: format.type, pattern: format.pattern },
            },
          },
          fields: 'userEnteredFormat.numberFormat',
        },
      })),
    },
  });
}
