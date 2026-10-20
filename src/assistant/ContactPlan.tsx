import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Field } from '../components/primitives';
import { today, formatDay } from '../lib/dates';
import { suggestAfterSend } from './followUpSuggestion';
import type { useContactPlan } from './useContactPlan';

/**
 * The message and the plan around it, before anything has been saved.
 *
 * Shown in the review card so one Ask produces the whole picture: who they are,
 * what to send, when the first action is due, and what has and has not been
 * recorded yet. Rendering it writes nothing and asks no model anything.
 */
export function ContactPlan({ plan }: { plan: ReturnType<typeof useContactPlan> }) {
  const [copyState, setCopyState] = useState<string | null>(null);

  /*
   * The check-in is counted from the day this would be sent, which is today.
   *
   * Not from plan.date. That is when the first action is due, and the two only
   * coincide when the action is also today: with an action set for Friday, a
   * check-in counted from Friday is describing something else entirely.
   */
  const after = suggestAfterSend({
    sentOn: today(),
    body: plan.body,
    repliesRecorded: plan.repliesRecorded,
    statedDate: null,
  });
  return (
    <section className="asst-first" aria-label="Message and follow-up plan">
      <p className="asst-first-head">Your message, ready now. Nothing has been sent.</p>
      <Field label="The first message" span>
        <textarea className="asst-body" rows={5} aria-label="The first message" value={plan.body} onChange={(event) => plan.setBody(event.target.value)} />
      </Field>
      {/*
        One line, not a form.

        A settings form in the middle of the message was the main thing in the
        way of reading it. The link goes to the profile panel, and the panel
        lives in the shell rather than in a route, so the review and anything
        typed into the message are still here on the way back.
      */}
      {!plan.introduction.name ? (
        <p className="asst-hint asst-profile-gap">
          This will not say who it is from.{' '}
          <Link className="asst-link" to="/data#settings">
            Complete your profile
          </Link>{' '}
          and it writes that line itself. Nothing here is lost while you do.
        </p>
      ) : null}
      {plan.gaps.map((gap) => <p className="asst-hint" key={gap}>{gap}</p>)}
      <button className="btn btn-quiet" disabled={!plan.body.trim()} onClick={() => {
        if (!navigator.clipboard?.writeText) {
          setCopyState('Clipboard unavailable. Select the message and copy it manually. Nothing was sent.'); return;
        }
        void navigator.clipboard.writeText(plan.body).then(
          () => setCopyState('Copied. Nothing has been saved or sent.'),
          () => setCopyState('Clipboard unavailable. Select the message and copy it manually. Nothing was sent.'),
        );
      }}>Copy, not sent</button>
      {copyState ? <p className="asst-hint" role="status">{copyState}</p> : null}
      <p className="asst-hint">Save this review to keep the contact or conversation and schedule the selected action. The message stays here to edit, copy or open in Messages. No second Ask is needed.</p>
      <p className="asst-hint">After you confirm sending, the next check-in is suggested for {formatDay(after.date)}. You can change or clear that reminder before confirming. This is an editable default, not evidence about whether they replied.</p>
      <p className="asst-sync">Calendar and tracking: pending your save. Nothing has been synced yet.</p>
    </section>
  );
}

