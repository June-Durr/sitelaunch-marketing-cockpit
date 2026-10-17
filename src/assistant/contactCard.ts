/**
 * A contact card a phone will accept, and an honest account of what the web
 * cannot do with contacts.
 *
 * WHAT IS POSSIBLE
 *
 * Handing the browser a .vcf file. Both iPhone and Android open one in their
 * own contacts app, which then shows its own "add" or "merge" screen. That
 * screen belongs to the phone, and it is where a person decides what happens.
 *
 * WHAT IS NOT POSSIBLE
 *
 * Writing a contact. There is no web API for it on any platform. The Contact
 * Picker API, which does exist, is read only, experimental, and in practice
 * Chrome on Android alone; it lets somebody choose a contact to hand to a page,
 * not the other way round.
 *
 * So there is no deduplication here, and nothing in this app may claim any.
 * The Cockpit cannot see your address book, so it cannot know whether this
 * person is already in it. What it can do is hand over a card and say plainly
 * that the merge decision is the phone's.
 */

/** One line of the card, as the preview shows it before anything is exported. */
export interface CardField {
  label: string;
  value: string;
}

export interface ContactCardInput {
  name: string | null;
  organization: string | null;
  phone: string | null;
  email: string | null;
  /** Lines chosen by the person, not everything on file. */
  notes: string[];
}

/**
 * Escaping, per the vCard grammar.
 *
 * Backslash first, or every escape added afterwards gets escaped again. Commas
 * and semicolons are structural in this format, and a business called "Smith,
 * Jones and Co" splits a field in two without this.
 */
export function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/** The name, split the way the format wants it: family first, then given. */
export function structuredName(name: string): { family: string; given: string } {
  const parts = name.trim().split(/\s+/).filter((part) => part !== '');
  if (parts.length === 0) return { family: '', given: '' };
  if (parts.length === 1) return { family: '', given: parts[0] };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}

/**
 * What the card will contain, for the preview.
 *
 * The preview exists because this file leaves the app and lands in somebody's
 * address book, where it is tedious to correct. Seeing it first is cheaper than
 * fixing it later.
 */
export function cardPreview(input: ContactCardInput): CardField[] {
  const fields: CardField[] = [];
  const name = (input.name ?? '').trim();
  const organization = (input.organization ?? '').trim();
  const phone = (input.phone ?? '').trim();
  const email = (input.email ?? '').trim();

  if (name !== '') fields.push({ label: 'Name', value: name });
  if (organization !== '') fields.push({ label: 'Business', value: organization });
  if (phone !== '') fields.push({ label: 'Phone', value: phone });
  if (email !== '') fields.push({ label: 'Email', value: email });
  for (const note of input.notes.filter((n) => n.trim() !== '')) {
    fields.push({ label: 'Note', value: note.trim() });
  }
  return fields;
}

/** Version 3.0, which is the one both phones have read for a decade. */
export function buildVCard(input: ContactCardInput): string | null {
  const name = (input.name ?? '').trim();
  const organization = (input.organization ?? '').trim();
  if (name === '' && organization === '') return null;

  const display = name !== '' ? name : organization;
  const { family, given } = structuredName(display);
  const notes = input.notes.filter((note) => note.trim() !== '').map((note) => note.trim());

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeVCardValue(family)};${escapeVCardValue(given)};;;`,
    `FN:${escapeVCardValue(display)}`,
  ];

  if (organization !== '') lines.push(`ORG:${escapeVCardValue(organization)}`);

  const phone = (input.phone ?? '').trim();
  if (phone !== '') lines.push(`TEL;TYPE=CELL:${escapeVCardValue(phone)}`);

  const email = (input.email ?? '').trim();
  if (email !== '') lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(email)}`);

  if (notes.length > 0) {
    // One NOTE field. Several would be legal and most phones show only the first.
    lines.push(`NOTE:${escapeVCardValue(notes.join('\n'))}`);
  }

  lines.push('END:VCARD');
  // Carriage returns, which the format requires and some Android parsers insist on.
  return `${lines.join('\r\n')}\r\n`;
}

/** A filename somebody can find again in a downloads folder. */
export function cardFileName(input: ContactCardInput): string {
  const base = ((input.name ?? '').trim() || (input.organization ?? '').trim() || 'contact')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base === '' ? 'contact' : base}.vcf`;
}

/**
 * What this browser can actually do with a contact, asked rather than assumed.
 *
 * `canRead` is the Contact Picker API, and it is here to be honest about the
 * asymmetry rather than because anything uses it: being able to read an address
 * book is not being able to write to one, and it is not deduplication either.
 */
export interface ContactSupport {
  /** Downloading a .vcf, which is how a contact reaches a phone. */
  canExport: boolean;
  /** The read only Contact Picker API. Chrome on Android, in practice. */
  canRead: boolean;
  /** True when this looks like a device with a messaging app. */
  looksLikePhone: boolean;
}

export function contactSupport(
  navigatorLike: { userAgent?: string; contacts?: unknown } | undefined,
  hasBlobUrls: boolean,
): ContactSupport {
  const userAgent = navigatorLike?.userAgent ?? '';
  return {
    canExport: hasBlobUrls,
    canRead: Boolean(navigatorLike && 'contacts' in navigatorLike && navigatorLike.contacts),
    looksLikePhone: /android|iphone|ipad|ipod/i.test(userAgent),
  };
}
