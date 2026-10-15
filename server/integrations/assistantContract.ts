/**
 * What the assistant is asked, and the one shape it is allowed to answer in.
 *
 * Pure. No network, no database, no provider. This file is the difference
 * between an assistant and a chatbot: every reply comes back through one strict
 * schema whose fields map onto operations that already exist and are already
 * tested, and anything outside that schema cannot be expressed at all.
 *
 * WHY THE CONTEXT IS SUPPLIED RATHER THAN RETRIEVED
 *
 * The Cockpit selects the records and puts them in the prompt. One round trip,
 * no retrieval step that can fetch the wrong person, and the answer is built out
 * of exactly what the person is looking at on screen. The honest limit is size:
 * the lead index is a prompt, so it stops fitting somewhere in the low
 * thousands of contacts, and the tool seam in openai.ts is where that goes next.
 *
 * WHAT THE SCHEMA REFUSES TO EXPRESS
 *
 * That a message was sent. There is no field for it anywhere below. A send is
 * recorded when a person says so, through mark_draft_sent, and no model output
 * can reach that function. Same for a completed task, a confirmed reply, and a
 * date nobody knew: the fields are nullable and null is the normal answer.
 */

/* ------------------------------------------------------------- the context --- */

/** One contact, as the prompt sees them. No ids beyond the one, no notes dump. */
export interface LeadBrief {
  id: string;
  /** Already labelled by the Cockpit, so a placeholder name never reaches here. */
  label: string;
  organization: string | null;
  stage: string;
  channel: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  followUpMode: string;
  /** The day of the last confirmed touch, and whether it was an event or a claim. */
  lastTouchOn: string | null;
  lastTouchBasis: string;
}

/** One thing that happened, for the pinned contact only. */
export interface HistoryBrief {
  on: string;
  type: string;
  title: string;
  channel: string | null;
  /** The wording that was approved and sent, when there was one. */
  message: string | null;
  outcome: string | null;
  /** True when this record has been reversed and should not be read as history. */
  reversed: boolean;
}

/** A draft still waiting on a decision. */
export interface DraftBrief {
  id: string;
  channel: string | null;
  status: string;
  body: string;
  createdOn: string;
}

export interface AssistantContext {
  /** The day the Cockpit believes it is. Every relative date resolves against this. */
  today: string;
  /** Where the person is in the app right now. */
  screenName: string;
  /** The contact the panel is pinned to, if any. */
  focus: LeadBrief | null;
  /** Contacts the typed words matched, when the Cockpit could not pick one. */
  candidates: LeadBrief[];
  /** Everyone, thinly, so a named person can be found without a guess. */
  index: LeadBrief[];
  /** True when index was cut short, so the model does not read it as everyone. */
  indexTruncated: boolean;
  /** The pinned contact's confirmed history, newest first. */
  history: HistoryBrief[];
  /** The pinned contact's open drafts. */
  drafts: DraftBrief[];
  /** What is due now, across everybody. */
  dueNow: { id: string; label: string; dueDate: string; title: string }[];
  counts: { leads: number; openFollowUps: number; overdue: number };
}

/* -------------------------------------------------------------- the schema --- */

export const FACT_KINDS = [
  'identity', 'channel', 'interest', 'concern', 'promise', 'reply', 'next_step', 'other',
] as const;

export const PROVENANCES = ['contact_stated', 'user_impression', 'assistant_inferred'] as const;

export const INTENTS = ['capture', 'record', 'draft', 'answer', 'clarify'] as const;

export type Intent = (typeof INTENTS)[number];

/** The top level keys, in order. Asserted against the browser's copy in the tests. */
export const REPLY_KEYS = [
  'intent', 'reply', 'question', 'lead_id', 'person', 'conversation', 'draft',
  'facts', 'references',
] as const;

const nullableString = { type: ['string', 'null'] };

/**
 * The reply schema, strict.
 *
 * Strict mode wants every key listed in `required` and every object closed, so
 * optionality is expressed as a nullable type rather than as an absent key. That
 * is also the better fit here: a model that has nothing to say about a date has
 * to say null, which is a different thing from forgetting the field.
 *
 * The three groups are always present and `intent` says which to read. Nested
 * nullable objects would be tidier and are the one shape strict mode is
 * inconsistent about across providers, so they are flat groups with nullable
 * leaves instead.
 */
export const REPLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [...REPLY_KEYS],
  properties: {
    intent: {
      type: 'string',
      enum: [...INTENTS],
      description:
        'capture: a new person to add. record: contact that already happened. '
        + 'draft: a message to write or revise. answer: a question about what is '
        + 'in the Cockpit. clarify: not enough to act on yet.',
    },
    reply: {
      type: 'string',
      description: 'What to say to the person. Plain words, no em dashes, no markdown.',
    },
    question: {
      ...nullableString,
      description:
        'At most one question, and only when the answer would change what gets '
        + 'written. Null otherwise.',
    },
    lead_id: {
      ...nullableString,
      description:
        'The contact this is about. Must be an id that appears in the context. '
        + 'Null for a person who is not in the Cockpit yet.',
    },
    person: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'organization', 'role', 'channel', 'handle', 'met_on', 'location', 'interest'],
      properties: {
        name: nullableString,
        organization: nullableString,
        role: nullableString,
        channel: { ...nullableString, description: 'How to reach them: text, email, instagram, linkedin, phone, in person.' },
        handle: { ...nullableString, description: 'Their username or address on that channel, exactly as given.' },
        met_on: { ...nullableString, description: 'yyyy-mm-dd, only if the day is actually known.' },
        location: nullableString,
        interest: { ...nullableString, description: 'What they want, in their terms.' },
      },
    },
    conversation: {
      type: 'object',
      additionalProperties: false,
      required: ['occurred_on', 'summary', 'channel', 'outcome', 'next_action', 'next_due_date'],
      properties: {
        occurred_on: { ...nullableString, description: 'yyyy-mm-dd. The day the contact happened.' },
        summary: nullableString,
        channel: nullableString,
        outcome: { ...nullableString, description: 'What came of it, in one short line.' },
        next_action: nullableString,
        next_due_date: {
          ...nullableString,
          description:
            'Only when the person said a date. The Cockpit decides the follow-up '
            + 'cadence otherwise, so null means "use the rule".',
        },
      },
    },
    draft: {
      type: 'object',
      additionalProperties: false,
      required: ['channel', 'body', 'language'],
      properties: {
        channel: nullableString,
        body: { ...nullableString, description: 'The message itself, ready to send. No placeholders in brackets.' },
        language: { ...nullableString, description: 'The language it is written in, for example en or es.' },
      },
    },
    facts: {
      type: 'array',
      description: 'What was learned, one claim per entry. Empty is a valid answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value', 'provenance', 'source_excerpt', 'occurred_on'],
        properties: {
          kind: { type: 'string', enum: [...FACT_KINDS] },
          value: { type: 'string' },
          provenance: {
            type: 'string',
            enum: [...PROVENANCES],
            description:
              'contact_stated: they said it. user_impression: the user formed this '
              + 'view. assistant_inferred: you worked it out. Never promote one to another.',
          },
          source_excerpt: {
            ...nullableString,
            description: 'The words this came from, quoted from the message. Required for assistant_inferred.',
          },
          occurred_on: { ...nullableString, description: 'yyyy-mm-dd, or null when the day is not known.' },
        },
      },
    },
    references: {
      type: 'array',
      description: 'Contact ids the answer refers to, so the Cockpit can link to them.',
      items: { type: 'string' },
    },
  },
};

/* -------------------------------------------------------- the instructions --- */

/**
 * The standing instructions.
 *
 * This is the written contract from docs/ai-workflow-contract.md, in the form
 * the model reads. It is deliberately specific about the three or four things
 * that would do real damage if got wrong, and quiet about everything else.
 */
export function buildInstructions(context: AssistantContext): string {
  return [
    'You are the assistant inside the SiteLaunch Marketing Cockpit, a small',
    'marketing and lead tracker used by one person who is not a marketer.',
    `Today is ${context.today}.`,
    '',
    'You never do anything yourself. You propose, and the person presses a button.',
    'Nothing you return is saved until they do.',
    '',
    'HOW TO WRITE',
    'Short, plain sentences. Talk like a colleague, not a chatbot. No em dashes,',
    'no bullet characters, no markdown, no headings. Do not open with a greeting',
    'or close with an offer of further help. Say what you found or what you need.',
    '',
    'WHAT YOU MUST NOT DO',
    'Do not say a message was sent, delivered, replied to or read. You cannot know',
    'that. Only the person can confirm a send, and copying a draft is not sending it.',
    'Do not invent a date. If the day is not known, the date is null. "Recently" is',
    'not a date. Do not turn a mood into a fact: if the person tells you somebody',
    'seemed keen, that is their impression, not something the contact stated.',
    'Do not say a task is done, a follow-up is scheduled, or a calendar event exists.',
    'Do not use a contact id that is not in the context below.',
    '',
    'PROVENANCE, WHICH IS THE POINT',
    'Every fact carries who is making the claim.',
    'contact_stated is what the contact themselves said. It is evidence.',
    'user_impression is what the person using the Cockpit thinks. It may be wrong.',
    'assistant_inferred is what you worked out. It is a guess, and it must quote the',
    'words you worked it out from in source_excerpt.',
    'When in doubt, the weaker claim is the right one.',
    '',
    'ASKING',
    'At most one question per reply, and only when the answer changes what gets',
    'written. A missing surname is not worth a question; which of two people this',
    'is, or whether a promise was theirs or the user’s, is. Save what you are sure',
    'of and ask about the rest in the same reply.',
    '',
    'DATES AND FOLLOW-UPS',
    'The Cockpit has its own follow-up cadence and applies it when the contact is',
    'recorded. Leave next_due_date null unless the person named a day. If they say',
    'a weekday or "next week", resolve it against today and say in your reply which',
    'date you took it to mean.',
    '',
    'DRAFTS',
    'Write the message the person would actually send: a few lines, specific to what',
    'the history says, no placeholders in brackets. Match the language the contact',
    'uses. If the history shows the last message went unanswered, acknowledge that',
    'without apologising for it twice.',
  ].join('\n');
}

/* ------------------------------------------------------- rendering context --- */

function line(label: string, value: string | null | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : `${label}: ${text}`;
}

function renderLead(lead: LeadBrief, full: boolean): string {
  const parts = [
    `id ${lead.id}`,
    lead.label,
    lead.organization ? `at ${lead.organization}` : null,
    `stage ${lead.stage}`,
  ].filter(Boolean);

  if (!full) {
    const touch = lead.lastTouchOn
      ? `last touch ${lead.lastTouchOn} (${lead.lastTouchBasis})`
      : 'never contacted';
    return `${parts.join(', ')}, ${touch}`;
  }

  const extra = [
    line('channel', lead.channel),
    line('next action', lead.nextAction),
    line('next action date', lead.nextActionDate),
    line('follow-up mode', lead.followUpMode),
    lead.lastTouchOn
      ? `last touch: ${lead.lastTouchOn} (${lead.lastTouchBasis === 'reported' ? 'claimed by an import, no event behind it' : 'from the activity log'})`
      : 'last touch: never contacted',
  ].filter((part): part is string => Boolean(part));

  return [parts.join(', '), ...extra.map((part) => `  ${part}`)].join('\n');
}

/**
 * The context, as text the model reads.
 *
 * Text rather than JSON because it is read once and never parsed back, and a
 * sentence costs fewer tokens than the same thing in braces. Everything in here
 * came out of the Cockpit's own tables: nothing is computed, reworded or
 * rounded on the way in.
 */
export function renderContext(context: AssistantContext): string {
  const out: string[] = [];

  out.push(`WHERE THE PERSON IS: ${context.screenName}`);
  out.push(
    `THE COCKPIT HOLDS: ${context.counts.leads} contacts, `
    + `${context.counts.openFollowUps} open follow-ups, ${context.counts.overdue} overdue.`,
  );

  if (context.focus) {
    out.push('', 'THE CONTACT THIS IS ABOUT', renderLead(context.focus, true));
  } else if (context.candidates.length > 0) {
    out.push('', 'THE TYPED WORDS MATCHED MORE THAN ONE CONTACT. Ask which, naming them.');
    for (const lead of context.candidates) out.push(renderLead(lead, true));
  }

  if (context.history.length > 0) {
    out.push('', 'CONFIRMED HISTORY, NEWEST FIRST');
    for (const event of context.history) {
      if (event.reversed) {
        out.push(`${event.on} ${event.type}: REVERSED, this did not happen. Ignore it.`);
        continue;
      }
      const bits = [
        `${event.on} ${event.type}`,
        event.channel ? `by ${event.channel}` : null,
        event.title,
        event.outcome ? `outcome: ${event.outcome}` : null,
      ].filter(Boolean);
      out.push(bits.join(' | '));
      if (event.message) out.push(`  what was sent: ${event.message.slice(0, 400)}`);
    }
  } else if (context.focus) {
    out.push('', 'CONFIRMED HISTORY: none. Nothing has been recorded for this contact.');
  }

  if (context.drafts.length > 0) {
    out.push('', 'DRAFTS ALREADY WRITTEN FOR THIS CONTACT, NOT SENT');
    for (const draft of context.drafts) {
      out.push(
        `id ${draft.id}, ${draft.channel ?? 'no channel'}, ${draft.status}, `
        + `written ${draft.createdOn}: ${draft.body.slice(0, 400)}`,
      );
    }
  }

  if (context.dueNow.length > 0) {
    out.push('', 'DUE NOW');
    for (const item of context.dueNow) {
      out.push(`${item.dueDate} ${item.label}: ${item.title} (id ${item.id})`);
    }
  }

  if (context.index.length > 0) {
    out.push('', 'EVERY CONTACT, THINLY');
    for (const lead of context.index) out.push(renderLead(lead, false));
    if (context.indexTruncated) {
      out.push('(this list was cut short, so it is not everybody)');
    }
  }

  return out.join('\n');
}

/** The whole prompt for one turn: instructions, context, then the conversation. */
export function buildInput(
  context: AssistantContext,
  turns: { role: 'user' | 'assistant'; content: string }[],
): { role: 'user' | 'assistant'; content: string }[] {
  return [
    { role: 'user' as const, content: `${renderContext(context)}\n\nTHE PERSON SAYS:` },
    ...turns,
  ];
}
