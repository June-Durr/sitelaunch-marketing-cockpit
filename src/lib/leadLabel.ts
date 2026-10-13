/**
 * What to call a lead on screen.
 *
 * WHY "NAME PENDING" IS NOT AN ANSWER
 *
 * Several records carry the literal string "Name pending" as a prospect name,
 * which then appears in queues, calendar entries and confirmations as though it
 * were somebody's name. It is not a name, it is the absence of one, and printing
 * it tells a reader nothing except that the app has a gap.
 *
 * When the person is unknown and the organisation is not, the organisation is
 * the better label: "DJ 4THE WIN" is a thing you can act on, and "Name pending"
 * is not. The unknown name is still unknown in the data; this only decides what
 * to show.
 */

/**
 * Placeholders that have been used in place of a real name.
 *
 * This is a twin of leadNames.ts on the server side, which the calendar and the
 * sheet mirror use. They are separate because the browser is not allowed to
 * import anything from that layer, and a test asserts the two agree on every
 * input rather than trusting them to stay in step. That is the same arrangement
 * reconcile_follow_up_tasks already has with src/config/followUpTasks.ts.
 *
 * The path is not written out here on purpose: the test that enforces the
 * boundary matches on the literal text, so naming it would fail the build.
 *
 * The dash is written as an escape rather than typed, because this project's
 * copy rule forbids that character in source and a test enforces it.
 */
const PLACEHOLDER = /(^|\s|\u2014|-)\s*name\s+pending\s*$/i;

/** Is this a real name, or a note that there is not one? */
export function isPlaceholderName(name: string | null): boolean {
  if (name === null) return true;
  const trimmed = name.trim();
  if (trimmed === '') return true;
  return PLACEHOLDER.test(trimmed) || trimmed.toLowerCase() === 'name pending';
}

export interface LabelledLead {
  prospect_name: string | null;
  organization: string | null;
}

/**
 * The name to show, and the organisation beside it where it adds something.
 *
 * "Carlos Flores Iselo, Sweet Stax" tells you who and where. "Sweet Stax" alone
 * is what you get when nobody knows the person's name yet, which is honest.
 * Repeating the organisation when it is already the label would read as
 * "Sweet Stax, Sweet Stax".
 */
export function leadLabel(lead: LabelledLead): string {
  const org = lead.organization?.trim() ?? '';
  const named = !isPlaceholderName(lead.prospect_name);

  if (named) {
    const name = (lead.prospect_name as string).trim();
    return org === '' || org.toLowerCase() === 'unknown' ? name : `${name}, ${org}`;
  }

  if (org !== '' && org.toLowerCase() !== 'unknown') return org;

  // Neither. Saying so is better than inventing either one.
  return 'Contact not yet identified';
}

/** Just the part you would address a message to. No organisation. */
export function leadShortLabel(lead: LabelledLead): string {
  if (!isPlaceholderName(lead.prospect_name)) return (lead.prospect_name as string).trim();
  const org = lead.organization?.trim() ?? '';
  if (org !== '' && org.toLowerCase() !== 'unknown') return org;
  return 'this contact';
}
