/**
 * Working out who somebody is talking about, without asking a model.
 *
 * WHY THIS IS NOT THE MODEL'S JOB
 *
 * Matching a typed name to a stored record is string comparison, and string
 * comparison is something a computer does exactly and a language model does
 * approximately. The approximate version attaches a message to the wrong person
 * roughly one time in some number nobody can state, and that one time writes a
 * false record about a real contact. So the matching happens here, the result is
 * put in front of the model as fact, and the model is never asked to guess which
 * Jamie was meant.
 *
 * WHAT IT DOES WHEN IT IS NOT SURE
 *
 * Says so. One confident match becomes the pinned contact; several plausible
 * ones become candidates, and the person picks. A weak single match is a
 * candidate too, not a pin: "the chef" matching "Chef Jamie" is a maybe, and
 * treating a maybe as a certainty is the whole failure this avoids.
 */

import { isPlaceholderName, leadLabel } from './leadLabel';

export interface MatchableLead {
  id: string;
  prospect_name: string | null;
  organization: string | null;
  email: string | null;
  phone: string | null;
  project: string | null;
}

export interface Match {
  id: string;
  label: string;
  score: number;
  /** Which parts of the record the typed words touched, for the panel to show. */
  reasons: string[];
}

export interface MatchResult {
  /** The one contact this is certainly about, or null. */
  pinned: Match | null;
  /** Everyone it could plausibly be, best first. Empty when nothing matched. */
  candidates: Match[];
}

/**
 * Words that match everybody and therefore nobody.
 *
 * Organisation names in this data are full of them: "Studios", "Services",
 * "Group". A record whose only overlap with what somebody typed is the word
 * "services" is not a match, it is a coincidence.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'about', 'that', 'this', 'they', 'them',
  'his', 'her', 'their', 'our', 'was', 'were', 'has', 'had', 'did', 'does',
  'met', 'meet', 'saw', 'talked', 'spoke', 'said', 'told', 'asked', 'sent',
  'call', 'called', 'text', 'texted', 'email', 'emailed', 'message', 'messaged',
  'follow', 'followed', 'following', 'back', 'left', 'off', 'where', 'what',
  'when', 'who', 'how', 'why', 'need', 'needs', 'wants', 'want', 'like',
  'llc', 'inc', 'co', 'company', 'group', 'studio', 'studios', 'services',
  'service', 'solutions', 'contact', 'client', 'guy', 'lady', 'person', 'name',
  'pending', 'unknown', 'today', 'yesterday', 'tomorrow', 'week', 'month',
]);

/** Lowercase, punctuation out, handles and dots kept because they identify people. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9@._\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return normalise(text).split(' ').filter((word) => word !== '');
}

/** The parts of a name or organisation worth matching on. */
function keyWords(value: string | null): string[] {
  if (!value) return [];
  return words(value).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

/* --------------------------------------------------------------- scoring --- */

/**
 * How strong a match has to be before it is treated as certain.
 *
 * A full name appearing in the text scores 100. Two separate name words score
 * 2 x 30. One name word plus the organisation scores 30 + 25. One name word on
 * its own scores 30, which is deliberately below the line.
 */
export const PIN_SCORE = 55;
const WEAK_SCORE = 20;

function scoreLead(lead: MatchableLead, text: string, textWords: Set<string>): Match | null {
  const reasons: string[] = [];
  let score = 0;

  const name = lead.prospect_name?.trim() ?? '';
  const named = !isPlaceholderName(lead.prospect_name);
  const organization = lead.organization?.trim() ?? '';

  // The whole name, as typed. The strongest signal there is.
  if (named && name.length >= 4 && text.includes(normalise(name))) {
    score += 100;
    reasons.push('their full name');
  } else if (named) {
    const matched = keyWords(name).filter((word) => textWords.has(word));
    if (matched.length > 0) {
      score += 30 * matched.length;
      reasons.push(matched.length === 1 ? 'part of their name' : 'their name');
    }
  }

  if (organization !== '' && organization.toLowerCase() !== 'unknown') {
    if (organization.length >= 4 && text.includes(normalise(organization))) {
      /*
       * A whole business name is as identifying as a whole personal name, and
       * for the records that have no personal name it is the only thing there
       * is. So this clears the pin threshold on its own: typing "DJ 4THE WIN"
       * is not an accident. Two contacts at the same business are still not
       * pinned, because the margin rule in matchContacts catches that.
       */
      score += 70;
      reasons.push('their business');
    } else {
      const matched = keyWords(organization).filter((word) => textWords.has(word));
      if (matched.length > 0) {
        score += 25 * matched.length;
        reasons.push('part of their business name');
      }
    }
  }

  // An address or a handle is as good as a name, because nobody types one by
  // accident. The local part is enough: "ariel@" identifies Ariel.
  const email = lead.email?.trim().toLowerCase() ?? '';
  if (email !== '' && (text.includes(email) || text.includes(email.split('@')[0]))) {
    score += 80;
    reasons.push('their email');
  }

  /*
   * The last ten digits, both sides.
   *
   * Stored numbers carry a country code about half the time and typed ones
   * almost never do, so comparing the whole string misses the match that
   * matters. Ten digits is a US number without its country code, which is what
   * this data is.
   */
  const digits = (value: string) => value.replace(/\D+/g, '');
  const phone = digits(lead.phone ?? '').slice(-10);
  if (phone.length >= 7 && digits(text).includes(phone)) {
    score += 80;
    reasons.push('their number');
  }

  // The project is what the work is called, which is often how it gets referred
  // to: "the taco truck site". Weaker than a name, because several records can
  // share a word.
  const project = keyWords(lead.project).filter((word) => textWords.has(word));
  if (project.length > 0) {
    score += 15 * project.length;
    reasons.push('what the work is called');
  }

  if (score <= 0) return null;
  return { id: lead.id, label: leadLabel(lead), score, reasons };
}

/**
 * Who the typed words are about.
 *
 * `pinned` is set only when one contact is clearly ahead: it must clear the
 * threshold and be meaningfully stronger than whatever came second. Two people
 * who both match well are both candidates, which is the honest answer and the
 * one that produces a question instead of a wrong record.
 */
export function matchContacts(
  text: string,
  leads: readonly MatchableLead[],
  limit = 5,
): MatchResult {
  const normalised = normalise(text);
  if (normalised === '') return { pinned: null, candidates: [] };
  const textWords = new Set(words(text));

  const scored: Match[] = [];
  for (const lead of leads) {
    const match = scoreLead(lead, normalised, textWords);
    if (match && match.score > WEAK_SCORE) scored.push(match);
  }

  // Score first, then label, so the order is stable for two equal scores and a
  // test does not depend on the order rows came out of the database.
  scored.sort((a, b) => (b.score - a.score) || a.label.localeCompare(b.label));
  const candidates = scored.slice(0, limit);

  const best = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;
  const clear = best !== null
    && best.score >= PIN_SCORE
    && (runnerUp === null || best.score >= runnerUp.score * 1.6);

  return { pinned: clear ? best : null, candidates };
}
