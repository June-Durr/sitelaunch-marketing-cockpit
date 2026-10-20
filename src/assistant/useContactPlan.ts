/**
 * One review for a new person and for a matched one.
 *
 * The message, the date and the gaps, worked out from what the assistant
 * proposed and what the Cockpit already knows. No writes, no model request:
 * everything here is composed from values that are already in memory, which is
 * why the whole plan can appear from one Ask.
 *
 * The identity comes from useIdentity rather than a one-time read, so somebody
 * who fills in their profile while this card is on screen sees the message pick
 * the line up. Anything they have typed into the message themselves wins over
 * that: an edit is the person's wording and the composer does not get to
 * overrule it.
 */

import { useState } from 'react';

import { useIdentity } from '../data/useIdentity';
import { today } from '../lib/dates';
import { composeFirstMessage } from './firstMessage';
import { suggestFirstFollowUp } from './followUpSuggestion';

export interface ContactPlanInput {
  name: string | null;
  metWhere: string | null;
  metOn: string | null;
  promise: string | null;
  statedDate: string | null;
  /** False where nothing is owed, so no date is suggested at all. */
  suggest?: boolean;
  repliesRecorded?: number;
}

export function useContactPlan(input: ContactPlanInput) {
  const introduction = useIdentity();
  const [editedBody, setEditedBody] = useState<string | null>(null);
  const [editedDate, setEditedDate] = useState<string | null>(null);

  const suggestion = suggestFirstFollowUp({
    statedDate: input.statedDate,
    promise: input.promise,
    today: today(),
  });

  const composed = composeFirstMessage({
    contactName: input.name,
    introduction,
    metWhere: input.metWhere,
    metOn: input.metOn,
    promise: input.promise,
    today: today(),
  });

  const date = editedDate
    ?? (input.suggest === false ? input.statedDate ?? '' : suggestion.date ?? '');

  return {
    body: editedBody ?? composed.body,
    setBody: setEditedBody,
    /** True once somebody has typed their own wording, which then wins. */
    edited: editedBody !== null,
    date,
    setDate: setEditedDate,
    dateLabel: editedDate !== null
      ? 'Next follow-up, your date'
      : suggestion.suggested
        ? 'Next follow-up, suggested'
        : 'Next follow-up, from what you said',
    dateHint: editedDate !== null
      ? 'Your choice. Clearing it means no follow-up.'
      : suggestion.reason,
    suggested: editedDate === null && suggestion.suggested,
    gaps: composed.gaps,
    introduction,
    repliesRecorded: input.repliesRecorded ?? 0,
  };
}
