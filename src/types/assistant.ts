/**
 * The rows migration 0016 added. Mirrors supabase/migrations/0016_assistant_foundation.sql.
 *
 * Deliberately not part of Dataset. These are read a contact at a time by the
 * panel that needs them, not loaded with everything else on every screen: a
 * fact belongs to one person and a draft belongs to one message, and neither is
 * something the Pipeline or the Content Log has any use for.
 */

/** Who is making a claim. Nothing in the application may promote one to another. */
export type Provenance = 'contact_stated' | 'user_impression' | 'assistant_inferred';

export type FactKind =
  | 'identity' | 'channel' | 'interest' | 'concern'
  | 'promise' | 'reply' | 'next_step' | 'other';

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  contact_stated: 'They said it',
  user_impression: 'Your impression',
  assistant_inferred: 'Worked out from your words',
};

/** What each one actually means, shown next to the label rather than assumed. */
export const PROVENANCE_NOTES: Record<Provenance, string> = {
  contact_stated: 'The contact said this themselves, so it is evidence.',
  user_impression: 'This is your read on it. It may turn out to be wrong.',
  assistant_inferred: 'A guess drawn from what you wrote. Check it before relying on it.',
};

export const FACT_KIND_LABELS: Record<FactKind, string> = {
  identity: 'Who they are',
  channel: 'How to reach them',
  interest: 'What they want',
  concern: 'What is holding them back',
  promise: 'Something promised',
  reply: 'Something they said back',
  next_step: 'What happens next',
  other: 'Other',
};

export interface ExtractedFact {
  id: string;
  lead_id: string | null;
  kind: FactKind;
  value: string;
  provenance: Provenance;
  source_excerpt: string | null;
  /** Null is the normal case, and is never filled in with today. */
  occurred_on: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  applied_to: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A message that has been written. Written, copied and sent are three states.
 *
 * copied_at and sent_at are separate columns on purpose. Copying a draft is not
 * sending it, and only a person saying so moves one to sent.
 */
export interface MessageDraft {
  id: string;
  lead_id: string;
  channel: string | null;
  body: string;
  status: 'draft' | 'copied' | 'sent' | 'discarded';
  copied_at: string | null;
  sent_at: string | null;
  sent_on: string | null;
  /** The completion this became, once somebody confirmed the send. */
  activity_id: string | null;
  created_at: string;
  updated_at: string;
}

export const DRAFT_STATUS_LABELS: Record<MessageDraft['status'], string> = {
  draft: 'Written, not sent',
  copied: 'Copied, not sent',
  sent: 'Sent',
  discarded: 'Discarded',
};
