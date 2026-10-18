/**
 * The assistant's own state, shared by the launcher, the panel and the screens.
 *
 * Separate from DataContext on purpose. The dataset is what the Cockpit knows;
 * this is one conversation, which contact it is about, and what each answer
 * turned into. A screen that wants the assistant to be about the person it has
 * open calls pin() and nothing else changes.
 */

import { createContext, useContext } from 'react';

import type { AiUsageSummary, AssistantProposal } from './wire';

/** One contact the panel can offer as a choice, when the words matched several. */
export interface Candidate {
  id: string;
  label: string;
  /** Which parts of their record the words touched, in plain language. */
  reasons: string[];
}

/** What a save actually wrote, read back from the answers the database gave. */
export interface SavedRecord {
  kind: 'contact' | 'touch' | 'draft' | 'sent';
  leadId: string | null;
  label: string;
  /** The activity a touch or a confirmed send produced. */
  activityId: string | null;
  draftId: string | null;
  /** The day the touch is recorded against. */
  occurredOn: string | null;
  /**
   * What was promised and where you met, as saved.
   *
   * Carried on the record rather than read back off the proposal, because the
   * person may have edited both before saving and the first message has to say
   * what was actually saved.
   */
  promise: string | null;
  place: string | null;
  nextDueDate: string | null;
  factsWritten: number;
  /** Facts left out because they would have been dishonest. Shown, not hidden. */
  factsSkipped: number;
  /** True when this exact press had already been saved, so nothing new happened. */
  reused: boolean;
  /**
   * Where the queued syncs got to.
   *
   * 'queued' is the honest state immediately after a save: the work is
   * committed and the calendar is not updated yet. Nothing claims 'synced'
   * until the worker says so.
   */
  sync: 'none' | 'queued' | 'synced' | 'partial';
  /** Wording edited in the initial review; never requires a second Ask. */
  firstMessage?: string;
}

export type Turn =
  | { kind: 'you'; id: number; text: string }
  | {
      kind: 'assistant';
      id: number;
      /** What it said. Present even when there is no proposal. */
      text: string;
      proposal: AssistantProposal | null;
      /** Contacts it could have meant, for the person to choose between. */
      candidates: Candidate[];
      /** The contact this turn was about, as the Cockpit settled it. */
      leadId: string | null;
      model: string | null;
      costMicros: number | null;
      priced: boolean;
      /** Set when the turn failed or was refused. Safe to show. */
      error: string | null;
      /** What came of pressing a button on this turn. */
      saved: SavedRecord | null;
      /** A problem that happened while saving, kept beside the card that caused it. */
      saveError: string | null;
    };

export interface AssistantValue {
  /**
   * False in browser-local mode, where there is no server to hold a model key.
   *
   * The launcher is not rendered at all in that case. An input box that cannot
   * answer is worse than no input box.
   */
  available: boolean;
  open: boolean;
  setOpen(open: boolean): void;

  /** The contact the conversation is about, when one has been settled on. */
  focusLeadId: string | null;
  /** Its label, worked out by the one function that labels contacts. */
  focusLabel: string | null;
  /** Point the assistant at a contact, or let it work it out again. */
  pin(leadId: string | null): void;

  turns: Turn[];
  busy: boolean;
  /** Set when the feature is built and waiting on configuration. */
  notice: string | null;
  ask(message: string): Promise<void>;
  clear(): void;

  /* The four writes. Each one is a button somebody presses. */
  saveContact(turnId: number, edited: ContactEdit): Promise<void>;
  saveTouch(turnId: number, edited: TouchEdit): Promise<void>;
  saveDraft(turnId: number, edited: DraftEdit): Promise<void>;
  copyDraft(turnId: number, body: string): Promise<void>;
  confirmSent(turnId: number, sentOn: string, body: string): Promise<void>;
  /** Correct a record that was just saved, through the ordinary update path. */
  reviseSaved(turnId: number, patch: RevisionPatch): Promise<void>;

  usage: AiUsageSummary | null;
}

/** The capture card's fields, as the person left them. */
export interface ContactEdit {
  firstMessage?: string;
  /**
   * True when a date was offered and the person emptied it.
   *
   * Blank means two different things and they need opposite handling. A field
   * nobody filled means "use the usual rhythm", which the database function
   * already does with a null. A suggestion somebody deliberately cleared means
   * "no follow-up", which takes an explicit write.
   */
  clearedSuggestion?: boolean;
  name: string;
  organization: string;
  channel: string;
  handle: string;
  metOn: string;
  interest: string;
  nextAction: string;
  nextDueDate: string;
  /** Facts the person left ticked. Unticked ones are simply not written. */
  keepFacts: boolean[];
}

export interface TouchEdit {
  firstMessage?: string;
  /** See ContactEdit. Blank and cleared are not the same instruction. */
  clearedSuggestion?: boolean;
  handle?: string;
  contactChannel?: string;
  leadId: string;
  occurredOn: string;
  summary: string;
  channel: string;
  outcome: string;
  nextAction: string;
  nextDueDate: string;
}

export interface DraftEdit {
  leadId: string;
  channel: string;
  body: string;
}

/** What an edit to an already saved record may change. */
export interface RevisionPatch {
  name?: string;
  organization?: string;
  channel?: string;
  nextAction?: string;
  nextDueDate?: string | null;
  summary?: string;
  outcome?: string;
}

export const AssistantContext = createContext<AssistantValue | null>(null);

export function useAssistant(): AssistantValue {
  const value = useContext(AssistantContext);
  if (!value) throw new Error('AssistantProvider is missing');
  return value;
}

/** Null when there is no provider, for screens that work with or without one. */
export function useAssistantIfPresent(): AssistantValue | null {
  return useContext(AssistantContext);
}

/** Money, as a person reads it. Micros are millionths of a dollar. */
export function formatCost(micros: number): string {
  if (micros <= 0) return '$0.00';
  const dollars = micros / 1_000_000;
  // Below a cent, saying "$0.00" reads as free. It is not free, it is small.
  if (dollars < 0.01) return 'under a cent';
  return `$${dollars.toFixed(2)}`;
}
