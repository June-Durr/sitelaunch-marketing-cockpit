import { useState } from 'react';
import { readSettings, writeSettings } from '../data/settings';
import { today } from '../lib/dates';
import { composeFirstMessage } from './firstMessage';
import { suggestFirstFollowUp } from './followUpSuggestion';

/** Shared review for new and existing people. No writes or extra model calls. */
export function useContactPlan(input: {
  name: string | null; metWhere: string | null; metOn: string | null;
  promise: string | null; statedDate: string | null; suggest?: boolean; repliesRecorded?: number;
}) {
  const [settings, setSettings] = useState(readSettings);
  const [editedBody, setEditedBody] = useState<string | null>(null);
  const [editedDate, setEditedDate] = useState<string | null>(null);
  const suggestion = suggestFirstFollowUp({ statedDate: input.statedDate, promise: input.promise, today: today() });
  const composed = composeFirstMessage({ contactName: input.name, introduction: settings.introduction,
    metWhere: input.metWhere, metOn: input.metOn, promise: input.promise, today: today() });
  return {
    body: editedBody ?? composed.body, setBody: setEditedBody,
    date: editedDate ?? (input.suggest === false ? input.statedDate ?? '' : suggestion.date ?? ''), setDate: setEditedDate,
    dateLabel: editedDate !== null ? 'Next follow-up, your date'
      : suggestion.suggested ? 'Next follow-up, suggested' : 'Next follow-up, from what you said',
    dateHint: editedDate !== null ? 'Your choice. Clearing it means no follow-up.' : suggestion.reason,
    suggested: editedDate === null && suggestion.suggested, gaps: composed.gaps,
    introduction: settings.introduction,
    repliesRecorded: input.repliesRecorded ?? 0,
    setIntroduction(name: string, business: string) {
      const next = { ...settings, introduction: { name: name.trim() || null, business: business.trim() || null } };
      writeSettings(next); setSettings(next);
    },
  };
}


