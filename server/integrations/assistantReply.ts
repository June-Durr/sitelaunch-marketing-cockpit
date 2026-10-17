/**
 * Turning what the model said into something that is allowed to be saved.
 *
 * Pure, and deliberately suspicious. A strict schema makes the shape reliable;
 * it does nothing about the content. The model can still name a contact id that
 * does not exist, date a conversation in 2027, call its own guess something the
 * contact stated, or hand back a fact with no words behind it. Every one of
 * those would write a wrong thing into a record about a real person, so every
 * one of them is checked here rather than at the database, where the failure
 * would be a constraint violation the person cannot act on.
 *
 * WHAT THIS FILE IS NOT
 *
 * It is not the last line of defence. The constraints in migration 0016 are,
 * and they stay. This exists so the person sees a usable proposal with the
 * doubtful parts already dropped, instead of an error from Postgres.
 */

import {
  FACT_KINDS, INTENTS, PROVENANCES, type AssistantContext, type Intent,
} from './assistantContract.ts';

export interface ProposedFact {
  kind: (typeof FACT_KINDS)[number];
  value: string;
  provenance: (typeof PROVENANCES)[number];
  sourceExcerpt: string | null;
  occurredOn: string | null;
}

export interface ProposedPerson {
  name: string | null;
  organization: string | null;
  role: string | null;
  channel: string | null;
  handle: string | null;
  metOn: string | null;
  location: string | null;
  interest: string | null;
}

export interface ProposedConversation {
  occurredOn: string | null;
  /** The event or venue, in their words. Used in the first message. */
  place: string | null;
  summary: string | null;
  channel: string | null;
  outcome: string | null;
  nextAction: string | null;
  nextDueDate: string | null;
}

export interface ProposedDraft {
  channel: string | null;
  body: string | null;
  language: string | null;
}

export interface AssistantProposal {
  intent: Intent;
  reply: string;
  question: string | null;
  leadId: string | null;
  person: ProposedPerson;
  conversation: ProposedConversation;
  draft: ProposedDraft;
  facts: ProposedFact[];
  references: string[];
  /**
   * What was changed on the way through, in words a person can read.
   *
   * Shown in the panel rather than swallowed. If the assistant guessed a date
   * and the guess was thrown away, the person is better off knowing that than
   * wondering why the date is empty.
   */
  corrections: string[];
}

/* ------------------------------------------------------------------ limits --- */

const MAX_REPLY = 1500;
const MAX_QUESTION = 300;
const MAX_FIELD = 300;
const MAX_SUMMARY = 1200;
const MAX_BODY = 2400;
const MAX_FACTS = 12;
const MAX_REFERENCES = 8;
/** A date more than this far either side of today is not a date, it is a typo. */
const DATE_WINDOW_DAYS = 400;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Models reach for an em dash constantly, and the house style has none.
  const cleaned = trimmed.replace(/\s*—\s*/g, ', ');
  return cleaned.length > limit ? `${cleaned.slice(0, limit).trimEnd()}...` : cleaned;
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * A date, or null, and never a guess.
 *
 * Four ways to fail: not a string, not yyyy-mm-dd, not a real day (2026-02-31
 * parses nowhere), or so far from today that it is a transcription error rather
 * than a date somebody meant.
 */
export function readDay(
  value: unknown,
  today: string,
  options: { allowFuture: boolean },
): { day: string | null; problem: string | null } {
  if (typeof value !== 'string' || value.trim() === '') return { day: null, problem: null };
  const raw = value.trim();
  if (!ISO_DAY.test(raw)) return { day: null, problem: `ignored the date "${raw}", which is not a day` };

  const parsed = dayNumber(raw);
  if (Number.isNaN(parsed)) return { day: null, problem: `ignored the date "${raw}", which is not a real day` };
  // Date.parse accepts 2026-02-30 by rolling it into March, so the round trip
  // back to a string is what actually catches an impossible day.
  if (new Date(parsed).toISOString().slice(0, 10) !== raw) {
    return { day: null, problem: `ignored the date "${raw}", which is not a real day` };
  }

  const now = dayNumber(today);
  if (Number.isNaN(now)) return { day: raw, problem: null };

  const days = Math.round((parsed - now) / 86_400_000);
  if (!options.allowFuture && days > 0) {
    return { day: null, problem: `ignored "${raw}", which has not happened yet` };
  }
  if (Math.abs(days) > DATE_WINDOW_DAYS) {
    return { day: null, problem: `ignored "${raw}", which is too far from today to be right` };
  }
  return { day: raw, problem: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/* ------------------------------------------------------------- the parsing --- */

/** Every contact id the model was shown. Anything else it names is made up. */
export function allowedLeadIds(context: AssistantContext): Set<string> {
  const ids = new Set<string>();
  if (context.focus) ids.add(context.focus.id);
  for (const lead of context.candidates) ids.add(lead.id);
  for (const lead of context.index) ids.add(lead.id);
  for (const item of context.dueNow) ids.add(item.id);
  return ids;
}

/**
 * Read the model's JSON into a proposal, dropping what cannot be trusted.
 *
 * Returns null only when there is nothing usable at all, which means the text
 * was not JSON. Everything else degrades: a bad date becomes null, an unknown
 * contact id becomes null, a fact with no words behind it is dropped, and each
 * of those is written into `corrections` so the panel can say so.
 */
export function readProposal(
  raw: string,
  context: AssistantContext,
  userWords: string,
): AssistantProposal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const body = asRecord(parsed);
  const corrections: string[] = [];
  const note = (problem: string | null) => {
    if (problem) corrections.push(problem);
  };

  const intent = oneOf(body.intent, INTENTS) ?? 'clarify';
  const reply = text(body.reply, MAX_REPLY) ?? '';

  const allowed = allowedLeadIds(context);
  let leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
  if (leadId !== '' && !allowed.has(leadId)) {
    corrections.push('dropped a contact reference that is not in the Cockpit');
    leadId = '';
  }

  const personIn = asRecord(body.person);
  const metOn = readDay(personIn.met_on, context.today, { allowFuture: false });
  note(metOn.problem);
  const person: ProposedPerson = {
    name: text(personIn.name, MAX_FIELD),
    organization: text(personIn.organization, MAX_FIELD),
    role: text(personIn.role, MAX_FIELD),
    channel: text(personIn.channel, MAX_FIELD),
    handle: text(personIn.handle, MAX_FIELD),
    metOn: metOn.day,
    location: text(personIn.location, MAX_FIELD),
    interest: text(personIn.interest, MAX_FIELD),
  };

  const conversationIn = asRecord(body.conversation);
  const occurredOn = readDay(conversationIn.occurred_on, context.today, { allowFuture: false });
  note(occurredOn.problem);
  const nextDue = readDay(conversationIn.next_due_date, context.today, { allowFuture: true });
  note(nextDue.problem);
  const conversation: ProposedConversation = {
    occurredOn: occurredOn.day,
    place: text(conversationIn.place, MAX_FIELD),
    summary: text(conversationIn.summary, MAX_SUMMARY),
    channel: text(conversationIn.channel, MAX_FIELD),
    outcome: text(conversationIn.outcome, MAX_FIELD),
    nextAction: text(conversationIn.next_action, MAX_FIELD),
    nextDueDate: nextDue.day,
  };

  const draftIn = asRecord(body.draft);
  const draft: ProposedDraft = {
    channel: text(draftIn.channel, MAX_FIELD),
    body: text(draftIn.body, MAX_BODY),
    language: text(draftIn.language, 16),
  };

  const facts = readFacts(body.facts, context, userWords, corrections);

  const references: string[] = [];
  for (const value of Array.isArray(body.references) ? body.references : []) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (id === '' || references.includes(id)) continue;
    if (!allowed.has(id)) continue;
    if (references.length < MAX_REFERENCES) references.push(id);
  }

  return {
    intent,
    reply,
    question: text(body.question, MAX_QUESTION),
    leadId: leadId === '' ? null : leadId,
    person,
    conversation,
    draft,
    facts,
    references,
    corrections,
  };
}

/**
 * The facts, with the two rules that matter enforced.
 *
 * An inferred fact has to show the words it came from: migration 0016 refuses
 * one that does not, and it refuses it for a good reason. Where the model has
 * left the excerpt out, the person's own message is the honest answer, because
 * that genuinely is what the inference was drawn from. Where the model has
 * quoted something that is not in the message, the quote is replaced for the
 * same reason: a source_excerpt is meant to be checkable.
 */
function readFacts(
  value: unknown,
  context: AssistantContext,
  userWords: string,
  corrections: string[],
): ProposedFact[] {
  const out: ProposedFact[] = [];
  const said = userWords.trim();
  const saidLower = said.toLowerCase();
  let invented = 0;

  for (const raw of Array.isArray(value) ? value : []) {
    if (out.length >= MAX_FACTS) break;
    const item = asRecord(raw);
    const kind = oneOf(item.kind, FACT_KINDS);
    const provenance = oneOf(item.provenance, PROVENANCES);
    const factValue = text(item.value, MAX_FIELD);
    if (!kind || !provenance || !factValue) continue;

    const day = readDay(item.occurredOn ?? item.occurred_on, context.today, { allowFuture: false });
    if (day.problem) corrections.push(day.problem);

    let excerpt = text(item.source_excerpt, MAX_FIELD);
    if (provenance === 'assistant_inferred') {
      const quoted = excerpt !== null && saidLower.includes(excerpt.toLowerCase().slice(0, 40));
      if (!quoted) {
        if (excerpt !== null) invented += 1;
        excerpt = said === '' ? null : said.slice(0, MAX_FIELD);
      }
      // An inference with nothing behind it cannot be stored, and should not be.
      if (excerpt === null) continue;
    }

    out.push({
      kind,
      value: factValue,
      provenance,
      sourceExcerpt: excerpt,
      occurredOn: day.day,
    });
  }

  if (invented > 0) {
    corrections.push(
      invented === 1
        ? 'replaced one quote that was not in what you wrote'
        : `replaced ${invented} quotes that were not in what you wrote`,
    );
  }
  return out;
}

/**
 * The fallback, when the model answered with something that is not JSON.
 *
 * A reply the person can read, no proposal, and the reason said out loud. The
 * alternative is an empty panel, which looks like the assistant is broken when
 * the truth is that one answer came back malformed.
 */
export function unparsableProposal(reply: string): AssistantProposal {
  return {
    intent: 'clarify',
    reply: reply.trim() === '' ? 'I could not make sense of that one. Try saying it again.' : reply.trim(),
    question: null,
    leadId: null,
    person: {
      name: null, organization: null, role: null, channel: null,
      handle: null, metOn: null, location: null, interest: null,
    },
    conversation: {
      occurredOn: null, place: null, summary: null, channel: null,
      outcome: null, nextAction: null, nextDueDate: null,
    },
    draft: { channel: null, body: null, language: null },
    facts: [],
    references: [],
    corrections: ['the answer did not come back in the expected shape, so nothing was proposed'],
  };
}
