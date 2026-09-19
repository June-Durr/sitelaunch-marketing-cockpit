/**
 * Minimal RFC4180-ish CSV reader for manual exports (GA4, platform insights).
 *
 * Blank cells become null, not 0, because the entire point of importing rather than
 * retyping is that the import must not invent observations that were not made.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string | null>[];
}

export function parseCsv(text: string): ParsedCsv {
  const rows = splitRows(text.replace(/^﻿/, ''));
  if (rows.length === 0) return { headers: [], rows: [] };

  // GA4 exports prepend comment lines. The header is the first row that has more
  // than one column and does not start with '#'.
  const headerIndex = rows.findIndex(
    (r) => r.length > 1 && !(r[0] ?? '').trim().startsWith('#'),
  );
  if (headerIndex === -1) return { headers: [], rows: [] };

  const headers = rows[headerIndex].map((h) => h.trim());
  const body = rows.slice(headerIndex + 1).filter((r) => r.some((c) => c.trim() !== ''));

  return {
    headers,
    rows: body.map((cells) => {
      const record: Record<string, string | null> = {};
      headers.forEach((header, i) => {
        const raw = (cells[i] ?? '').trim();
        record[header] = raw === '' ? null : raw;
      });
      return record;
    }),
  };
}

function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Normalises a header for fuzzy matching: "Active users" -> "activeusers". */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find the column in `headers` matching any of `candidates`. Returns null when
 * nothing matches, so an unmapped column imports as null instead of as zero.
 */
export function matchHeader(headers: string[], candidates: string[]): string | null {
  const wanted = candidates.map(normalizeHeader);
  for (const header of headers) {
    if (wanted.includes(normalizeHeader(header))) return header;
  }
  return null;
}

/** Strip thousands separators and currency marks, then parse. Blank stays null. */
export function csvNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/[,$\s%]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
