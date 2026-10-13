/**
 * What the app says after you finish something, and the way back if you did not
 * mean to.
 *
 * WHY IT IS FIXED AND NOT IN THE LIST
 *
 * The row you just acted on leaves the queue, so a message rendered inside it
 * leaves with it. This sits against the bottom of the viewport and stays put
 * while the page scrolls, because the point of it is to be read after the thing
 * it describes has gone.
 *
 * WHY IT QUOTES THE RECORD
 *
 * "Carlos contacted by text. Next follow-up: October 19." is built from the
 * values the database actually returned, not from the ones the click intended.
 * If the rule declined to schedule anything, it says that instead of naming a
 * date that does not exist.
 *
 * THE LIVE REGION
 *
 * The confirmation is announced as well as shown. role="status" with
 * aria-live="polite" waits for a screen reader to finish its sentence rather
 * than cutting in, which is right for a confirmation and wrong for an alarm.
 *
 * THE CELEBRATION
 *
 * A small drawn tick, under a second, once. It is decorative and it is the first
 * thing to go when somebody has asked for reduced motion: then the tick is
 * simply there, already drawn, with nothing moving.
 */

import { useEffect, useRef, useState } from 'react';

export type ToastTone = 'success' | 'error' | 'neutral';

export interface ToastState {
  /** Changes on every new toast, so a repeat of the same text re-announces. */
  id: number;
  tone: ToastTone;
  /** The sentence. Already built from what was really saved. */
  message: string;
  /** A second line, for things like "Saved; calendar syncing". */
  detail?: string | null;
  /** Shown only when the action can actually be reversed. */
  onUndo?: (() => void) | null;
  undoLabel?: string;
}

/** How long a confirmation stays. Long enough to read, short enough not to nag. */
export const TOAST_MS = 5000;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * A tick that draws itself in, once, in under a second.
 *
 * Drawn here rather than animated with a library: it is two paths and a
 * stroke-dashoffset, and the whole thing is cheaper than the import would be.
 */
function Celebration({ still }: { still: boolean }) {
  return (
    <svg
      className={`toast-tick${still ? ' is-still' : ''}`}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
    >
      <circle
        className="toast-tick-ring"
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        opacity="0.35"
      />
      <path
        className="toast-tick-mark"
        d="M7.2 12.4l3.2 3.2 6.4-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CompletionToast({
  toast,
  onDismiss,
}: {
  toast: ToastState | null;
  onDismiss: () => void;
}) {
  const [still, setStill] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Read at toast time rather than at mount, so a mid-session change counts.
    // oxlint-disable-next-line react/set-state-in-effect
    setStill(prefersReducedMotion());
  }, [toast?.id]);

  useEffect(() => {
    if (!toast) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(onDismiss, TOAST_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast?.id, toast, onDismiss]);

  return (
    /**
     * The region exists even when empty.
     *
     * A live region that is added to the page at the same moment it gains text
     * is not reliably announced: the reader has nothing to be watching. An empty
     * container that later fills is.
     */
    <div
      className="toast-region"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {toast ? (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.tone === 'success' ? <Celebration still={still} /> : null}

          <div className="toast-body">
            <p className="toast-message">{toast.message}</p>
            {toast.detail ? <p className="toast-detail">{toast.detail}</p> : null}
          </div>

          {toast.onUndo ? (
            <button className="toast-undo" onClick={toast.onUndo}>
              {toast.undoLabel ?? 'Undo'}
            </button>
          ) : null}

          <button
            className="toast-close"
            onClick={onDismiss}
            // Icon only, so it says what it is.
            aria-label="Dismiss this message"
            title="Dismiss"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden focusable="false">
              <path
                d="M6 6l12 12M18 6L6 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
