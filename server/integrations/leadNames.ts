/**
 * Whether a lead actually has a name, and what to call it when it does not.
 *
 * WHY THIS IS SHARED RATHER THAN DUPLICATED
 *
 * The rule has to hold in three places that do not otherwise talk to each
 * other: the screens, the calendar entries and the sheet mirror. Writing it
 * three times would mean a lead showing as "DJ 4THE WIN" in the app and
 * "Name pending" on the calendar, which is the exact inconsistency this exists
 * to stop.
 *
 * WHY THE PLACEHOLDER IS NOT SIMPLY DELETED FROM THE DATABASE
 *
 * prospect_name is NOT NULL, so there is nowhere to put "unknown". The honest
 * alternative would be writing the organisation into the name column, which
 * then makes "we do not know this person's name" indistinguishable from "their
 * name happens to match their company". The placeholder stays in the data,
 * record_confidence says the record is incomplete, and nothing displays it.
 */

/**
 * Placeholders that have been used in place of a real name.
 *
 * Matched loosely because they arrived by hand and by import: "Name pending",
 * "name pending", and the dashed form one record uses all mean the same thing.
 * The dash is written as an escape rather than typed, because this project's
 * copy rule forbids that character in source and a test enforces it.
 */
const PLACEHOLDER = /(^|\s|\u2014|-)\s*name\s+pending\s*$/i;

/** Is this a real name, or a note that there is not one? */
export function isPlaceholderName(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return true;
  const trimmed = name.trim();
  if (trimmed === '') return true;
  return PLACEHOLDER.test(trimmed) || trimmed.toLowerCase() === 'name pending';
}

/**
 * The name to address, or the organisation when nobody knows it.
 *
 * "DJ 4THE WIN" is something you can act on. "Name pending" is not.
 */
export function displayName(
  prospectName: string | null | undefined,
  organization: string | null | undefined,
): string | null {
  if (!isPlaceholderName(prospectName)) return (prospectName as string).trim();
  const org = organization?.trim() ?? '';
  if (org !== '' && org.toLowerCase() !== 'unknown') return org;
  return null;
}
