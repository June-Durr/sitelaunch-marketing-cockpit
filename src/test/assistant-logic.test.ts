/**
 * The parts of the assistant that never ask a model.
 *
 * Which contact somebody meant, which model tier a turn is worth, what the
 * prompt is allowed to see. All three are decided in the browser by plain code,
 * because all three are decisions a wrong answer to would be expensive: the
 * first writes a record about the wrong person, the second spends money, and
 * the third is what the answer is built out of.
 *
 * Every contact below is invented.
 */

import { describe, expect, it } from 'vitest';

import { matchContacts, normalise, PIN_SCORE } from '../lib/contactMatch';
import { pickOperation } from '../assistant/route';
import { screenDescription, screenName } from '../assistant/screens';
import { buildAssistantContext, historyFor, leadBrief } from '../assistant/buildContext';
import { EMPTY_DATASET } from '../data/repository';
import type { Dataset } from '../types/domain';
import { makeActivity, makeLead, makeTask } from './fixtures';

const TODAY = '2026-10-14';

const PEOPLE = [
  makeLead({ id: 'l-jamie', prospect_name: 'Chef Jamie', organization: 'FaKafe' }),
  makeLead({ id: 'l-jamie-two', prospect_name: 'Jamie Olsen', organization: 'Olsen Tile' }),
  makeLead({
    id: 'l-ariel', prospect_name: 'Ariel Santos', organization: null,
    email: 'ariel.santos@example.com', preferred_channel: 'WhatsApp',
  }),
  makeLead({
    id: 'l-dj', prospect_name: 'Name pending', organization: 'DJ 4THE WIN',
    phone: '+1 305 555 0142',
  }),
  makeLead({ id: 'l-taco', prospect_name: 'Eddie Claus', project: 'taco truck site' }),
];

function dataset(over: Partial<Dataset> = {}): Dataset {
  return { ...EMPTY_DATASET, leads: PEOPLE, ...over };
}

/* ===================================================== who was meant === */

describe('matching what was typed to a contact', () => {
  it('pins a full name', () => {
    const result = matchContacts('where did we leave off with Chef Jamie?', PEOPLE);
    expect(result.pinned?.id).toBe('l-jamie');
    expect(result.pinned?.reasons).toContain('their full name');
  });

  it('pins on the business where the person has no name on file', () => {
    const result = matchContacts('did DJ 4THE WIN ever reply', PEOPLE);
    expect(result.pinned?.id).toBe('l-dj');
  });

  it('pins on an email address, even the local part alone', () => {
    expect(matchContacts('ariel.santos@example.com said yes', PEOPLE).pinned?.id).toBe('l-ariel');
    expect(matchContacts('emailed ariel.santos about the quote', PEOPLE).pinned?.id).toBe('l-ariel');
  });

  it('pins on a phone number however it was punctuated', () => {
    expect(matchContacts('texted (305) 555-0142 this morning', PEOPLE).pinned?.id).toBe('l-dj');
  });

  it('refuses to pin when two people match about as well', () => {
    const result = matchContacts('following up with Jamie', PEOPLE);
    expect(result.pinned).toBeNull();
    expect(result.candidates.map((c) => c.id).sort()).toEqual(['l-jamie', 'l-jamie-two']);
  });

  it('offers a weak single match as a candidate rather than pinning it', () => {
    // "the chef" overlaps one word of one name. That is a maybe, and a maybe
    // treated as a certainty is how a note lands on the wrong person.
    const result = matchContacts('that chef I met last week', PEOPLE);
    expect(result.pinned).toBeNull();
    expect(result.candidates.map((c) => c.id)).toEqual(['l-jamie']);
  });

  it('ignores the words that match everybody', () => {
    for (const noise of [
      'follow up with the client', 'sent them a message', 'what is due today',
      'the services group',
    ]) {
      expect(matchContacts(noise, PEOPLE).candidates, noise).toEqual([]);
    }
  });

  it('finds somebody by what the work is called', () => {
    const result = matchContacts('any news on the taco truck site?', PEOPLE);
    expect(result.candidates[0]?.id).toBe('l-taco');
  });

  it('matches nobody from an empty message', () => {
    expect(matchContacts('   ', PEOPLE)).toEqual({ pinned: null, candidates: [] });
  });

  it('is not thrown by punctuation or case', () => {
    expect(normalise('  CHEF JAMIE!! (FaKafe) ')).toBe('chef jamie fakafe');
    expect(matchContacts('CHEF JAMIE!!', PEOPLE).pinned?.id).toBe('l-jamie');
  });

  it('needs a real margin before it calls one a certainty', () => {
    const result = matchContacts('Chef Jamie at FaKafe', PEOPLE);
    expect(result.pinned?.score).toBeGreaterThanOrEqual(PIN_SCORE);
  });
});

/* ================================================ which tier pays === */

describe('picking the model tier', () => {
  it('sends a messy paragraph to the stronger tier', () => {
    expect(pickOperation(
      'Met a guy called Eddie at the chamber mixer last night, runs a taco truck, '
      + 'wants a one page site, said his partner handles the money so he will ask her',
    )).toBe('capture');
  });

  it('sends a short question about the record to the cheap tier', () => {
    expect(pickOperation('where did we leave off with Chef Jamie?')).toBe('brief');
    expect(pickOperation('who am I overdue with')).toBe('brief');
    expect(pickOperation('what is due today?')).toBe('brief');
  });

  it('sends anything about wording to the stronger tier, even as a question', () => {
    expect(pickOperation('what should I send Ariel?')).toBe('draft');
    expect(pickOperation('write the follow-up for Jamie')).toBe('draft');
    expect(pickOperation('make it shorter')).toBe('draft');
    expect(pickOperation('can you do that in Spanish')).toBe('draft');
  });

  it('treats a long question as the expensive kind, because it is describing something', () => {
    const long = `Did I ever tell you about ${'the thing that happened '.repeat(20)}?`;
    expect(pickOperation(long)).toBe('capture');
  });

  it('defaults to the stronger tier when it cannot tell', () => {
    expect(pickOperation('Eddie Claus, taco truck, Doral')).toBe('capture');
    expect(pickOperation('')).toBe('capture');
  });
});

/* ====================================================== where you are === */

describe('knowing which screen the question came from', () => {
  it('names each screen', () => {
    expect(screenName('/')).toBe('Today');
    expect(screenName('/pipeline')).toBe('Pipeline');
    expect(screenName('/data')).toBe('Data and Import');
  });

  it('is not confused by a trailing slash or a query string', () => {
    expect(screenName('/pipeline/')).toBe('Pipeline');
    expect(screenName('/pipeline?lead=abc')).toBe('Pipeline');
  });

  it('says plainly that it does not recognise a screen added later', () => {
    expect(screenName('/something-new')).toBe('the Cockpit');
    expect(screenDescription('/something-new')).toBe('somewhere in the Cockpit');
  });

  it('says what somebody on the screen is doing, not just its name', () => {
    expect(screenDescription('/pipeline')).toContain('where each one stands');
  });
});

/* ================================================== what the prompt sees === */

describe('building the context', () => {
  it('pins the contact the words matched and brings their history', () => {
    const data = dataset({
      activityEvents: [
        makeActivity({
          id: 'a-1', lead_id: 'l-jamie', occurred_at: '2026-10-12T12:00:00.000Z',
          activity_type: 'follow_up_sent', title: 'Sent a follow up', channel: 'Instagram',
          approved_message: 'Hola Jamie, following up on the menu photos.',
        }),
        makeActivity({
          id: 'a-2', lead_id: 'l-jamie', occurred_at: '2026-09-30T12:00:00.000Z',
          activity_type: 'conversation', title: 'Talked at the market',
        }),
        makeActivity({ id: 'a-3', lead_id: 'l-ariel', occurred_at: '2026-10-01T12:00:00.000Z' }),
      ],
    });

    const built = buildAssistantContext({
      data, pathname: '/pipeline', today: TODAY, focusLeadId: null,
      message: 'where did we leave off with Chef Jamie?', drafts: [],
    });

    expect(built.focusLeadId).toBe('l-jamie');
    expect(built.context.focus?.label).toBe('Chef Jamie, FaKafe');
    expect(built.context.history.map((h) => h.on)).toEqual(['2026-10-12', '2026-09-30']);
    expect(built.context.history[0].message).toContain('menu photos');
    // Somebody else's history is not in there.
    expect(built.context.history.every((h) => h.title !== 'Something happened')).toBe(true);
  });

  it('lets a pinned contact beat a guess from the words', () => {
    const built = buildAssistantContext({
      data: dataset(), pathname: '/pipeline', today: TODAY, focusLeadId: 'l-ariel',
      message: 'what about Chef Jamie', drafts: [],
    });
    expect(built.context.focus?.id).toBe('l-ariel');
    // And the candidates are not offered, because a choice has been made.
    expect(built.context.candidates).toEqual([]);
  });

  it('offers the candidates when nobody is pinned and the words were ambiguous', () => {
    const built = buildAssistantContext({
      data: dataset(), pathname: '/', today: TODAY, focusLeadId: null,
      message: 'following up with Jamie', drafts: [],
    });
    expect(built.context.focus).toBeNull();
    expect(built.context.candidates.map((c) => c.id).sort()).toEqual(['l-jamie', 'l-jamie-two']);
  });

  it('marks a reversed activity as something that did not happen', () => {
    const data = dataset({
      activityEvents: [
        makeActivity({
          id: 'a-undone', lead_id: 'l-jamie', occurred_at: '2026-10-12T12:00:00.000Z',
          activity_type: 'follow_up_sent', title: 'Sent a follow up',
          approved_message: 'This was never sent.',
          reversed_at: '2026-10-13T09:00:00.000Z',
          reversal_note: 'Undone by the person who recorded it',
        }),
      ],
    });
    const history = historyFor('l-jamie', data.activityEvents);
    expect(history[0].reversed).toBe(true);
    // The wording is withheld rather than quoted as something that was sent.
    expect(history[0].message).toBeNull();
  });

  it('counts what is due and what is overdue from the one follow-up rule', () => {
    const data = dataset({
      leads: [
        makeLead({ id: 'l-late', prospect_name: 'Late Person', next_action_date: '2026-10-01', stage: 'follow_up' }),
        makeLead({ id: 'l-soon', prospect_name: 'Soon Person', next_action_date: '2026-12-01', stage: 'follow_up' }),
      ],
      tasks: [
        makeTask({ id: 't-1', lead_id: 'l-late', task_type: 'follow_up', status: 'open' }),
        makeTask({ id: 't-2', lead_id: 'l-soon', task_type: 'follow_up', status: 'done' }),
      ],
    });

    const built = buildAssistantContext({
      data, pathname: '/', today: TODAY, focusLeadId: null, message: 'what is due', drafts: [],
    });

    expect(built.context.counts).toEqual({ leads: 2, openFollowUps: 1, overdue: 1 });
    expect(built.context.dueNow.map((d) => d.id)).toEqual(['l-late']);
  });

  it('says where a claimed last touch came from rather than presenting it as an event', () => {
    const lead = makeLead({
      id: 'l-claimed', prospect_name: 'Claimed Touch',
      reported_last_touch_at: '2026-10-02',
    });
    const brief = leadBrief(lead, []);
    expect(brief.lastTouchOn).toBe('2026-10-02');
    expect(brief.lastTouchBasis).toBe('reported');
  });

  it('carries the screen it was asked on', () => {
    const built = buildAssistantContext({
      data: dataset(), pathname: '/activity', today: TODAY, focusLeadId: null,
      message: 'anything', drafts: [],
    });
    expect(built.context.screenName).toContain('Activity');
  });

  it('only sends drafts that are still open, never a sent one', () => {
    const built = buildAssistantContext({
      data: dataset(), pathname: '/', today: TODAY, focusLeadId: 'l-jamie',
      message: 'anything',
      drafts: [
        {
          id: 'd-open', lead_id: 'l-jamie', channel: 'Instagram', body: 'Still waiting',
          status: 'draft', copied_at: null, sent_at: null, sent_on: null,
          activity_id: null, created_at: '2026-10-13T00:00:00.000Z',
          updated_at: '2026-10-13T00:00:00.000Z',
        },
        {
          id: 'd-sent', lead_id: 'l-jamie', channel: 'Text', body: 'Already gone',
          status: 'sent', copied_at: null, sent_at: '2026-10-12T00:00:00.000Z',
          sent_on: '2026-10-12', activity_id: 'a-9',
          created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-12T00:00:00.000Z',
        },
      ],
    });
    expect(built.context.drafts.map((d) => d.id)).toEqual(['d-open']);
  });

  it('says when the contact list was cut short', () => {
    const many = Array.from({ length: 140 }, (_, i) =>
      makeLead({ id: `bulk-${i}`, prospect_name: `Invented Person ${i}` }));
    const built = buildAssistantContext({
      data: dataset({ leads: many }), pathname: '/', today: TODAY, focusLeadId: null,
      message: 'who is in here', drafts: [],
    });
    expect(built.context.index.length).toBeLessThan(140);
    expect(built.context.indexTruncated).toBe(true);
  });

  it('puts whoever needs attention soonest at the top of the list', () => {
    const data = dataset({
      leads: [
        makeLead({ id: 'l-closed', prospect_name: 'Closed Person', stage: 'won' }),
        makeLead({ id: 'l-none', prospect_name: 'No Date Person', stage: 'follow_up' }),
        makeLead({ id: 'l-due', prospect_name: 'Due Person', stage: 'follow_up', next_action_date: '2026-10-15' }),
      ],
    });
    const built = buildAssistantContext({
      data, pathname: '/', today: TODAY, focusLeadId: null, message: 'who', drafts: [],
    });
    expect(built.context.index.map((l) => l.id)).toEqual(['l-due', 'l-none', 'l-closed']);
  });
});
