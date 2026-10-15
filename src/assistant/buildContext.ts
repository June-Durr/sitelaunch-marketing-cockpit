/**
 * The records the assistant is allowed to see for one turn.
 *
 * Assembled here, in the browser, out of the dataset every screen is already
 * showing. Nothing is fetched for this and nothing is computed that the Cockpit
 * does not compute anyway: the last touch comes from src/config/followUp.ts,
 * the label comes from src/lib/leadLabel.ts, and who the words are about comes
 * from src/lib/contactMatch.ts. The assistant answers from the same numbers on
 * the screen, which is the only way its answer and the screen can agree.
 *
 * WHY THERE ARE LIMITS ON EVERYTHING
 *
 * Every row in here is a row somebody pays for. The thin index of contacts is
 * what lets the assistant find a person by name without a retrieval step, and
 * it is also the part that grows without bound, so it is capped and the prompt
 * is told when it was cut short. Beyond a few thousand contacts this stops being
 * the right design; the tool seam in the model adapter is where it goes next.
 */

import { deriveLastTouch, followUpStates, NEEDS_ACTION_STATUSES } from '../config/followUp';
import { matchContacts, type Match, type MatchResult } from '../lib/contactMatch';
import { leadLabel } from '../lib/leadLabel';
import { isReversed, type ActivityEvent, type Dataset, type Lead } from '../types/domain';
import type { MessageDraft } from '../types/assistant';
import { screenDescription } from './screens';
import type { AssistantContext, HistoryBrief, LeadBrief } from './wire';

/** How much of each thing goes in the prompt. */
export const CONTEXT_LIMITS = {
  index: 120,
  history: 16,
  drafts: 4,
  dueNow: 12,
  candidates: 5,
};

/** One contact, thinly, with the last touch worked out by the one rule that does that. */
export function leadBrief(lead: Lead, events: readonly ActivityEvent[]): LeadBrief {
  const touch = deriveLastTouch(lead, events);
  return {
    id: lead.id,
    label: leadLabel(lead),
    organization: lead.organization,
    stage: lead.stage,
    channel: lead.preferred_channel,
    nextAction: lead.next_action,
    nextActionDate: lead.next_action_date,
    followUpMode: lead.follow_up_mode,
    lastTouchOn: touch.effectiveOn,
    lastTouchBasis: touch.basis,
  };
}

/**
 * One contact's history, newest first.
 *
 * Reversed records are kept and marked rather than filtered out. An undone
 * completion is not history, but it is also not nothing: leaving it out
 * silently means the assistant can be asked "did I send that?" and answer as
 * though the record had never existed. Marked, it can say that it was undone.
 */
export function historyFor(leadId: string, events: readonly ActivityEvent[]): HistoryBrief[] {
  return events
    .filter((event) => event.lead_id === leadId)
    .slice()
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, CONTEXT_LIMITS.history)
    .map((event) => ({
      on: event.occurred_at.slice(0, 10),
      type: event.activity_type,
      title: event.title,
      channel: event.channel,
      // The wording that was approved, where there is one. Not shown for a
      // reversed record, because it was not sent.
      message: isReversed(event) ? null : (event.approved_message ?? null),
      outcome: event.outcome ?? null,
      reversed: isReversed(event),
    }));
}

/**
 * The order the thin index goes in.
 *
 * Whoever needs attention soonest first, because that is who a question is most
 * likely about, and because the cap cuts the tail off. Closed records sort last:
 * they are still findable, they are just not what anybody means by "the roofer".
 */
function indexOrder(leads: readonly Lead[]): Lead[] {
  const closed = (lead: Lead) => (lead.stage === 'won' || lead.stage === 'lost' ? 1 : 0);
  return leads.slice().sort((a, b) => {
    const byClosed = closed(a) - closed(b);
    if (byClosed !== 0) return byClosed;
    const aDate = a.next_action_date ?? '9999-12-31';
    const bDate = b.next_action_date ?? '9999-12-31';
    if (aDate !== bDate) return aDate.localeCompare(bDate);
    return leadLabel(a).localeCompare(leadLabel(b));
  });
}

export interface ContextInput {
  data: Dataset;
  /** The route, so the assistant knows which screen the question was asked on. */
  pathname: string;
  today: string;
  /** A contact the person pinned, which always wins over a guess from the words. */
  focusLeadId: string | null;
  /** What they just typed, used for matching and nothing else. */
  message: string;
  /** Open drafts for the pinned contact. Empty when nobody is pinned. */
  drafts: readonly MessageDraft[];
}

export interface BuiltContext {
  context: AssistantContext;
  /** Who the words matched, so the panel can offer the same choice the prompt saw. */
  match: MatchResult;
  /** The contact the turn ended up being about, if one was settled on. */
  focusLeadId: string | null;
}

export function buildAssistantContext(input: ContextInput): BuiltContext {
  const { data, today } = input;
  const match = matchContacts(input.message, data.leads, CONTEXT_LIMITS.candidates);

  // A pin from the screen beats a guess from the words. Somebody who opened a
  // contact and then typed "what about the other one" meant the one they opened.
  const focusLeadId = input.focusLeadId ?? match.pinned?.id ?? null;
  const focusLead = focusLeadId
    ? (data.leads.find((lead) => lead.id === focusLeadId) ?? null)
    : null;

  const states = followUpStates(data.leads, data.activityEvents, today);
  const needing = states.filter((state) => NEEDS_ACTION_STATUSES.includes(state.status));

  const ordered = indexOrder(data.leads);
  const index = ordered
    .slice(0, CONTEXT_LIMITS.index)
    .map((lead) => leadBrief(lead, data.activityEvents));

  const candidates: Match[] = focusLead ? [] : match.candidates;

  return {
    focusLeadId,
    match,
    context: {
      today,
      screenName: screenDescription(input.pathname),
      focus: focusLead ? leadBrief(focusLead, data.activityEvents) : null,
      candidates: candidates
        .map((candidate) => data.leads.find((lead) => lead.id === candidate.id))
        .filter((lead): lead is Lead => lead !== undefined)
        .map((lead) => leadBrief(lead, data.activityEvents)),
      index,
      indexTruncated: data.leads.length > index.length,
      history: focusLeadId ? historyFor(focusLeadId, data.activityEvents) : [],
      drafts: input.drafts
        .filter((draft) => draft.status === 'draft' || draft.status === 'copied')
        .slice(0, CONTEXT_LIMITS.drafts)
        .map((draft) => ({
          id: draft.id,
          channel: draft.channel,
          status: draft.status,
          body: draft.body,
          createdOn: draft.created_at.slice(0, 10),
        })),
      dueNow: needing.slice(0, CONTEXT_LIMITS.dueNow).map((state) => ({
        id: state.lead.id,
        label: leadLabel(state.lead),
        dueDate: state.lead.next_action_date ?? today,
        title: state.lead.next_action ?? 'Follow up',
      })),
      counts: {
        leads: data.leads.length,
        openFollowUps: data.tasks.filter(
          (task) => task.status === 'open' && task.task_type === 'follow_up',
        ).length,
        overdue: needing.length,
      },
    },
  };
}
