/**
 * One value per press of one button.
 *
 * The whole duplicate-write defence in this app rests on this: a token
 * identifies one press, a retry of that press reuses it, and the database
 * refuses the second write rather than making a second record. Generating it
 * any earlier would make every press a repeat of the first; any later and a
 * retry would look like a new press.
 *
 * In its own file because three different places now need one, and a copy in
 * each is how two of them end up subtly different.
 */
export function pressToken(what: string): string {
  return `assistant:${what}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}
