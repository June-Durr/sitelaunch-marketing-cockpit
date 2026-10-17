/**
 * What the browser sends the assistant function, and what comes back.
 *
 * Hand written rather than imported. The server keeps its own copy of this
 * contract, and src is not allowed to reach across that boundary: anything it
 * imported from the server layer would be bundled into the browser, and the
 * boundary would exist only in the comments. So there are two declarations of
 * one shape, exactly as there are for the lead name rules in
 * src/lib/leadLabel.ts, and a test asserts they still agree.
 *
 * The server path is not written out here on purpose. The test that enforces
 * the boundary matches on the literal text, so naming it would fail the build.
 * The test that keeps the two copies honest lives beside the server's reply
 * validator and checks a real validated proposal against PROPOSAL_FIELDS below.
 */

/** One contact, as the prompt sees them. */
export interface LeadBrief {
  id: string;
  label: string;
  organization: string | null;
  stage: string;
  channel: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  followUpMode: string;
  lastTouchOn: string | null;
  lastTouchBasis: string;
}

export interface HistoryBrief {
  on: string;
  type: string;
  title: string;
  channel: string | null;
  message: string | null;
  outcome: string | null;
  reversed: boolean;
}

export interface DraftBrief {
  id: string;
  channel: string | null;
  status: string;
  body: string;
  createdOn: string;
}

export interface AssistantContext {
  today: string;
  screenName: string;
  focus: LeadBrief | null;
  candidates: LeadBrief[];
  index: LeadBrief[];
  indexTruncated: boolean;
  history: HistoryBrief[];
  drafts: DraftBrief[];
  dueNow: { id: string; label: string; dueDate: string; title: string }[];
  counts: { leads: number; openFollowUps: number; overdue: number };
}

/**
 * Which model tier pays for this turn.
 *
 * Chosen in the browser from the shape of what was typed, and it decides the
 * model and nothing else: the assistant's behaviour comes from the one schema
 * either way. A wrong guess here costs a fraction of a cent or spends a cent it
 * did not need to, and changes no record. See src/assistant/route.ts.
 */
export type AssistantOperation = 'capture' | 'brief' | 'draft';

export type AssistantIntent = 'capture' | 'record' | 'draft' | 'answer' | 'clarify';

export interface ProposedFact {
  kind:
    | 'identity' | 'channel' | 'interest' | 'concern'
    | 'promise' | 'reply' | 'next_step' | 'other';
  value: string;
  /**
   * Who is making the claim. Nothing in the app may promote one to another.
   *
   * user_stated and user_impression are both the person speaking, and they are
   * not the same claim: the first is what they say happened, the second is what
   * they believe about the contact. See migration 0020.
   */
  provenance: 'contact_stated' | 'user_stated' | 'user_impression' | 'assistant_inferred';
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
  summary: string | null;
  channel: string | null;
  outcome: string | null;
  nextAction: string | null;
  /** Null means "use the Cockpit's own cadence rule", which is the normal case. */
  nextDueDate: string | null;
}

export interface ProposedDraft {
  channel: string | null;
  body: string | null;
  language: string | null;
}

export interface AssistantProposal {
  intent: AssistantIntent;
  reply: string;
  question: string | null;
  leadId: string | null;
  person: ProposedPerson;
  conversation: ProposedConversation;
  draft: ProposedDraft;
  facts: ProposedFact[];
  references: string[];
  /** What the server threw away on the way through, in words. */
  corrections: string[];
}

/** The validated proposal's top level fields. Asserted against the server's output. */
export const PROPOSAL_FIELDS = [
  'intent', 'reply', 'question', 'leadId', 'person', 'conversation', 'draft',
  'facts', 'references', 'corrections',
] as const;

/**
 * What came back from one turn.
 *
 * 'no_model_key' and 'no_credit' are configuration answers rather than
 * failures, and the panel says so in those words: the feature is built and
 * waiting on a secret, or on a balance. Neither is something a retry fixes, so
 * neither is dressed up as a turn that went wrong.
 */
export interface AssistantAnswer {
  status:
    | 'ok' | 'refused' | 'failed' | 'no_model_key' | 'no_credit' | 'not_signed_in'
    | 'not_configured' | 'bad_request' | 'unreachable' | 'unavailable'
    /* The server refused to spend. None of these three reached the provider. */
    | 'daily_cap' | 'rate_limited' | 'duplicate';
  proposal: AssistantProposal | null;
  model: string | null;
  /** Millionths of a dollar for this one turn. Zero when the model has no price. */
  costMicros: number | null;
  priced: boolean;
  /** Already sanitized server side. Safe to display. */
  error: string | null;
}

export interface AssistantRequest {
  operation: AssistantOperation;
  message: string;
  turns: { role: 'user' | 'assistant'; content: string }[];
  context: AssistantContext;
  /**
   * One value per press of Ask.
   *
   * The server holds a unique index on it, so a double press or a retried
   * request is recognised and refused rather than asked and charged twice.
   * Generated at the press, for the same reason the completion token is.
   */
  requestToken: string;
}

/**
 * What the Cockpit has spent on the assistant. Read from ai_usage by its owner.
 *
 * costMicros adds up the requests whose cost is known. unknownCost counts the
 * ones where it is not, which is what makes the total a floor rather than a
 * total: a request that failed on the way back was billed and reported nothing.
 */
export interface AiUsageSummary {
  requests: number;
  costMicros: number;
  /** Requests with no cost on file, so the total above is a floor. */
  unknownCost: number;
  failures: number;
  since: string;
}
