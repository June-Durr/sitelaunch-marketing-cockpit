/**
 * The shape of the lead mirror spreadsheet, and the string handling both
 * directions need.
 *
 * Split out so that reading the sheet and writing it cannot drift apart. The
 * importer and the exporter must agree on exactly where the data starts and what
 * each column means, and the only way to guarantee that is for there to be one
 * copy of the answer.
 *
 * Nothing here touches a network or a database.
 */

/** The source name stored against every external key this integration creates. */
export const MIRROR_SOURCE = 'google_sheets';

export const LEAD_TAB = 'Lead Mirror';
export const TOUCH_TAB = 'Touch History';

/**
 * Where the data starts, and why it is not row 1.
 *
 * The sheet was built for a person to read: row 1 is blank, row 2 is the title,
 * row 3 is a note about what the sheet is for, row 4 is a spacer and row 5 is the
 * header. Those rows are the reason the mirror is useful to a human rather than
 * just a table, so the import reads around them and the export never writes over
 * them. Preserving the title, the notes and the frozen header is therefore not a
 * feature that has to work: it is a consequence of never addressing those cells.
 */
export const HEADER_ROW = 5;
export const FIRST_DATA_ROW = 6;

/** Exactly the Lead Mirror header, in order. A rename is a refusal, not a guess. */
export const LEAD_HEADERS = [
  'Lead ID', 'Contact', 'Organization', 'Relationship', 'Stage', 'Current status',
  'Source', 'First contact', 'Last touch', 'Days since touch', 'Next action',
  'Next follow-up', 'Follow-up status', 'Channel', 'Email', 'Phone / WhatsApp',
  'Proposed value', 'Context / notes', 'Record confidence',
] as const;

/** Exactly the Touch History header, in order. */
export const TOUCH_HEADERS = [
  'Date', 'Lead ID', 'Contact', 'Organization', 'Activity', 'Channel', 'Details',
  'Evidence / source',
] as const;

export type LeadHeader = (typeof LEAD_HEADERS)[number];
export type TouchHeader = (typeof TOUCH_HEADERS)[number];

/**
 * Which column a header is in.
 *
 * Throws rather than returning -1. A caller asking for a column that does not
 * exist has a typo, and writing to column -1 would silently put a phone number
 * somewhere nobody looks.
 */
export function columnOf(headers: readonly string[], name: string): number {
  const index = headers.indexOf(name);
  if (index === -1) throw new Error(`No such mirror column: ${name}`);
  return index;
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
 * An empty cell is null, and stays null.
 *
 * Google already trims trailing empty cells, so a short row and a row of blanks
 * arrive the same way. Both mean the same thing: nobody recorded this. Never 0,
 * never an empty string in the database, never a guessed value.
 */
export function blankToNull(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** A row padded to a known width, so a short row reads as blanks not undefined. */
export function padRow(row: readonly string[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < width; i += 1) out.push(row[i] ?? '');
  return out;
}

/** Is the whole row empty? Google leaves these in the middle of a range. */
export function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => (cell ?? '').trim() === '');
}

/**
 * Casefold and collapse whitespace. Nothing else.
 *
 * This is what "normalized" means in this integration, and the limit is
 * deliberate. Stripping punctuation would make "O'Brien" and "OBrien" the same
 * person; dropping middle names would make two Taylors one. Those are guesses.
 * Lowercase and single spaces are not: they are the same string typed differently.
 */
export function normalizeName(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Trim and lowercase an address. No dot or plus folding.
 *
 * Whether a.b@gmail.com and ab@gmail.com are the same mailbox is a fact about
 * Gmail, not about email, and acting on it would merge two people at any provider
 * that treats them as two.
 */
export function normalizeEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}
