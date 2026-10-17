/**
 * One conversation, and the writes it can turn into.
 *
 * WHAT THIS DOES NOT DO
 *
 * Decide anything. Every write below happens because somebody pressed a button,
 * and each one goes through the same database function the rest of the app uses,
 * under row level security, with the same idempotency token, the same Undo and
 * the same sync queue. There is no path from an answer to a record that does not
 * pass through a person.
 *
 * WHY THE TOKEN IS MADE AT THE PRESS
 *
 * Same reason as src/data/taskActions.tsx: a token identifies one press of one
 * button, so a double click or a retried request writes one record instead of
 * two. Generating it any earlier would make every press of Save a repeat of the
 * first; any later and a retry would be a new press.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';

import { useData } from '../data/context';
import { today } from '../lib/dates';
import { leadLabel } from '../lib/leadLabel';
import type { MessageDraft } from '../types/assistant';
import { buildAssistantContext } from './buildContext';
import { pickOperation } from './route';
import { pressToken } from './pressToken';
import {
  AssistantContext, type AssistantValue, type Candidate, type ContactEdit,
  type DraftEdit, type RevisionPatch, type SavedRecord, type TouchEdit, type Turn,
} from './context';
import type { AiUsageSummary, AssistantAnswer, ProposedFact } from './wire';

/** How many earlier turns travel with the next question. */
const TURNS_SENT = 8;

/**
 * A turn before it has an id.
 *
 * Written out as a union of the two shapes rather than as Omit<Turn, 'id'>,
 * because Omit over a union keeps only the keys both members share, which here
 * means losing every field that makes an assistant turn an assistant turn.
 */
type NewTurn =
  | Omit<Extract<Turn, { kind: 'you' }>, 'id'>
  | Omit<Extract<Turn, { kind: 'assistant' }>, 'id'>;

/** One array, so the derived empty case is the same object every render. */
const EMPTY_DRAFTS: MessageDraft[] = [];



export function AssistantProvider({ children }: { children: ReactNode }) {
  const ctx = useData();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [focusLeadId, setFocusLeadId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [loaded, setLoaded] = useState<{ leadId: string | null; rows: MessageDraft[] }>({
    leadId: null, rows: [],
  });
  const nextId = useRef(0);

  /*
   * The repository's assistant half, taken out once.
   *
   * Named individually rather than used through ctx, so each callback below
   * depends on the functions it really uses. Depending on the whole context
   * would rebuild every callback whenever any row in the dataset changed.
   */
  const {
    askAssistant, loadDrafts, loadAiUsage, captureContact, recordConversation,
    markDraftCopied, markDraftSent, drainSyncJobs, update,
  } = ctx;
  const repoSaveDraft = ctx.saveDraft;
  const dataset = ctx.data;
  const leads = dataset.leads;
  const available = askAssistant !== null;

  const focusLabel = useMemo(() => {
    if (!focusLeadId) return null;
    const lead = leads.find((candidate) => candidate.id === focusLeadId);
    return lead ? leadLabel(lead) : null;
  }, [focusLeadId, leads]);

  /**
   * The pinned contact's drafts.
   *
   * Loaded when the contact changes rather than with the dataset, because a
   * draft belongs to one conversation and no screen outside this panel shows
   * one. They go in the prompt so the assistant can ask about the draft that
   * exists instead of writing a third one.
   */
  useEffect(() => {
    if (!focusLeadId || !loadDrafts) return;
    let live = true;
    void loadDrafts(focusLeadId).then((rows) => {
      if (live) setLoaded({ leadId: focusLeadId, rows });
    });
    return () => {
      live = false;
    };
  }, [focusLeadId, loadDrafts]);

  /*
   * Which drafts count right now, derived rather than cleared.
   *
   * The loaded set carries the contact it belongs to, so switching contact
   * makes the old set stop counting without an effect having to empty it
   * first. That also removes the window where the panel would show the
   * previous person's draft while the new one was still loading.
   */
  const drafts = loaded.leadId === focusLeadId ? loaded.rows : EMPTY_DRAFTS;

  const refreshUsage = useCallback(() => {
    if (!loadAiUsage) return;
    void loadAiUsage().then(setUsage);
  }, [loadAiUsage]);

  useEffect(() => {
    if (!open) return;
    // oxlint-disable-next-line react/set-state-in-effect
    refreshUsage();
  }, [open, refreshUsage]);

  const addTurn = useCallback((turn: NewTurn): number => {
    nextId.current += 1;
    const id = nextId.current;
    setTurns((previous) => [...previous, { ...turn, id } as Turn]);
    return id;
  }, []);

  const patchTurn = useCallback((id: number, patch: Partial<Extract<Turn, { kind: 'assistant' }>>) => {
    setTurns((previous) =>
      previous.map((turn) => (turn.id === id && turn.kind === 'assistant' ? { ...turn, ...patch } : turn)),
    );
  }, []);

  /**
   * Ask the worker to run the queue, and report what really happened.
   *
   * Not awaited by the save. The save is committed and the queue is durable, so
   * a slow drain must not hold up the confirmation, and a failed one must not
   * turn a successful save into a visible failure. What it changes is one line:
   * "syncing" becomes "synced" only when the worker says so.
   */
  const drainFor = useCallback(
    (turnId: number) => {
      const drain = drainSyncJobs;
      if (!drain) return;
      void drain().then((result) => {
        if (!result.ran) return;
        setTurns((previous) =>
          previous.map((turn) => {
            if (turn.id !== turnId || turn.kind !== 'assistant' || !turn.saved) return turn;
            const sync = result.succeeded === 0
              ? 'queued'
              : result.failed > 0
                ? 'partial'
                : 'synced';
            return { ...turn, saved: { ...turn.saved, sync } };
          }),
        );
      });
    },
    [drainSyncJobs],
  );

  /* ------------------------------------------------------------- asking --- */

  const ask = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (text === '' || busy || !askAssistant) return;

      addTurn({ kind: 'you', text });
      setBusy(true);

      try {
        const built = buildAssistantContext({
          data: dataset,
          pathname: location.pathname,
          today: today(),
          focusLeadId,
          message: text,
          drafts,
        });

        /*
         * The conversation so far, trimmed, with the drafts in it.
         *
         * An assistant turn used to travel as its reply line alone, which meant
         * a model asked to shorten a message had never seen the message. It had
         * to write a new one from the history and then had nothing to be shorter
         * than. Sending the wording it proposed is what makes "make it shorter"
         * a revision rather than a second attempt.
         */
        const history = turns
          .slice(-TURNS_SENT)
          .map((turn) => ({
            role: turn.kind === 'you' ? ('user' as const) : ('assistant' as const),
            content: turn.kind === 'you'
              ? turn.text
              : [
                  turn.text,
                  turn.proposal?.draft.body
                    ? `The message I wrote, ${turn.proposal.draft.body.length} characters:`
                      + `\n${turn.proposal.draft.body}`
                    : null,
                ].filter((part): part is string => Boolean(part)).join('\n'),
          }))
          .filter((turn) => turn.content.trim() !== '');

        const answer = await askAssistant({
          operation: pickOperation(text),
          message: text,
          turns: history,
          context: built.context,
          // One per press. A retry of this same press is refused by the server
          // rather than asked again.
          requestToken: pressToken('ask'),
        });

        const candidates: Candidate[] = built.context.focus
          ? []
          : built.match.candidates.map((match) => ({
              id: match.id,
              label: match.label,
              reasons: match.reasons,
            }));

        /*
         * A missing key or an empty balance is configuration, not a failure of
         * the question.
         *
         * The banner carries the server's full sentence, including what to do
         * about it, because that is a standing state. The turn gets one short
         * line, so the same paragraph is not printed twice on screen.
         */
        const STANDING: AssistantAnswer['status'][] = [
          'no_model_key', 'no_credit', 'daily_cap', 'rate_limited',
        ];
        if (STANDING.includes(answer.status)) setNotice(answer.error);

        const SHORT: Partial<Record<AssistantAnswer['status'], string>> = {
          no_model_key: 'There is no model key set yet, so I cannot answer.',
          no_credit: 'The model account is out of credits, so I cannot answer.',
          daily_cap: 'That would go over the spending limit, so I did not ask.',
          rate_limited: 'Too many requests in the last minute, so I did not ask.',
          duplicate: 'You had already asked that, so it was not charged again.',
        };
        const shortError = SHORT[answer.status] ?? answer.error ?? answer.status;

        const settled = answer.proposal?.leadId ?? built.focusLeadId;
        if (settled && settled !== focusLeadId) setFocusLeadId(settled);

        addTurn({
          kind: 'assistant',
          text: answer.proposal?.reply ?? shortError,
          proposal: answer.proposal,
          candidates,
          leadId: settled,
          model: answer.model,
          costMicros: answer.costMicros,
          priced: answer.priced,
          error: answer.status === 'ok' ? null : shortError,
          saved: null,
          saveError: null,
        });

        refreshUsage();
      } catch (error) {
        addTurn({
          kind: 'assistant',
          text: 'That did not get through.',
          proposal: null,
          candidates: [],
          leadId: null,
          model: null,
          costMicros: null,
          priced: false,
          error: error instanceof Error ? error.message : String(error),
          saved: null,
          saveError: null,
        });
      } finally {
        setBusy(false);
      }
    },
    [
      addTurn, askAssistant, busy, dataset, drafts, focusLeadId,
      location.pathname, refreshUsage, turns,
    ],
  );

  /* -------------------------------------------------------------- saving --- */

  const saveContact = useCallback(
    async (turnId: number, edited: ContactEdit) => {
      const capture = captureContact;
      if (!capture) return;
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.kind !== 'assistant' || !turn.proposal) return;

      setBusy(true);
      try {
        const facts: ProposedFact[] = turn.proposal.facts.filter(
          (_fact, index) => edited.keepFacts[index] !== false,
        );

        const outcome = await capture({
          token: pressToken(`capture-${turnId}`),
          name: edited.name.trim() === '' ? null : edited.name.trim(),
          organization: edited.organization.trim() === '' ? null : edited.organization.trim(),
          role: turn.proposal.person.role,
          channel: edited.channel.trim() === '' ? null : edited.channel.trim(),
          handle: edited.handle.trim() === '' ? null : edited.handle.trim(),
          metOn: edited.metOn === '' ? null : edited.metOn,
          location: turn.proposal.person.location,
          interest: edited.interest.trim() === '' ? null : edited.interest.trim(),
          summary: turn.proposal.conversation.summary,
          nextAction: edited.nextAction.trim() === '' ? null : edited.nextAction.trim(),
          nextDueDate: edited.nextDueDate === '' ? null : edited.nextDueDate,
          facts,
        });

        if (!outcome.ok) {
          patchTurn(turnId, { saveError: outcome.error ?? 'That did not save.' });
          return;
        }

        if (outcome.leadId) setFocusLeadId(outcome.leadId);
        const saved: SavedRecord = {
          kind: 'contact',
          leadId: outcome.leadId,
          label: edited.name.trim() || edited.organization.trim() || 'the contact',
          activityId: null,
          draftId: null,
          occurredOn: outcome.recordedMeeting ? edited.metOn : null,
          // As edited, not as proposed. The first message has to say what was
          // actually saved.
          promise: edited.nextAction.trim() === '' ? null : edited.nextAction.trim(),
          place: turn.proposal.conversation.place,
          nextDueDate: outcome.nextDueDate,
          factsWritten: outcome.factsWritten,
          factsSkipped: outcome.factsSkipped,
          reused: outcome.reused,
          sync: 'queued',
        };
        patchTurn(turnId, { saved, saveError: null });
        drainFor(turnId);
      } finally {
        setBusy(false);
      }
    },
    [captureContact, drainFor, patchTurn, turns],
  );

  const saveTouch = useCallback(
    async (turnId: number, edited: TouchEdit) => {
      const record = recordConversation;
      if (!record) return;

      setBusy(true);
      try {
        const outcome = await record({
          leadId: edited.leadId,
          token: pressToken(`touch-${turnId}`),
          occurredOn: edited.occurredOn,
          summary: edited.summary,
          channel: edited.channel.trim() === '' ? null : edited.channel.trim(),
          activityType: 'conversation',
          outcome: edited.outcome.trim() === '' ? null : edited.outcome.trim(),
          nextDueDate: edited.nextDueDate === '' ? null : edited.nextDueDate,
          nextAction: edited.nextAction.trim() === '' ? null : edited.nextAction.trim(),
          evidence: 'User report',
        });

        if (!outcome.ok) {
          patchTurn(turnId, { saveError: outcome.error ?? 'That did not save.' });
          return;
        }

        const lead = leads.find((candidate) => candidate.id === edited.leadId);
        patchTurn(turnId, {
          saved: {
            kind: 'touch',
            leadId: edited.leadId,
            label: lead ? leadLabel(lead) : 'the contact',
            activityId: outcome.activityId,
            draftId: null,
            occurredOn: outcome.occurredOn,
            promise: edited.nextAction.trim() === '' ? null : edited.nextAction.trim(),
            place: null,
            nextDueDate: outcome.nextDueDate,
            factsWritten: 0,
            factsSkipped: 0,
            reused: outcome.reused,
            sync: 'queued',
          },
          saveError: null,
        });
        drainFor(turnId);
      } finally {
        setBusy(false);
      }
    },
    [drainFor, leads, patchTurn, recordConversation],
  );

  const refreshDrafts = useCallback(
    (leadId: string) => {
      if (!loadDrafts) return;
      void loadDrafts(leadId).then((rows) => setLoaded({ leadId, rows }));
    },
    [loadDrafts],
  );

  const saveDraftFor = useCallback(
    async (turnId: number, edited: DraftEdit) => {
      const save = repoSaveDraft;
      if (!save) return;

      setBusy(true);
      try {
        const outcome = await save(
          edited.leadId,
          edited.channel.trim() === '' ? null : edited.channel.trim(),
          edited.body,
        );
        if (!outcome.ok) {
          patchTurn(turnId, { saveError: outcome.error ?? 'That did not save.' });
          return;
        }

        const lead = leads.find((candidate) => candidate.id === edited.leadId);
        patchTurn(turnId, {
          saved: {
            kind: 'draft',
            leadId: edited.leadId,
            label: lead ? leadLabel(lead) : 'the contact',
            activityId: null,
            draftId: outcome.draftId,
            occurredOn: null,
            promise: null,
            place: null,
            nextDueDate: null,
            factsWritten: 0,
            factsSkipped: 0,
            reused: false,
            // Writing a draft changes no date and queues no sync, so there is
            // nothing to be syncing.
            sync: 'none',
          },
          saveError: null,
        });
        refreshDrafts(edited.leadId);
      } finally {
        setBusy(false);
      }
    },
    [leads, patchTurn, refreshDrafts, repoSaveDraft],
  );

  /**
   * Copy the wording, and record that it was copied.
   *
   * Explicitly not a send. The record says 'copied', the panel says "copied,
   * not sent", and the only thing that moves it on is the person pressing the
   * button that says they sent it.
   */
  const copyDraft = useCallback(
    async (turnId: number, body: string) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.kind !== 'assistant') return;
      const leadId = turn.saved?.leadId ?? turn.leadId;

      try {
        await navigator.clipboard?.writeText(body);
      } catch {
        // A browser that refuses clipboard access is not a failed save. The
        // wording is on screen and selectable either way.
      }

      /*
       * Save the wording before noting the copy, when it was not saved already.
       *
       * Recording a copy is what lets the assistant ask "did you send the one
       * you copied?" instead of asking about every draft ever written, and it
       * can only ask that about a draft that exists. The copy itself is still
       * not a send: the row says 'copied', and only mark_draft_sent moves it on.
       */
      let draftId = turn.saved?.draftId ?? null;
      if (!draftId && leadId && repoSaveDraft) {
        const written = await repoSaveDraft(leadId, turn.proposal?.draft.channel ?? null, body);
        if (!written.ok) {
          patchTurn(turnId, { saveError: written.error ?? 'That could not be kept.' });
          return;
        }
        draftId = written.draftId;
        const lead = leads.find((candidate) => candidate.id === leadId);
        patchTurn(turnId, {
          saved: {
            kind: 'draft',
            leadId,
            label: lead ? leadLabel(lead) : 'the contact',
            activityId: null,
            draftId,
            occurredOn: null,
            promise: null,
            place: null,
            nextDueDate: null,
            factsWritten: 0,
            factsSkipped: 0,
            reused: false,
            sync: 'none',
          },
          saveError: null,
        });
      }

      if (draftId && markDraftCopied) {
        const outcome = await markDraftCopied(draftId);
        if (!outcome.ok && outcome.error) patchTurn(turnId, { saveError: outcome.error });
      }
      if (leadId) refreshDrafts(leadId);
    },
    [leads, markDraftCopied, patchTurn, refreshDrafts, repoSaveDraft, turns],
  );

  /**
   * The person saying they sent it.
   *
   * The only path in the application that produces a sent draft and the
   * follow-up record that goes with it. Where no draft was saved yet, the
   * wording is saved first, so the record carries what was actually sent rather
   * than nothing at all.
   */
  const confirmSent = useCallback(
    async (turnId: number, sentOn: string, body: string) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.kind !== 'assistant') return;
      const leadId = turn.saved?.leadId ?? turn.leadId;
      if (!leadId || !markDraftSent) return;

      setBusy(true);
      try {
        let draftId = turn.saved?.draftId ?? null;
        if (!draftId && repoSaveDraft) {
          const written = await repoSaveDraft(
            leadId, turn.proposal?.draft.channel ?? null, body,
          );
          if (!written.ok) {
            patchTurn(turnId, { saveError: written.error ?? 'That did not save.' });
            return;
          }
          draftId = written.draftId;
        }
        if (!draftId) return;

        const outcome = await markDraftSent(
          draftId, pressToken(`sent-${turnId}`), sentOn, body,
        );
        if (!outcome.sent) {
          patchTurn(turnId, {
            saveError: outcome.error
              ?? (outcome.status === 'not_found'
                ? 'That draft has already been dealt with.'
                : 'That could not be recorded.'),
          });
          return;
        }

        const lead = leads.find((candidate) => candidate.id === leadId);
        patchTurn(turnId, {
          saved: {
            kind: 'sent',
            leadId,
            label: lead ? leadLabel(lead) : 'the contact',
            activityId: outcome.activityId,
            draftId,
            occurredOn: outcome.sentOn,
            promise: null,
            place: null,
            nextDueDate: null,
            factsWritten: 0,
            factsSkipped: 0,
            reused: false,
            sync: 'queued',
          },
          saveError: null,
        });
        drainFor(turnId);
        refreshDrafts(leadId);
      } finally {
        setBusy(false);
      }
    },
    [
      drainFor, leads, markDraftSent, patchTurn, repoSaveDraft,
      refreshDrafts, turns,
    ],
  );

  /**
   * Correcting something that was just saved.
   *
   * Through ctx.update, which is the same path the edit forms on every screen
   * use. The assistant does not get a private way to change a record: if the
   * Pipeline cannot do it, this cannot either.
   */
  const reviseSaved = useCallback(
    async (turnId: number, patch: RevisionPatch) => {
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.kind !== 'assistant' || !turn.saved) return;
      const { saved } = turn;

      setBusy(true);
      try {
        if (saved.leadId) {
          const leadPatch: Record<string, unknown> = {};
          if (patch.name !== undefined && patch.name.trim() !== '') {
            leadPatch.prospect_name = patch.name.trim();
          }
          if (patch.organization !== undefined) {
            leadPatch.organization = patch.organization.trim() === ''
              ? null
              : patch.organization.trim();
          }
          if (patch.channel !== undefined) {
            leadPatch.preferred_channel = patch.channel.trim() === ''
              ? null
              : patch.channel.trim();
          }
          if (patch.nextAction !== undefined) {
            leadPatch.next_action = patch.nextAction.trim() === ''
              ? null
              : patch.nextAction.trim();
          }
          if (patch.nextDueDate !== undefined) {
            leadPatch.next_action_date = patch.nextDueDate === '' ? null : patch.nextDueDate;
          }
          if (Object.keys(leadPatch).length > 0) {
            await update('leads', saved.leadId, leadPatch);
          }
        }

        if (saved.activityId && (patch.summary !== undefined || patch.outcome !== undefined)) {
          const activityPatch: Record<string, unknown> = {};
          if (patch.summary !== undefined && patch.summary.trim() !== '') {
            activityPatch.title = patch.summary.trim().slice(0, 200);
            activityPatch.details = patch.summary.trim();
          }
          if (patch.outcome !== undefined) {
            activityPatch.outcome = patch.outcome.trim() === '' ? null : patch.outcome.trim();
          }
          if (Object.keys(activityPatch).length > 0) {
            await update('activity_events', saved.activityId, activityPatch);
          }
        }

        patchTurn(turnId, {
          saved: {
            ...saved,
            label: patch.name?.trim() || saved.label,
            nextDueDate: patch.nextDueDate === undefined
              ? saved.nextDueDate
              : (patch.nextDueDate === '' ? null : patch.nextDueDate),
          },
          saveError: null,
        });
      } catch (error) {
        patchTurn(turnId, {
          saveError: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy(false);
      }
    },
    [patchTurn, turns, update],
  );

  const clear = useCallback(() => {
    setTurns([]);
    setFocusLeadId(null);
  }, []);

  const value = useMemo<AssistantValue>(
    () => ({
      available,
      open,
      setOpen,
      focusLeadId,
      focusLabel,
      pin: setFocusLeadId,
      turns,
      busy,
      notice,
      ask,
      clear,
      saveContact,
      saveTouch,
      saveDraft: saveDraftFor,
      copyDraft,
      confirmSent,
      reviseSaved,
      usage,
    }),
    [
      available, ask, busy, clear, confirmSent, copyDraft, focusLabel, focusLeadId,
      notice, open, reviseSaved, saveContact, saveDraftFor, saveTouch, turns, usage,
    ],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}
