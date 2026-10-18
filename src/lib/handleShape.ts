/**
 * Where a handle belongs, decided by its shape.
 *
 * A handle is whatever somebody reads off a business card: a number, an
 * address, or an @name. Only the first two have a column of their own, and
 * guessing wrong is worse than leaving one empty, so the shape decides and
 * anything ambiguous stays in the notes where a person will read it.
 *
 * WHY THIS FILE EXISTS
 *
 * Because there were two of these. A contact captured for the first time has
 * its handle filed by capture_contact in SQL; a handle reviewed against a
 * contact that already exists is filed by the browser. The two had different
 * rules, so "(305) 555-0188" became a phone number on one path and a line of
 * notes on the other, and an address kept its capital letters on one and lost
 * them on the other. The same person, filed differently depending on which
 * screen they arrived through.
 *
 * This is the browser half. The SQL half is in the migration that files a
 * handle during capture, and src/test/pg/handleShape.test.ts runs both over the
 * same list of inputs and fails if they ever disagree, which is the only way a
 * twin stays a twin.
 */

export type HandleKind = 'phone' | 'email' | 'other';

export interface ClassifiedHandle {
  kind: HandleKind;
  /** The value as it should be stored. Addresses are lowercased; nothing else is. */
  value: string;
}

/**
 * Characters a written phone number is allowed to contain.
 *
 * Deliberately generous about punctuation, because people write numbers every
 * way there is, and strict about what the digits add up to: the character class
 * alone would file "..." as a phone number.
 */
const PHONE_CHARACTERS = /^[+()0-9 ./-]+$/;

/** The fewest digits that could be a dialable number anywhere. */
export const PHONE_MIN_DIGITS = 7;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function classifyHandle(handle: string | null | undefined): ClassifiedHandle {
  const value = (handle ?? '').trim();
  if (value === '') return { kind: 'other', value: '' };

  if (EMAIL.test(value)) {
    // Lowercased, because an address is not case sensitive in the part that
    // matters and two spellings of one address are two rows waiting to happen.
    return { kind: 'email', value: value.toLowerCase() };
  }

  if (PHONE_CHARACTERS.test(value)) {
    const digits = value.replace(/\D/g, '');
    if (digits.length >= PHONE_MIN_DIGITS) return { kind: 'phone', value };
  }

  return { kind: 'other', value };
}
