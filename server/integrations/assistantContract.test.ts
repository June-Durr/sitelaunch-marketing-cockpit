/**
 * The schema and the prompt, asserted.
 *
 * Two things are being protected. The schema has to be a legal strict-mode
 * schema, because the provider rejects the whole request if it is not and the
 * failure arrives as a 400 with no clue in it. And the prompt has to keep saying
 * the things that stop a model writing something untrue about a real person: a
 * later edit that tidies those lines away is the realistic way this breaks.
 */

import { describe, expect, it } from 'vitest';

import {
  buildInput, buildInstructions, FACT_KINDS, INTENTS, PROVENANCES, renderContext,
  REPLY_KEYS, REPLY_SCHEMA, type AssistantContext, type LeadBrief,
} from './assistantContract.ts';

const EM_DASH = String.fromCharCode(0x2014);

function lead(over: Partial<LeadBrief> = {}): LeadBrief {
  return {
    id: 'lead-1',
    label: 'Chef Jamie',
    organization: 'FaKafe',
    stage: 'follow_up',
    channel: 'instagram',
    nextAction: 'Send the menu photos',
    nextActionDate: '2026-10-20',
    followUpMode: 'auto',
    lastTouchOn: '2026-10-12',
    lastTouchBasis: 'activity',
    ...over,
  };
}

function context(over: Partial<AssistantContext> = {}): AssistantContext {
  return {
    today: '2026-10-14',
    screenName: 'Pipeline',
    focus: null,
    candidates: [],
    index: [],
    indexTruncated: false,
    history: [],
    drafts: [],
    dueNow: [],
    counts: { leads: 22, openFollowUps: 17, overdue: 3 },
    ...over,
  };
}

/* ------------------------------------------------------------- the schema --- */

interface SchemaNode {
  type?: unknown;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
  items?: SchemaNode;
  enum?: unknown[];
  description?: unknown;
}

/** Every object in the schema, so the strict rules can be checked on each one. */
function objects(node: SchemaNode, path = 'root'): { path: string; node: SchemaNode }[] {
  const found: { path: string; node: SchemaNode }[] = [];
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes('object')) found.push({ path, node });
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    found.push(...objects(child, `${path}.${key}`));
  }
  if (node.items) found.push(...objects(node.items, `${path}[]`));
  return found;
}

function everyString(node: SchemaNode): string[] {
  const out: string[] = [];
  if (typeof node.description === 'string') out.push(node.description);
  for (const value of node.enum ?? []) if (typeof value === 'string') out.push(value);
  for (const child of Object.values(node.properties ?? {})) out.push(...everyString(child));
  if (node.items) out.push(...everyString(node.items));
  return out;
}

describe('the reply schema is a legal strict schema', () => {
  const root = REPLY_SCHEMA as SchemaNode;
  const all = objects(root);

  it('closes every object, so the model cannot invent a field', () => {
    for (const { path, node } of all) {
      expect(node.additionalProperties, `${path} is open`).toBe(false);
    }
  });

  it('requires every property of every object, since optional is spelled nullable', () => {
    for (const { path, node } of all) {
      const properties = Object.keys(node.properties ?? {});
      expect([...(node.required ?? [])].sort(), `${path} required list`).toEqual(
        [...properties].sort(),
      );
    }
  });

  it('spells optional fields as a nullable type rather than an absent key', () => {
    const conversation = (root.properties ?? {}).conversation;
    const occurred = (conversation.properties ?? {}).occurred_on;
    expect(occurred.type).toEqual(['string', 'null']);
  });

  it('lists the top level keys the rest of the code expects', () => {
    expect(Object.keys(root.properties ?? {}).sort()).toEqual([...REPLY_KEYS].sort());
  });

  it('keeps the three enums in step with the database constraints', () => {
    // These same three lists are checked in migration 0016. A fourth provenance
    // added here and not there would be a runtime constraint violation.
    expect(PROVENANCES).toEqual([
      'contact_stated', 'user_stated', 'user_impression', 'assistant_inferred',
    ]);
    expect([...FACT_KINDS]).toEqual([
      'identity', 'channel', 'interest', 'concern', 'promise', 'reply', 'next_step', 'other',
    ]);
    expect([...INTENTS]).toContain('clarify');
  });

  it('offers no way at all to say a message was sent', () => {
    const text = JSON.stringify(REPLY_SCHEMA).toLowerCase();
    for (const word of ['sent_at', 'sent_on', '"sent"', 'was_sent', 'delivered']) {
      expect(text, `the schema mentions ${word}`).not.toContain(word);
    }
  });

  it('uses no em dashes in anything the model reads', () => {
    for (const line of everyString(root)) expect(line).not.toContain(EM_DASH);
  });
});

/* ------------------------------------------------------- the instructions --- */

describe('the instructions', () => {
  const text = buildInstructions(context());

  it('says what day it is, so a weekday can be resolved without a guess', () => {
    expect(text).toContain('2026-10-14');
  });

  it('forbids claiming a send', () => {
    expect(text.toLowerCase()).toContain('copying a draft is not sending it');
  });

  it('forbids inventing a date', () => {
    expect(text.toLowerCase()).toContain('do not invent a date');
  });

  it('keeps the three provenances apart in words, not just in the schema', () => {
    for (const word of [
      'contact_stated', 'user_stated', 'user_impression', 'assistant_inferred',
    ]) {
      expect(text).toContain(word);
    }
    expect(text.toLowerCase()).toContain('the weaker claim is the right one');
  });

  it('tells a report apart from an impression in words, not just in the enum', () => {
    // The failure this fixes: "I told him I would text examples" came back as
    // user_impression, and the screen called a promise a feeling.
    expect(text).toContain('"I told him I would send examples" is user_stated');
    expect(text).toContain('"He seemed keen" is user_impression');
    expect(text.toLowerCase()).toContain('do not file a report as an impression');
  });

  it('allows one question and only when it changes what gets written', () => {
    expect(text.toLowerCase()).toContain('at most one question');
  });

  it('leaves the follow-up cadence to the Cockpit', () => {
    expect(text.toLowerCase()).toContain('leave next_due_date null unless');
  });

  it('bans the house style tells', () => {
    expect(text).not.toContain(EM_DASH);
    expect(text.toLowerCase()).toContain('no em dashes');
  });
});

/* ------------------------------------------------------------ the context --- */

describe('rendering the context', () => {
  it('puts the pinned contact and their id in, so the reply can name them', () => {
    const text = renderContext(context({ focus: lead() }));
    expect(text).toContain('THE CONTACT THIS IS ABOUT');
    expect(text).toContain('id lead-1');
    expect(text).toContain('Chef Jamie');
    expect(text).toContain('FaKafe');
  });

  it('says plainly when a contact has no history at all', () => {
    const text = renderContext(context({ focus: lead() }));
    expect(text).toContain('CONFIRMED HISTORY: none');
  });

  it('marks a reversed activity as something that did not happen', () => {
    const text = renderContext(context({
      focus: lead(),
      history: [{
        on: '2026-10-12', type: 'follow_up_sent', title: 'Sent a follow up',
        channel: 'instagram', message: 'hello', outcome: null, reversed: true,
      }],
    }));
    expect(text).toContain('REVERSED, this did not happen');
    // And the wording that was reversed is not quoted as though it were sent.
    expect(text).not.toContain('what was sent: hello');
  });

  it('says where a claimed last touch came from, rather than presenting it as an event', () => {
    const text = renderContext(context({
      focus: lead({ lastTouchBasis: 'reported' }),
    }));
    expect(text).toContain('claimed by an import, no event behind it');
  });

  it('says when the contact list was cut short, so it is not read as everybody', () => {
    const text = renderContext(context({
      index: [lead(), lead({ id: 'lead-2', label: 'Ariel' })],
      indexTruncated: true,
    }));
    expect(text).toContain('not everybody');
  });

  it('asks for a choice when the typed words matched more than one person', () => {
    const text = renderContext(context({
      candidates: [lead(), lead({ id: 'lead-2', label: 'Jamie Olsen' })],
    }));
    expect(text).toContain('MATCHED MORE THAN ONE CONTACT');
    expect(text).toContain('id lead-2');
  });

  it('shows drafts as written and not sent', () => {
    const text = renderContext(context({
      focus: lead(),
      drafts: [{
        id: 'draft-1', channel: 'instagram', status: 'copied',
        body: 'Hola Jamie', createdOn: '2026-10-13',
      }],
    }));
    expect(text).toContain('NOT SENT');
    expect(text).toContain('id draft-1');
  });
});

describe('building the input', () => {
  it('puts the context first and the conversation after it, newest last', () => {
    const input = buildInput(context({ focus: lead() }), [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]);
    expect(input).toHaveLength(4);
    expect(input[0].content).toContain('THE CONTACT THIS IS ABOUT');
    expect(input[3]).toEqual({ role: 'user', content: 'second' });
  });

  it('sends the context as a turn rather than as fake instructions', () => {
    // The instructions go in their own field. Smuggling context in there would
    // mix what the assistant is with what it happens to be looking at.
    const input = buildInput(context(), [{ role: 'user', content: 'hi' }]);
    expect(input[0].role).toBe('user');
  });
});
