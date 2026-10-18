/**
 * The two contact flows, in a real browser, against stubs.
 *
 * WHY THIS EXISTS
 *
 * The vitest suite drives both flows thoroughly, and jsdom has no layout, so it
 * cannot tell us whether the message box fits a phone screen or whether the
 * panel scrolls. This page mounts the same components with a stubbed data
 * context so a real browser can be pointed at them at a real viewport size.
 *
 * WHAT IT CANNOT REACH
 *
 * Anything. askAssistant answers from a constant, every write records itself in
 * window.__qa and returns a canned success, and no model and no database are
 * involved. Nothing here can contact anybody or spend anything.
 *
 * Pick a flow with ?flow=new or ?flow=matched.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { AssistantLauncher, AssistantPanel } from '../src/assistant/AssistantPanel';
import { AssistantProvider } from '../src/assistant/AssistantProvider';
import type { AssistantAnswer, AssistantProposal } from '../src/assistant/wire';
import { DataContext, type DataContextValue } from '../src/data/context';
import { EMPTY_DATASET } from '../src/data/repository';
import type { Dataset, Lead } from '../src/types/domain';
import '../src/styles/app.css';

/* ------------------------------------------------------------- the records --- */

function lead(over: Partial<Lead>): Lead {
  return {
    id: 'zz-lead', content_item_id: null, prospect_name: 'ZZ Test Harness',
    organization: 'ZZ Test Taqueria', email: null, phone: '305 555 0188',
    project: null, source: null, related_campaign: null, stage: 'new_contact',
    next_action: null, next_action_date: null, proposed_value: null,
    closed_value: null, attribution_note: null, notes: null, external_source: null,
    external_key: null, relationship: null, current_status: null,
    preferred_channel: 'Text', record_confidence: null, follow_up_mode: 'auto',
    reported_last_touch_at: null, is_seed: false, first_contact_at: null,
    closed_at: null, created_at: '2026-10-18T12:00:00.000Z',
    updated_at: '2026-10-18T12:00:00.000Z',
    ...over,
  };
}

const MATCHED = lead({ id: 'zz-matched', prospect_name: 'ZZ Matched Person', stage: 'follow_up' });
const CREATED = lead({ id: 'zz-created' });

const data: Dataset = { ...EMPTY_DATASET, leads: [MATCHED, CREATED] };

function proposal(over: Partial<AssistantProposal>): AssistantProposal {
  return {
    intent: 'capture',
    reply: 'Here is what I took from that.',
    question: null,
    leadId: null,
    person: {
      name: 'ZZ Test Harness', organization: 'ZZ Test Taqueria', role: 'Owner',
      channel: 'Text', handle: '305 555 0188', metOn: '2026-10-17',
      location: 'Doral', interest: 'a one page site',
    },
    conversation: {
      occurredOn: '2026-10-17', place: 'the chamber mixer',
      summary: 'Met at the chamber mixer', channel: 'in person', outcome: null,
      nextAction: 'Text him examples', nextDueDate: null,
    },
    draft: { channel: null, body: null, language: null },
    facts: [
      {
        kind: 'interest', value: 'Wants a one page site before the season',
        provenance: 'contact_stated', sourceExcerpt: 'wants a one page site',
        occurredOn: null,
      },
      {
        kind: 'promise', value: 'I said I would text him examples',
        provenance: 'user_stated', sourceExcerpt: null, occurredOn: null,
      },
    ],
    references: [],
    corrections: [],
    ...over,
  };
}

const FLOWS: Record<string, AssistantProposal> = {
  new: proposal({}),
  matched: proposal({ intent: 'record', leadId: 'zz-matched' }),
  /*
   * The shape the reported bug arrived in.
   *
   * A real match often comes back with no place and no next action, and that
   * used to fall straight through the saved card without offering a message,
   * so the next thing somebody did was ask a second time for the message they
   * had already been shown.
   */
  thin: proposal({
    intent: 'record',
    leadId: 'zz-matched',
    conversation: {
      occurredOn: '2026-10-17', place: null, summary: 'Caught up briefly',
      channel: 'phone', outcome: null, nextAction: null, nextDueDate: null,
    },
    facts: [],
  }),
};

/* --------------------------------------------------------------- the stub --- */

interface Recorded {
  capture: unknown[];
  touch: unknown[];
  draft: unknown[];
  copied: string[];
  sent: unknown[];
  updates: unknown[];
  asks: number;
}

const recorded: Recorded = {
  capture: [], touch: [], draft: [], copied: [], sent: [], updates: [], asks: 0,
};
(window as unknown as { __qa: Recorded }).__qa = recorded;

const flow = new URLSearchParams(window.location.search).get('flow') ?? 'new';

const answer: AssistantAnswer = {
  status: 'ok',
  proposal: FLOWS[flow] ?? FLOWS.new,
  model: 'gpt-6.1-sol',
  costMicros: 12_522,
  priced: true,
  error: null,
};

const unused = () => {
  throw new Error('the QA harness does not go there');
};

const value: DataContextValue = {
  data,
  mode: 'supabase',
  loading: false,
  error: null,
  refresh: async () => {},
  insert: unused,
  insertMany: unused,
  update: (async (table: string, id: string, patch: unknown) => {
    recorded.updates.push({ table, id, patch });
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
  loadSyncPending: async () => ({ calendar: false, leadMirror: false }),
  drainSyncJobs: async () => ({ ran: true, succeeded: 1, failed: 0 }),
  askAssistant: async () => {
    recorded.asks += 1;
    return answer;
  },
  captureContact: async (input) => {
    recorded.capture.push(input);
    return {
      ok: true, leadId: 'zz-created', reused: false,
      recordedMeeting: input.metOn !== null, factsWritten: input.facts.length,
      factsSkipped: 0, nextDueDate: input.nextDueDate, error: null,
    };
  },
  recordConversation: async (input) => {
    recorded.touch.push(input);
    return {
      ok: true, activityId: 'zz-activity', reused: false, leadId: input.leadId,
      occurredOn: input.occurredOn, nextDueDate: input.nextDueDate ?? null, error: null,
    };
  },
  saveDraft: async (leadId, channel, body) => {
    recorded.draft.push({ leadId, channel, body });
    return {
      ok: true, draftId: 'zz-draft', status: 'draft', sent: false,
      activityId: null, sentOn: null, error: null,
    };
  },
  markDraftCopied: async (draftId) => {
    recorded.copied.push(draftId);
    return {
      ok: true, draftId, status: 'copied', sent: false, activityId: null,
      sentOn: null, error: null,
    };
  },
  markDraftSent: async (draftId, _token, sentOn) => {
    recorded.sent.push({ draftId, sentOn });
    return {
      ok: true, draftId, status: 'sent', sent: true, activityId: 'zz-sent',
      sentOn, error: null,
    };
  },
  loadDrafts: async () => [],
  loadFacts: async () => [],
  loadAiUsage: async () => ({
    requests: 1, costMicros: 12_522, unknownCost: 0, failures: 0, since: '2026-09-18',
  }),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DataContext.Provider value={value}>
      <MemoryRouter initialEntries={['/pipeline']}>
        <AssistantProvider>
          <AssistantLauncher />
          <AssistantPanel />
        </AssistantProvider>
      </MemoryRouter>
    </DataContext.Provider>
  </StrictMode>,
);
