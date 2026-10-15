/**
 * The assistant panel, driven through a stubbed model.
 *
 * Nothing here asks a real model. What is under test is everything between the
 * answer and the record: that a proposal arrives as an editable form, that
 * saving calls the one operation that writes it, that copying a draft is not
 * recorded as sending it, and that the panel says what actually happened rather
 * than what it hoped would happen.
 *
 * The stub is the honest way to drive this. A test that needed a live key would
 * not run, and a test that mocked the database would prove nothing about the
 * writes. Every person and message below is invented.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { AssistantLauncher, AssistantPanel } from '../assistant/AssistantPanel';
import { AssistantProvider } from '../assistant/AssistantProvider';
import type { AssistantAnswer, AssistantProposal } from '../assistant/wire';
import { DataContext, type DataContextValue } from '../data/context';
import { EMPTY_DATASET, type CaptureOutcome, type DraftOutcome } from '../data/repository';
import type { Dataset } from '../types/domain';
import { makeActivity, makeLead, NO_ASSISTANT } from './fixtures';

/* ------------------------------------------------------------- fixtures -- */

const JAMIE = makeLead({
  id: 'l-jamie', prospect_name: 'Chef Jamie', organization: 'FaKafe',
  stage: 'follow_up', preferred_channel: 'Instagram', next_action_date: '2026-10-20',
});
const JAMIE_TWO = makeLead({
  id: 'l-jamie-two', prospect_name: 'Jamie Olsen', organization: 'Olsen Tile',
});

function dataset(over: Partial<Dataset> = {}): Dataset {
  return {
    ...EMPTY_DATASET,
    leads: [JAMIE, JAMIE_TWO],
    activityEvents: [
      makeActivity({
        id: 'a-1', lead_id: 'l-jamie', occurred_at: '2026-10-12T12:00:00.000Z',
        activity_type: 'follow_up_sent', title: 'Sent a follow up',
      }),
    ],
    ...over,
  };
}

function proposal(over: Partial<AssistantProposal> = {}): AssistantProposal {
  return {
    intent: 'capture',
    reply: 'Here is what I took from that.',
    question: null,
    leadId: null,
    person: {
      name: 'Eddie Claus', organization: 'Invented Tacos', role: 'Owner',
      channel: 'Text', handle: '305 555 0199', metOn: '2026-10-12',
      location: 'Doral', interest: 'a one page site',
    },
    conversation: {
      occurredOn: '2026-10-12', summary: 'Met at the chamber mixer',
      channel: 'in person', outcome: null, nextAction: 'Send examples',
      nextDueDate: null,
    },
    draft: { channel: null, body: null, language: null },
    facts: [
      {
        kind: 'interest', value: 'Wants a one page site before the season',
        provenance: 'contact_stated', sourceExcerpt: 'he needs one page before the season',
        occurredOn: null,
      },
      {
        kind: 'concern', value: 'His partner decides the budget',
        provenance: 'assistant_inferred', sourceExcerpt: 'his partner handles the money',
        occurredOn: null,
      },
    ],
    references: [],
    corrections: [],
    ...over,
  };
}

function answer(over: Partial<AssistantAnswer> = {}): AssistantAnswer {
  return {
    status: 'ok',
    proposal: proposal(),
    model: 'gpt-6.1-sol',
    costMicros: 9000,
    priced: true,
    error: null,
    ...over,
  };
}

interface Calls {
  capture: Parameters<NonNullable<DataContextValue['captureContact']>>[0][];
  touch: Parameters<NonNullable<DataContextValue['recordConversation']>>[0][];
  draft: { leadId: string; channel: string | null; body: string }[];
  copied: string[];
  sent: { draftId: string; sentOn: string; body: string | null | undefined }[];
  updates: { table: string; id: string; patch: Record<string, unknown> }[];
}

function harness(options: {
  reply?: AssistantAnswer;
  data?: Dataset;
  captureOutcome?: Partial<CaptureOutcome>;
  draftOutcome?: Partial<DraftOutcome>;
  drain?: { ran: boolean; succeeded: number; failed: number };
  noAssistant?: boolean;
}) {
  const calls: Calls = {
    capture: [], touch: [], draft: [], copied: [], sent: [], updates: [],
  };

  const unused = () => {
    throw new Error('this test does not go there');
  };

  const value: DataContextValue = {
    data: options.data ?? dataset(),
    mode: 'supabase',
    loading: false,
    error: null,
    refresh: async () => {},
    insert: unused,
    insertMany: unused,
    update: (async (table: string, id: string, patch: Record<string, unknown>) => {
      calls.updates.push({ table, id, patch });
      return {} as never;
    }) as unknown as DataContextValue['update'],
    remove: async () => unused(),
    resetToSeed: null,
    replaceAll: null,
    importDataset: null,
    loadAnalytics: null,
    triggerSync: null,
    loadLeadMirror: null,
    triggerLeadMirror: null,
    loadCalendar: null,
    triggerCalendarSync: null,
    startCalendarOAuth: null,
    disconnectCalendar: null,
    completeTaskDurably: null,
    undoTaskOperation: null,
    skipTaskDurably: null,
    softDeleteTask: null,
    loadRecentlyDeleted: null,
    loadSyncPending: null,
    drainSyncJobs: async () => options.drain ?? { ran: true, succeeded: 2, failed: 0 },
    ...NO_ASSISTANT,
  };

  if (!options.noAssistant) {
    value.askAssistant = vi.fn(async () => options.reply ?? answer());
    value.captureContact = async (input) => {
      calls.capture.push(input);
      return {
        ok: true, leadId: 'l-new', reused: false, recordedMeeting: input.metOn !== null,
        factsWritten: input.facts.length, factsSkipped: 0,
        nextDueDate: input.nextDueDate, error: null,
        ...options.captureOutcome,
      };
    };
    value.recordConversation = async (input) => {
      calls.touch.push(input);
      return {
        ok: true, activityId: 'a-new', reused: false, leadId: input.leadId,
        occurredOn: input.occurredOn, nextDueDate: input.nextDueDate ?? null, error: null,
      };
    };
    value.saveDraft = async (leadId, channel, body) => {
      calls.draft.push({ leadId, channel, body });
      return {
        ok: true, draftId: 'd-new', status: 'draft', sent: false,
        activityId: null, sentOn: null, error: null,
        ...options.draftOutcome,
      };
    };
    value.markDraftCopied = async (draftId) => {
      calls.copied.push(draftId);
      return {
        ok: true, draftId, status: 'copied', sent: false,
        activityId: null, sentOn: null, error: null,
      };
    };
    value.markDraftSent = async (draftId, _token, sentOn, finalBody) => {
      calls.sent.push({ draftId, sentOn, body: finalBody });
      return {
        ok: true, draftId, status: 'sent', sent: true,
        activityId: 'a-sent', sentOn, error: null,
      };
    };
    value.loadDrafts = async () => [];
    value.loadAiUsage = async () => ({
      requests: 3, costMicros: 24_000, unpriced: 0, failures: 0, since: '2026-09-14',
    });
  }

  const view = render(
    <DataContext.Provider value={value}>
      <MemoryRouter initialEntries={['/pipeline']}>
        <AssistantProvider>
          <AssistantLauncher />
          <AssistantPanel />
        </AssistantProvider>
      </MemoryRouter>
    </DataContext.Provider>,
  );

  return { calls, value, view };
}

async function ask(text: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Open the assistant' }));
  fireEvent.change(screen.getByLabelText('What you want to say'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
  await waitFor(() => expect(screen.getByText('Assistant')).toBeTruthy());
}

/* ===================================================== being there at all === */

describe('the launcher', () => {
  it('is not offered when there is no server to answer', () => {
    harness({ noAssistant: true });
    expect(screen.queryByRole('button', { name: 'Open the assistant' })).toBeNull();
  });

  it('opens a panel that says which screen it is looking at', () => {
    harness({});
    fireEvent.click(screen.getByRole('button', { name: 'Open the assistant' }));
    expect(screen.getByText(/Looking at Pipeline/)).toBeTruthy();
  });

  it('says what it is for before anything has been typed', () => {
    harness({});
    fireEvent.click(screen.getByRole('button', { name: 'Open the assistant' }));
    expect(screen.getByText(/Nothing is saved and nothing\s+is sent until you press a button/)).toBeTruthy();
  });
});

/* ================================================ a person in a paragraph === */

describe('describing somebody you met', () => {
  it('turns the paragraph into a form, with each fact wearing where it came from', async () => {
    harness({});
    await ask('Met Eddie at the chamber mixer, runs a taco truck, his partner handles the money');

    await waitFor(() => expect(screen.getByText('A new contact, from what you told me.')).toBeTruthy());

    expect((screen.getByLabelText(/^Name$/) as HTMLInputElement).value).toBe('Eddie Claus');
    expect((screen.getByLabelText('Business') as HTMLInputElement).value).toBe('Invented Tacos');
    expect((screen.getByLabelText('Met on') as HTMLInputElement).value).toBe('2026-10-12');

    // The distinction the whole feature exists to keep.
    expect(screen.getByText('They said it')).toBeTruthy();
    expect(screen.getByText('Worked out from your words')).toBeTruthy();
    expect(screen.getByText(/From your words: his partner handles the money/)).toBeTruthy();
  });

  it('fills the follow-up date from the rule rather than from the model', async () => {
    harness({});
    await ask('Met Eddie at the mixer');
    await waitFor(() => expect(screen.getByLabelText(/^Next follow-up/)).toBeTruthy());
    const field = screen.getByLabelText(/^Next follow-up/) as HTMLInputElement;
    expect(field.value).not.toBe('');
    expect(screen.getByText(/Picked by the follow-up rule for a new contact/)).toBeTruthy();
  });

  it('saves only the facts that were left ticked', async () => {
    const { calls } = harness({});
    await ask('Met Eddie at the mixer');
    await waitFor(() => expect(screen.getByText('Save this contact')).toBeTruthy());

    // Untick the inference, keep the thing he actually said.
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByText('Save this contact'));

    await waitFor(() => expect(calls.capture).toHaveLength(1));
    expect(calls.capture[0].facts).toHaveLength(1);
    expect(calls.capture[0].facts[0].provenance).toBe('contact_stated');
    expect(calls.capture[0].name).toBe('Eddie Claus');
    expect(calls.capture[0].metOn).toBe('2026-10-12');
    // One token per press, and it is not empty.
    expect(calls.capture[0].token.length).toBeGreaterThan(10);
  });

  it('takes the edit over the suggestion', async () => {
    const { calls } = harness({});
    await ask('Met somebody at the mixer');
    await waitFor(() => expect(screen.getByLabelText(/^Name$/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: 'Eddie Clausen' } });
    fireEvent.click(screen.getByText('Save this contact'));

    await waitFor(() => expect(calls.capture).toHaveLength(1));
    expect(calls.capture[0].name).toBe('Eddie Clausen');
  });

  it('shows what was written, where it went, and what the sync is doing', async () => {
    harness({});
    await ask('Met Eddie at the mixer');
    await waitFor(() => expect(screen.getByText('Save this contact')).toBeTruthy());
    fireEvent.click(screen.getByText('Save this contact'));

    await waitFor(() => expect(screen.getByText('Contact saved.')).toBeTruthy());
    // A link to the record itself, not just a claim that it exists.
    const link = screen.getByRole('link', { name: /Open Eddie Claus/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/pipeline?lead=l-new');

    // The honest sequence: queued first, synced only once the worker says so.
    await waitFor(() => expect(screen.getByText('Saved and synced.')).toBeTruthy());
  });

  it('says a sync did not finish rather than claiming it did', async () => {
    harness({ drain: { ran: true, succeeded: 1, failed: 1 } });
    await ask('Met Eddie at the mixer');
    await waitFor(() => expect(screen.getByText('Save this contact')).toBeTruthy());
    fireEvent.click(screen.getByText('Save this contact'));
    await waitFor(() => expect(screen.getByText(/did not; it will retry/)).toBeTruthy());
  });

  it('refuses to save somebody with neither a name nor a business', async () => {
    harness({
      reply: answer({
        proposal: proposal({
          person: {
            name: null, organization: null, role: null, channel: null,
            handle: null, metOn: null, location: null, interest: null,
          },
        }),
      }),
    });
    await ask('Met someone, did not catch anything');
    await waitFor(() => expect(screen.getByText(/A name or a business is enough/)).toBeTruthy());
    expect((screen.getByText('Save this contact') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the meeting was not recorded when the day was not known', async () => {
    harness({});
    await ask('Met Eddie at some point');
    await waitFor(() => expect(screen.getByLabelText('Met on')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Met on'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save this contact'));

    await waitFor(() =>
      expect(screen.getByText(/Not recorded, because the day was not known/)).toBeTruthy());
  });

  it('shows what the server threw away on the way through', async () => {
    harness({
      reply: answer({
        proposal: proposal({
          corrections: ['ignored "next Tuesdayish", which is not a day'],
        }),
      }),
    });
    await ask('Met Eddie, following up next Tuesdayish');
    await waitFor(() =>
      expect(screen.getByText(/I ignored "next Tuesdayish", which is not a day\./)).toBeTruthy());
  });
});

/* ====================================================== correcting a save === */

describe('the saved summary is still editable', () => {
  it('sends a correction through the ordinary update path', async () => {
    const { calls } = harness({});
    await ask('Met Eddie at the mixer');
    await waitFor(() => expect(screen.getByText('Save this contact')).toBeTruthy());
    fireEvent.click(screen.getByText('Save this contact'));
    await waitFor(() => expect(screen.getByText('Contact saved.')).toBeTruthy());

    fireEvent.click(screen.getByText('Something is wrong, let me fix it'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Eddy Claus' } });
    fireEvent.click(screen.getByText('Save the change'));

    await waitFor(() => expect(calls.updates).toHaveLength(1));
    expect(calls.updates[0].table).toBe('leads');
    expect(calls.updates[0].id).toBe('l-new');
    expect(calls.updates[0].patch.prospect_name).toBe('Eddy Claus');
  });
});

/* ============================================= recording what happened === */

describe('recording a contact that already happened', () => {
  const touchReply = answer({
    proposal: proposal({
      intent: 'record',
      leadId: 'l-jamie',
      conversation: {
        occurredOn: '2026-10-12', summary: 'Talked at the market about the menu photos',
        channel: 'in person', outcome: 'She will send the photos', nextAction: 'Chase the photos',
        nextDueDate: null,
      },
      facts: [],
    }),
  });

  it('records it against the right contact and leaves the cadence to the rule', async () => {
    const { calls } = harness({ reply: touchReply });
    await ask('I ran into Chef Jamie at the market on Monday');
    await waitFor(() => expect(screen.getByText('Record this')).toBeTruthy());

    fireEvent.click(screen.getByText('Record this'));
    await waitFor(() => expect(calls.touch).toHaveLength(1));

    expect(calls.touch[0].leadId).toBe('l-jamie');
    expect(calls.touch[0].occurredOn).toBe('2026-10-12');
    // Blank means "use the follow-up rule", which is the normal case.
    expect(calls.touch[0].nextDueDate).toBeNull();
    expect(calls.touch[0].evidence).toBe('User report');

    await waitFor(() => expect(screen.getByText('Contact recorded.')).toBeTruthy());
  });

  it('will not record anything without the day it happened', async () => {
    harness({
      reply: answer({
        proposal: proposal({
          intent: 'record', leadId: 'l-jamie',
          conversation: {
            occurredOn: null, summary: 'Talked at some point', channel: null,
            outcome: null, nextAction: null, nextDueDate: null,
          },
          facts: [],
        }),
      }),
    });
    await ask('I spoke to Chef Jamie recently');
    await waitFor(() => expect(screen.getByText('Record this')).toBeTruthy());
    expect((screen.getByText('Record this') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/A contact with no day is not a record of anything/)).toBeTruthy();
  });

  it('says it cannot record against nobody', async () => {
    harness({
      reply: answer({ proposal: proposal({ intent: 'record', leadId: null, facts: [] }) }),
      data: { ...dataset(), leads: [] },
    });
    await ask('I spoke to somebody on Monday');
    await waitFor(() =>
      expect(screen.getByText(/I am not sure which contact this is about/)).toBeTruthy());
  });
});

/* ============================================= writing is not sending === */

describe('a draft', () => {
  const draftReply = answer({
    proposal: proposal({
      intent: 'draft',
      leadId: 'l-jamie',
      reply: 'Here is one you could send.',
      draft: {
        channel: 'Instagram',
        body: 'Hola Jamie, following up on the menu photos whenever you have a minute.',
        language: 'es',
      },
      facts: [],
    }),
  });

  it('offers the wording as something to look over, not something that was sent', async () => {
    harness({ reply: draftReply });
    await ask('write the follow-up for Chef Jamie');
    await waitFor(() =>
      expect(screen.getByText('A message for you to look over. Nothing is sent from here.')).toBeTruthy());
    expect((screen.getByLabelText('The message') as HTMLTextAreaElement).value)
      .toContain('menu photos');
  });

  it('keeps the revised wording, not the suggested wording', async () => {
    const { calls } = harness({ reply: draftReply });
    await ask('write the follow-up for Chef Jamie');
    await waitFor(() => expect(screen.getByLabelText('The message')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('The message'), {
      target: { value: 'Hola Jamie, un recordatorio sobre las fotos.' },
    });
    fireEvent.click(screen.getByText('Keep this draft'));

    await waitFor(() => expect(calls.draft).toHaveLength(1));
    expect(calls.draft[0].body).toBe('Hola Jamie, un recordatorio sobre las fotos.');
    expect(calls.draft[0].channel).toBe('Instagram');
    await waitFor(() => expect(screen.getByText(/Draft saved. Nothing has been sent./)).toBeTruthy());
  });

  it('records a copy as a copy and nothing more', async () => {
    const { calls } = harness({ reply: draftReply });
    await ask('write the follow-up for Chef Jamie');
    await waitFor(() => expect(screen.getByText('Keep this draft')).toBeTruthy());
    fireEvent.click(screen.getByText('Keep this draft'));
    await waitFor(() => expect(calls.draft).toHaveLength(1));

    fireEvent.click(screen.getByText('Copy, not sent'));

    await waitFor(() => expect(calls.copied).toEqual(['d-new']));
    expect(screen.getByText(/That is not the same as sent, so\s+nothing is in the log yet/)).toBeTruthy();
    // The one thing that must not have happened.
    expect(calls.sent).toEqual([]);
    expect(calls.touch).toEqual([]);
  });

  it('keeps the wording before noting a copy, so there is something to have copied', async () => {
    const { calls } = harness({ reply: draftReply });
    await ask('write the follow-up for Chef Jamie');
    await waitFor(() => expect(screen.getByText('Copy, not sent')).toBeTruthy());

    // Straight to Copy, without pressing Keep this draft first.
    fireEvent.click(screen.getByText('Copy, not sent'));

    await waitFor(() => expect(calls.copied).toEqual(['d-new']));
    expect(calls.draft).toHaveLength(1);
    // Still not a send, which is the whole point of the two being separate.
    expect(calls.sent).toEqual([]);
  });

  it('records a send only when the person says they sent it', async () => {
    const { calls } = harness({ reply: draftReply });
    await ask('write the follow-up for Chef Jamie');
    await waitFor(() => expect(screen.getByText('I sent this')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('The day you sent it'), {
      target: { value: '2026-10-13' },
    });
    fireEvent.click(screen.getByText('I sent this'));

    await waitFor(() => expect(calls.sent).toHaveLength(1));
    expect(calls.sent[0].sentOn).toBe('2026-10-13');
    expect(calls.sent[0].body).toContain('menu photos');
    // The wording was saved first, so the record carries what was sent.
    expect(calls.draft).toHaveLength(1);

    await waitFor(() => expect(screen.getByText('Recorded as sent.')).toBeTruthy());
    expect(screen.getByRole('link', { name: /See it in the activity log/ })).toBeTruthy();
  });

  it('will not save a message against nobody', async () => {
    harness({
      reply: answer({
        proposal: proposal({
          intent: 'draft', leadId: null, facts: [],
          draft: { channel: 'Text', body: 'Hello there', language: 'en' },
        }),
      }),
      data: { ...dataset(), leads: [] },
    });
    await ask('write a follow-up');
    await waitFor(() =>
      expect(screen.getByText(/I will not save a message\s+against nobody/)).toBeTruthy());
    expect(screen.queryByText('I sent this')).toBeNull();
  });
});

/* =================================================== asking a question === */

describe('asking where things stand', () => {
  it('answers with links to the records it named', async () => {
    harness({
      reply: answer({
        proposal: proposal({
          intent: 'answer',
          reply: 'You sent Chef Jamie a follow up on the twelfth and she has not replied.',
          leadId: 'l-jamie',
          references: ['l-jamie'],
          facts: [],
        }),
      }),
    });
    await ask('where did we leave off with Chef Jamie?');

    await waitFor(() => expect(screen.getByText(/has not replied/)).toBeTruthy());
    const link = screen.getByRole('link', { name: /Open Chef Jamie, FaKafe/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/pipeline?lead=l-jamie');
    // An answer writes nothing, so there is nothing to save.
    expect(screen.queryByText('Save this contact')).toBeNull();
  });

  it('asks one question rather than guessing between two people', async () => {
    harness({
      reply: answer({
        proposal: proposal({
          intent: 'clarify',
          reply: 'There are two people called Jamie here.',
          question: 'Did you mean Chef Jamie at FaKafe, or Jamie Olsen at Olsen Tile?',
          leadId: null,
          facts: [],
        }),
      }),
    });
    await ask('following up with Jamie');

    await waitFor(() => expect(screen.getByText(/Did you mean Chef Jamie/)).toBeTruthy());
    expect(screen.getByText('Which one?')).toBeTruthy();
    fireEvent.click(screen.getByText('Chef Jamie, FaKafe'));
    // Pinned, which the header says and the unpin button proves.
    await waitFor(() => expect(screen.getByText('Not about them')).toBeTruthy());
    expect(screen.getByText('Chef Jamie, FaKafe')).toBeTruthy();
  });
});

/* ========================================================= being honest === */

describe('when it cannot work', () => {
  it('says the key is missing rather than looking broken', async () => {
    harness({
      reply: {
        status: 'no_model_key',
        proposal: null,
        model: null,
        costMicros: null,
        priced: false,
        error: 'The assistant has no model key yet. Set OPENAI_API_KEY as a function secret.',
      },
    });
    await ask('anything at all');
    await waitFor(() => expect(screen.getByText(/no model key yet/)).toBeTruthy());
  });

  it('shows a failed turn as a failure, with nothing proposed', async () => {
    harness({
      reply: {
        status: 'failed', proposal: null, model: 'gpt-6.1-sol',
        costMicros: null, priced: false, error: '429: rate limited',
      },
    });
    await ask('anything at all');
    await waitFor(() => expect(screen.getByText('429: rate limited')).toBeTruthy());
    expect(screen.queryByText('Save this contact')).toBeNull();
  });

  it('reports what it has spent, and does not call a failure free', async () => {
    harness({});
    fireEvent.click(screen.getByRole('button', { name: 'Open the assistant' }));
    await waitFor(() => expect(screen.getByText(/3 requests in the last 30/)).toBeTruthy());
    expect(screen.getByText(/\$0\.02/)).toBeTruthy();
  });
});
