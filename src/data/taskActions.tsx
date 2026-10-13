/**
 * Finishing, skipping and binning a task, and saying so afterwards.
 *
 * One place, used by every screen with a Done button, so what happens and what
 * is said about it cannot drift between Today and Tasks.
 *
 * WHY THE TOKEN IS MADE HERE
 *
 * A token identifies one press of one button. Generating it at the moment of the
 * click, and reusing it if the call is retried, is what makes a double click or
 * a flaky connection write one activity instead of two. Generating it inside the
 * repository would make every retry a new press, which is the bug it exists to
 * prevent.
 *
 * WHY THE RULE STILL RUNS IN THE BROWSER
 *
 * src/config/followUp.ts decides when the next follow-up lands, and it is the
 * only implementation of that decision. This asks it, then hands the answer to
 * one database function that applies the whole change atomically. The
 * alternative, writing the cadence in SQL as well, is two implementations to
 * keep in agreement.
 *
 * WHAT HAPPENS IN BROWSER-ONLY MODE
 *
 * There is no server and so no transaction to offer. The older client-side path
 * in taskCompletion.ts still runs, with the same confirmation and the same
 * wording; what it cannot offer there is Undo, because nothing recorded what the
 * row looked like before. The screen says so rather than showing a button that
 * would not work.
 */

import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
  type ReactNode,
} from 'react';

import { useData } from './context';
import { completeTask, skipTask } from './taskCompletion';
import { planNextAction } from '../config/followUp';
import { dayOf, formatDay } from '../lib/dates';
import { leadShortLabel } from '../lib/leadLabel';
import type { Task } from '../types/domain';
import type { ToastState } from '../components/CompletionToast';

export interface TaskActions {
  /** The task currently being written, so its button can say "Saving…". */
  busyId: string | null;
  /**
   * Tasks finished moments ago.
   *
   * The row stays in the queue wearing its success state for a breath before it
   * goes, so the thing you clicked does not vanish out from under the pointer.
   */
  recentlyDone: ReadonlySet<string>;
  /** A per-task error, left beside the row that failed rather than replacing it. */
  errors: ReadonlyMap<string, string>;
  done(task: Task, options?: { channel?: string | null; approvedMessage?: string | null }): Promise<void>;
  skip(task: Task): Promise<void>;
  bin(task: Task): Promise<void>;
  /** Bring a binned task back, from the Recently deleted list. */
  restore(task: Task): Promise<void>;
  /**
   * Reverse the last operation on a task, from the row rather than the toast.
   *
   * The confirmation lasts about five seconds, which is right for a
   * confirmation and useless as recovery. A row that has something to undo
   * offers it for as long as that remains true.
   */
  undoFor(task: Task): Promise<void>;
  toast: ToastState | null;
  dismissToast(): void;
}

const TaskActionsContext = createContext<TaskActions | null>(null);

/** How long a finished row lingers before the queue drops it. */
const LINGER_MS = 1400;

export function useTaskActions(): TaskActions {
  const value = useContext(TaskActionsContext);
  if (!value) throw new Error('TaskActionsProvider is missing');
  return value;
}

export function TaskActionsProvider({ children }: { children: ReactNode }) {
  const ctx = useData();
  const {
    data, repoCompleteTask, repoUndo, repoSkip, repoBin, repoDrain,
  } = useRepoActions();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [recentlyDone, setRecentlyDone] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastId = useRef(0);

  const show = useCallback((next: Omit<ToastState, 'id'>) => {
    toastId.current += 1;
    setToast({ ...next, id: toastId.current });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const noteError = useCallback((taskId: string, message: string) => {
    setErrors((prev) => new Map(prev).set(taskId, message));
  }, []);

  const clearError = useCallback((taskId: string) => {
    setErrors((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  /**
   * Ask the worker to run this person's queue, and say what came back.
   *
   * Not awaited by the thing that saved: the save is already committed and the
   * queue is durable, so a slow or failed drain must not hold up the
   * confirmation or turn a successful save into a visible failure. What it
   * changes is the second line of the confirmation, from "calendar syncing" to
   * "calendar synced", and only when the worker really reported success.
   */
  const drainAndReport = useCallback(
    (toastIdAtSave: number) => {
      if (!repoDrain) return;
      void repoDrain().then((result) => {
        if (!result.ran || result.succeeded === 0) return;
        setToast((current) => {
          // Only if the same confirmation is still on screen. Overwriting a
          // later message with the outcome of an earlier save would be worse
          // than saying nothing.
          if (!current || current.id !== toastIdAtSave) return current;
          return {
            ...current,
            detail: result.failed > 0
              ? 'Saved. Calendar synced; something else in the queue did not.'
              : 'Saved and synced.',
          };
        });
      });
    },
    [repoDrain],
  );

  const linger = useCallback((taskId: string) => {
    setRecentlyDone((prev) => new Set(prev).add(taskId));
    setTimeout(() => {
      setRecentlyDone((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }, LINGER_MS);
  }, []);

  /** Reverse the last operation on a task, and say what happened either way. */
  const undo = useCallback(
    async (taskId: string) => {
      if (!repoUndo) return;
      const result = await repoUndo(taskId);
      await ctx.refresh();

      if (result.status === 'undone') {
        show({ tone: 'neutral', message: 'Put back as it was.' });
        // Undo queues its own syncs, because the calendar now says the wrong
        // date. Run them for the same reason a completion does.
        drainAndReport(toastId.current);
        return;
      }
      if (result.status === 'conflict') {
        // A conflict is information, not a failure. Saying which record moved on
        // is the difference between a person understanding and a person
        // pressing it again.
        show({
          tone: 'error',
          message: 'This cannot be undone now.',
          detail:
            `${result.reasons.join(', ')}. Undoing would discard that newer change, `
            + 'so nothing was altered.',
        });
        return;
      }
      if (result.status === 'nothing_to_undo') {
        show({ tone: 'neutral', message: 'There is nothing left to undo here.' });
        return;
      }
      show({
        tone: 'error',
        message: 'That could not be undone.',
        detail: result.error ?? result.status,
      });
    },
    [repoUndo, ctx, show, drainAndReport],
  );

  const done = useCallback(
    async (task: Task, options: { channel?: string | null; approvedMessage?: string | null } = {}) => {
      if (busyId !== null) return;
      setBusyId(task.id);
      clearError(task.id);

      // One token for this press. A retry inside this call reuses it, so the
      // write happens once however many times the request is made.
      const token = `${task.id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const occurredAt = new Date().toISOString();
      const lead = task.lead_id
        ? (data.leads.find((l) => l.id === task.lead_id) ?? null)
        : null;

      // The one cadence rule, asked here and applied atomically below.
      const plan = lead ? planNextAction(lead, data.tasks, dayOf(occurredAt)) : null;
      const reopen = plan?.kind === 'reschedule' && plan.taskId === task.id;

      try {
        if (repoCompleteTask) {
          const result = await repoCompleteTask({
            taskId: task.id,
            token,
            occurredAt,
            channel: options.channel ?? lead?.preferred_channel ?? null,
            approvedMessage: options.approvedMessage ?? null,
            outcome: null,
            nextDueDate: plan?.dueDate ?? null,
            nextTitle: plan?.title ?? null,
            nextNotes: plan?.notes ?? plan?.reason ?? null,
            reopenTask: reopen,
          });

          if (!result.ok) {
            // The row stays where it is, carrying a reason. Nothing was saved,
            // so removing it from the queue would be a lie.
            noteError(task.id, result.error ?? 'That did not save.');
            show({ tone: 'error', message: 'That did not save.', detail: result.error });
            return;
          }

          await ctx.refresh();
          linger(task.id);
          // The queue already holds the request; this only asks for it to be
          // run now rather than at the next scheduled sweep.
          drainAndReport(toastId.current + 1);
          show(confirmation(task, lead, result.nextDueDate, options.channel ?? lead?.preferred_channel ?? null, plan?.reason ?? null, repoUndo ? () => void undo(task.id) : null));
          return;
        }

        // Browser-only mode: no transaction, and no undo to offer.
        const result = await completeTask(ctx, data, task, occurredAt);
        await ctx.refresh();
        linger(task.id);
        show({
          tone: 'success',
          message: result.alreadyLogged
            ? `"${task.title}" was already logged, so nothing was added twice.`
            : confirmation(task, lead, plan?.dueDate ?? null, lead?.preferred_channel ?? null, plan?.reason ?? null, null).message,
          detail: 'Saved in this browser. Undo needs the server, so it is not offered here.',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        noteError(task.id, message);
        show({ tone: 'error', message: 'That did not save.', detail: message });
      } finally {
        setBusyId(null);
      }
    },
    [
      busyId, clearError, data, repoCompleteTask, repoUndo, ctx, linger,
      noteError, show, undo, drainAndReport,
    ],
  );

  const skip = useCallback(
    async (task: Task) => {
      if (busyId !== null) return;
      setBusyId(task.id);
      try {
        if (repoSkip) await repoSkip(task.id);
        else await skipTask(ctx, task);
        await ctx.refresh();
        linger(task.id);
        // Skipping means it did not happen, so nothing was logged and the
        // message says so rather than implying a record exists.
        show({
          tone: 'neutral',
          message: `Skipped. Nothing was logged, because nothing happened.`,
          onUndo: repoUndo ? () => void undo(task.id) : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        noteError(task.id, message);
        show({ tone: 'error', message: 'That could not be skipped.', detail: message });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, repoSkip, repoUndo, ctx, linger, noteError, show, undo],
  );

  const bin = useCallback(
    async (task: Task) => {
      if (busyId !== null) return;
      setBusyId(task.id);
      try {
        if (repoBin) await repoBin(task.id);
        else await ctx.remove('tasks', task.id);
        await ctx.refresh();
        show({
          tone: 'neutral',
          message: 'Moved to Recently deleted.',
          detail: repoBin
            ? 'Nothing was removed. Every link and calendar id is kept, so it comes back exactly as it was.'
            : 'Deleted from this browser.',
          onUndo: repoBin && repoUndo ? () => void undo(task.id) : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        noteError(task.id, message);
        show({ tone: 'error', message: 'That could not be deleted.', detail: message });
      } finally {
        setBusyId(null);
      }
    },
    [busyId, repoBin, repoUndo, ctx, noteError, show, undo],
  );

  const restore = useCallback(
    async (task: Task) => {
      if (busyId !== null) return;
      setBusyId(task.id);
      try {
        await undo(task.id);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, undo],
  );

  const undoFor = useCallback(
    async (task: Task) => {
      if (busyId !== null) return;
      setBusyId(task.id);
      try {
        await undo(task.id);
      } finally {
        setBusyId(null);
      }
    },
    [busyId, undo],
  );

  const value = useMemo<TaskActions>(
    () => ({
      busyId, recentlyDone, errors, done, skip, bin, restore, undoFor,
      toast, dismissToast,
    }),
    [busyId, recentlyDone, errors, done, skip, bin, restore, undoFor, toast, dismissToast],
  );

  return <TaskActionsContext.Provider value={value}>{children}</TaskActionsContext.Provider>;
}

/* ------------------------------------------------------------- the wording --- */

/**
 * The sentence, built from what was really written.
 *
 * Three different things can have happened and they are not interchangeable:
 * the next follow-up was scheduled, the rule deliberately scheduled nothing
 * because the lead is on hold or archived, or there was no lead at all. Saying
 * "Next follow-up: none" for a lead on hold would read as a failure rather than
 * as the deliberate decision it is.
 */
export function confirmation(
  task: Task,
  lead: { prospect_name: string | null; organization: string | null } | null,
  nextDueDate: string | null,
  channel: string | null,
  reason: string | null,
  onUndo: (() => void) | null,
): Omit<ToastState, 'id'> {
  const who = lead ? leadShortLabel(lead) : task.title;
  const how = channel && channel.trim() !== '' && channel.toLowerCase() !== 'unknown'
    ? ` by ${channel.trim().toLowerCase()}`
    : '';

  const message = nextDueDate
    ? `${who} contacted${how}. Next follow-up: ${formatDay(nextDueDate)}.`
    : lead
      ? `${who} contacted${how}. No follow-up scheduled${reason ? `: ${reason}` : '.'}`
      : `"${task.title}" marked done.`;

  return {
    tone: 'success',
    message,
    // Two separate statements of fact. The save is done; the calendar is not
    // yet, and claiming otherwise would be the app telling a story it cannot
    // see the end of.
    detail: 'Saved; calendar syncing.',
    onUndo,
  };
}

/* ----------------------------------------------------------- the repo seam --- */

/**
 * The durable operations, when the adapter has them.
 *
 * Pulled out so the provider reads as one flow rather than as a pile of
 * optional-method checks, and so browser-only mode is one explicit branch.
 */
function useRepoActions() {
  const ctx = useData();
  return {
    data: ctx.data,
    repoCompleteTask: ctx.completeTaskDurably,
    repoUndo: ctx.undoTaskOperation,
    repoSkip: ctx.skipTaskDurably,
    repoBin: ctx.softDeleteTask,
    repoDrain: ctx.drainSyncJobs,
  };
}
