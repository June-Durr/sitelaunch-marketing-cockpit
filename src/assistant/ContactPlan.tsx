import { useState } from 'react';
import { Field } from '../components/primitives';
import { today, formatDay } from '../lib/dates';
import { suggestAfterSend } from './followUpSuggestion';
import type { useContactPlan } from './useContactPlan';

export function ContactPlan({ plan }: { plan: ReturnType<typeof useContactPlan> }) {
  const [copyState, setCopyState] = useState<string | null>(null);
  const [introName, setIntroName] = useState(plan.introduction.name ?? '');
  const [introBusiness, setIntroBusiness] = useState(plan.introduction.business ?? '');
  const after = suggestAfterSend({ sentOn: plan.date || today(), body: plan.body, repliesRecorded: plan.repliesRecorded, statedDate: null });
  return (
    <section className="asst-first" aria-label="Message and follow-up plan">
      <p className="asst-first-head">Your message, ready now. Nothing has been sent.</p>
      <Field label="The first message" span>
        <textarea className="asst-body" rows={5} aria-label="The first message" value={plan.body} onChange={(event) => plan.setBody(event.target.value)} />
      </Field>
      {!plan.introduction.name ? (
        <div className="asst-fields">
          <Field label="Your name"><input value={introName} onChange={(event) => setIntroName(event.target.value)} /></Field>
          <Field label="Your business"><input value={introBusiness} onChange={(event) => setIntroBusiness(event.target.value)} /></Field>
          <button className="btn btn-quiet" onClick={() => plan.setIntroduction(introName, introBusiness)}>Use this in my messages</button>
        </div>
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

