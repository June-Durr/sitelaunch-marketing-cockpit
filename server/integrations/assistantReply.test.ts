/**
 * Everything a model can get wrong on the way to a record about a real person.
 *
 * A strict schema guarantees the shape and nothing about the content. These are
 * the content checks: a contact id that does not exist, a date in the future, a
 * day that is not a day, a guess dressed up as something the contact said, a
 * quote that is not in what the person actually wrote.
 */

import { describe, expect, it } from 'vitest';

import { readDay, readProposal, unparsableProposal } from './assistantReply.ts';
import type { AssistantContext, LeadBrief } from './assistantContract.ts';
import { PROPOSAL_FIELDS } from '../../src/assistant/wire.ts';

const TODAY = '2026-10-14';
const EM_DASH = String.fromCharCode(0x2014);

function lead(over: Partial<LeadBrief> = {}): LeadBrief {
  return {
    id: 'lead-1',
    label: 'Chef Jamie',
    organization: 'FaKafe',
    stage: 'follow_up',
    channel: 'instagram',
    nextAction: null,
    nextActionDate: null,
    followUpMode: 'auto',
    lastTouchOn: '2026-10-12',
    lastTouchBasis: 'activity',
    ...over,
  };
}

function context(over: Partial<AssistantContext> = {}): AssistantContext {
  return {
    today: TODAY,
    screenName: 'Pipeline',
    focus: lead(),
    candidates: [],
    index: [lead(), lead({ id: 'lead-2', label: 'Ariel' })],
    indexTruncated: false,
    history: [],
    drafts: [],
    dueNow: [],
    counts: { leads: 2, openFollowUps: 1, overdue: 0 },
    ...over,
  };
}

/** A complete, well behaved model answer, to vary one field at a time from. */
function answer(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intent: 'capture',
    reply: 'Saved what you told me.',
    question: null,
    lead_id: null,
    person: {
      name: 'Eddie Claus', organization: null, role: 'DJ', channel: 'instagram',
      handle: '@eddieclaus.mlo', met_on: '2026-10-12', location: 'Doral', interest: 'a website',
    },
    conversation: {
      occurred_on: '2026-10-12', summary: 'Met at the chamber mixer', channel: 'in person',
      outcome: null, next_action: null, next_due_date: null,
    },
    draft: { channel: null, body: null, language: null },
    facts: [],
    references: [],
    ...over,
  });
}

describe('reading a day', () => {
  it('takes a real day', () => {
    expect(readDay('2026-10-12', TODAY, { allowFuture: false })).toEqual({
      day: '2026-10-12', problem: null,
    });
  });

  it('leaves null alone without complaining', () => {
    expect(readDay(null, TODAY, { allowFuture: false })).toEqual({ day: null, problem: null });
    expect(readDay('', TODAY, { allowFuture: false })).toEqual({ day: null, problem: null });
  });

  it('refuses a word that is not a date', () => {
    const result = readDay('recently', TODAY, { allowFuture: false });
    expect(result.day).toBeNull();
    expect(result.problem).toContain('not a day');
  });

  it('refuses a day that does not exist, rather than rolling it into next month', () => {
    const result = readDay('2026-02-31', TODAY, { allowFuture: false });
    expect(result.day).toBeNull();
    expect(result.problem).toContain('not a real day');
  });

  it('refuses something that has not happened yet, when it is meant to be past', () => {
    const result = readDay('2026-10-20', TODAY, { allowFuture: false });
    expect(result.day).toBeNull();
    expect(result.problem).toContain('has not happened yet');
  });

  it('allows a future date where a future date is the point', () => {
    expect(readDay('2026-10-20', TODAY, { allowFuture: true }).day).toBe('2026-10-20');
  });

  it('refuses a date far enough off to be a typo in either direction', () => {
    expect(readDay('2019-10-12', TODAY, { allowFuture: false }).day).toBeNull();
    expect(readDay('2031-01-01', TODAY, { allowFuture: true }).day).toBeNull();
  });
});

describe('reading a proposal', () => {
  it('returns null when the answer is not JSON at all', () => {
    expect(readProposal('I am afraid I cannot do that.', context(), 'hello')).toBeNull();
  });

  it('returns exactly the fields the browser declares', () => {
    const proposal = readProposal(answer(), context(), 'met Eddie');
    expect(Object.keys(proposal!).sort()).toEqual([...PROPOSAL_FIELDS].sort());
  });

  it('keeps a well formed answer intact', () => {
    const proposal = readProposal(answer(), context(), 'met Eddie at the mixer')!;
    expect(proposal.intent).toBe('capture');
    expect(proposal.person.name).toBe('Eddie Claus');
    expect(proposal.person.handle).toBe('@eddieclaus.mlo');
    expect(proposal.conversation.occurredOn).toBe('2026-10-12');
    expect(proposal.corrections).toEqual([]);
  });

  it('falls back to clarify when the intent is not one of ours', () => {
    const proposal = readProposal(answer({ intent: 'send_it' }), context(), 'x')!;
    expect(proposal.intent).toBe('clarify');
  });

  it('drops a contact id that was never in the context', () => {
    const proposal = readProposal(answer({ lead_id: 'lead-999' }), context(), 'x')!;
    expect(proposal.leadId).toBeNull();
    expect(proposal.corrections.join(' ')).toContain('not in the Cockpit');
  });

  it('keeps a contact id that was', () => {
    const proposal = readProposal(answer({ lead_id: 'lead-2' }), context(), 'x')!;
    expect(proposal.leadId).toBe('lead-2');
  });

  it('throws away a conversation date in the future and says so', () => {
    const proposal = readProposal(answer({
      conversation: {
        occurred_on: '2026-12-01', summary: 'talked', channel: null,
        outcome: null, next_action: null, next_due_date: null,
      },
    }), context(), 'x')!;
    expect(proposal.conversation.occurredOn).toBeNull();
    expect(proposal.corrections.join(' ')).toContain('has not happened yet');
  });

  it('allows a follow-up date in the future, which is what one is', () => {
    const proposal = readProposal(answer({
      conversation: {
        occurred_on: '2026-10-13', summary: 'talked', channel: null,
        outcome: null, next_action: 'call him', next_due_date: '2026-10-17',
      },
    }), context(), 'x')!;
    expect(proposal.conversation.nextDueDate).toBe('2026-10-17');
  });

  it('strips the em dash the model reaches for', () => {
    const proposal = readProposal(
      answer({ reply: `Saved it ${EM_DASH} nothing was sent.` }), context(), 'x',
    )!;
    expect(proposal.reply).not.toContain(EM_DASH);
    expect(proposal.reply).toBe('Saved it, nothing was sent.');
  });

  it('caps a reply that will not stop talking', () => {
    const proposal = readProposal(answer({ reply: 'a'.repeat(5000) }), context(), 'x')!;
    expect(proposal.reply.length).toBeLessThan(1600);
  });

  it('keeps only one question', () => {
    const proposal = readProposal(answer({ question: 'Which Jamie?' }), context(), 'x')!;
    expect(proposal.question).toBe('Which Jamie?');
    expect(typeof proposal.question).toBe('string');
  });
});

describe('facts, which is where provenance is enforced', () => {
  const said = 'Met Eddie at the mixer, he seemed keen but his partner handles the money.';

  it('keeps a stated fact as stated', () => {
    const proposal = readProposal(answer({
      facts: [{
        kind: 'identity', value: 'His partner handles the money',
        provenance: 'contact_stated', source_excerpt: 'his partner handles the money',
        occurred_on: null,
      }],
    }), context(), said)!;
    expect(proposal.facts).toHaveLength(1);
    expect(proposal.facts[0].provenance).toBe('contact_stated');
  });

  it('gives an inference with no quote the words it was drawn from', () => {
    const proposal = readProposal(answer({
      facts: [{
        kind: 'interest', value: 'Interested but not the decision maker',
        provenance: 'assistant_inferred', source_excerpt: null, occurred_on: null,
      }],
    }), context(), said)!;
    // Migration 0016 refuses an inferred fact with no excerpt, and the person's
    // own message genuinely is what it was inferred from.
    expect(proposal.facts[0].sourceExcerpt).toBe(said);
  });

  it('replaces a quote that is not in what the person wrote', () => {
    const proposal = readProposal(answer({
      facts: [{
        kind: 'interest', value: 'Ready to sign',
        provenance: 'assistant_inferred',
        source_excerpt: 'he said he wants to start on Monday',
        occurred_on: null,
      }],
    }), context(), said)!;
    expect(proposal.facts[0].sourceExcerpt).toBe(said);
    expect(proposal.corrections.join(' ')).toContain('not in what you wrote');
  });

  it('drops an inference when there are no words behind it at all', () => {
    const proposal = readProposal(answer({
      facts: [{
        kind: 'interest', value: 'Keen', provenance: 'assistant_inferred',
        source_excerpt: null, occurred_on: null,
      }],
    }), context(), '')!;
    expect(proposal.facts).toEqual([]);
  });

  it('refuses a provenance that is not one of the three', () => {
    const proposal = readProposal(answer({
      facts: [{
        kind: 'interest', value: 'Keen', provenance: 'obvious',
        source_excerpt: 'keen', occurred_on: null,
      }],
    }), context(), said)!;
    expect(proposal.facts).toEqual([]);
  });

  it('refuses a kind that is not one of the eight', () => {
    const proposal = readProposal(answer({
      facts: [{
        kind: 'vibe', value: 'Keen', provenance: 'contact_stated',
        source_excerpt: null, occurred_on: null,
      }],
    }), context(), said)!;
    expect(proposal.facts).toEqual([]);
  });

  it('drops a fact with nothing in its value', () => {
    const proposal = readProposal(answer({
      facts: [{
        kind: 'interest', value: '   ', provenance: 'contact_stated',
        source_excerpt: null, occurred_on: null,
      }],
    }), context(), said)!;
    expect(proposal.facts).toEqual([]);
  });

  it('clears an invented date on a fact but keeps the fact', () => {
    const proposal = readProposal(answer({
      facts: [{
        kind: 'reply', value: 'He replied', provenance: 'contact_stated',
        source_excerpt: null, occurred_on: '2027-04-01',
      }],
    }), context(), said)!;
    expect(proposal.facts).toHaveLength(1);
    expect(proposal.facts[0].occurredOn).toBeNull();
  });

  it('stops at twelve facts from one paragraph', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      kind: 'other', value: `thing ${i}`, provenance: 'contact_stated',
      source_excerpt: null, occurred_on: null,
    }));
    const proposal = readProposal(answer({ facts: many }), context(), said)!;
    expect(proposal.facts).toHaveLength(12);
  });

  it('survives facts that are not objects', () => {
    const proposal = readProposal(answer({ facts: ['keen', 42, null] }), context(), said)!;
    expect(proposal.facts).toEqual([]);
  });
});

describe('references, which become links', () => {
  it('keeps known ids, deduplicated', () => {
    const proposal = readProposal(answer({
      references: ['lead-1', 'lead-1', 'lead-2'],
    }), context(), 'x')!;
    expect(proposal.references).toEqual(['lead-1', 'lead-2']);
  });

  it('drops anything that is not a contact in the context', () => {
    const proposal = readProposal(answer({
      references: ['lead-404', '', 7],
    }), context(), 'x')!;
    expect(proposal.references).toEqual([]);
  });
});

describe('the fallback when the answer is unusable', () => {
  it('says something a person can read and proposes nothing', () => {
    const proposal = unparsableProposal('');
    expect(proposal.intent).toBe('clarify');
    expect(proposal.reply.length).toBeGreaterThan(10);
    expect(proposal.facts).toEqual([]);
    expect(proposal.person.name).toBeNull();
    expect(proposal.corrections.join(' ')).toContain('did not come back in the expected shape');
  });

  it('keeps the words of a refusal, since the person should see them', () => {
    expect(unparsableProposal('I will not write that.').reply).toBe('I will not write that.');
  });

  it('has the same fields as a real proposal', () => {
    expect(Object.keys(unparsableProposal('x')).sort()).toEqual([...PROPOSAL_FIELDS].sort());
  });
});
