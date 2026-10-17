/**
 * What to do in the first minute after saving somebody you just met.
 *
 * A contact record on its own is filing. The thing that matters is the message
 * that goes out while meeting you still means something to them, so this
 * appears the moment a contact is saved, with the message already written.
 *
 * NOTHING HERE RECORDS A SEND
 *
 * Copying records a copy. Opening a messaging app records a copy, because the
 * wording has left the Cockpit and that is worth knowing, and nothing more.
 * Exporting a contact card records nothing at all; it is not a message. The
 * only button that writes an activity is the one that says you sent it, and it
 * is the only one that says so.
 *
 * WHY THE MESSAGE IS COMPOSED AND NOT GENERATED
 *
 * See src/assistant/firstMessage.ts. The rule for this flow is that it invents
 * nothing, and a template cannot invent a link or a portfolio or a colleague.
 */

import { useState } from 'react';

import { Field } from '../components/primitives';
import { useData } from '../data/context';
import { readSettings, writeSettings, type Introduction } from '../data/settings';
import { formatDay, today } from '../lib/dates';
import {
  buildVCard, cardFileName, cardPreview, contactSupport,
} from './contactCard';
import { composeFirstMessage, messagesUrl } from './firstMessage';
import { suggestAfterSend } from './followUpSuggestion';
import { pressToken } from './pressToken';

export interface FirstContactProps {
  leadId: string;
  /** Where you met, in the words from the capture. */
  metWhere: string | null;
  metOn: string | null;
  /** What you said you would do, in your words. */
  promise: string | null;
  /** Lines worth offering for the contact card's notes. */
  noteOptions: string[];
}

export function FirstContact(props: FirstContactProps) {
  const ctx = useData();

  /*
   * The contact as saved, read back rather than passed in.
   *
   * Everything on the card and in the message comes from the row that now
   * exists: capture_contact decides where a handle ends up, so reading the
   * record is the only way to know whether there is a number to text. The
   * dataset was refreshed by the save that created it.
   */
  const lead = ctx.data.leads.find((candidate) => candidate.id === props.leadId) ?? null;
  const name = lead?.prospect_name ?? null;
  const organization = lead?.organization ?? null;
  const phone = lead?.phone ?? null;
  const email = lead?.email ?? null;

  /*
   * Replies already on file. Zero is not evidence of silence, and nothing
   * downstream is allowed to read it as such: see suggestAfterSend.
   */
  const repliesRecorded = ctx.data.activityEvents.filter(
    (event) => event.lead_id === props.leadId && event.activity_type === 'reply_received',
  ).length;
  const [settings, setSettings] = useState(() => readSettings());
  const [introducing, setIntroducing] = useState(false);
  const [intro, setIntro] = useState<Introduction>(settings.introduction);

  /*
   * Composed every render, deliberately.
   *
   * It is half a dozen string operations on fields that are already in memory.
   * Memoizing it bought nothing and made the compiler give up optimizing the
   * whole component, because the introduction it depends on is state that gets
   * replaced wholesale when somebody saves theirs.
   */
  const composed = composeFirstMessage({
    contactName: name,
    introduction: settings.introduction,
    metWhere: props.metWhere,
    metOn: props.metOn,
    today: today(),
    promise: props.promise,
  });

  const [body, setBody] = useState(composed.body);
  const [edited, setEdited] = useState(false);
  // The composed text follows the introduction until somebody types their own.
  const message = edited ? body : composed.body;

  const [draftId, setDraftId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sentOn, setSentOn] = useState(today());
  const [sent, setSent] = useState<{ on: string; activityId: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [keepNotes, setKeepNotes] = useState<boolean[]>(props.noteOptions.map(() => true));
  const [applied, setApplied] = useState(false);

  const support = contactSupport(
    typeof navigator === 'undefined' ? undefined : navigator,
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function',
  );
  const smsLink = phone
    ? messagesUrl(phone, message, typeof navigator === 'undefined' ? '' : navigator.userAgent)
    : null;

  /** Make sure the wording exists as a draft before anything is done with it. */
  const ensureDraft = async (): Promise<string | null> => {
    if (draftId) return draftId;
    if (!ctx.saveDraft) return null;
    const outcome = await ctx.saveDraft(props.leadId, 'Text', message);
    if (!outcome.ok) {
      setProblem(outcome.error ?? 'That could not be kept.');
      return null;
    }
    setDraftId(outcome.draftId);
    return outcome.draftId;
  };

  /** Copying, and noting that it was copied. Deliberately not a send. */
  const copy = async () => {
    setBusy(true);
    try {
      try {
        await navigator.clipboard?.writeText(message);
      } catch {
        // A browser that refuses the clipboard has not failed a save. The text
        // is on screen and selectable either way.
      }
      const id = await ensureDraft();
      if (id && ctx.markDraftCopied) await ctx.markDraftCopied(id);
      setCopied(true);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Hand the wording to the device's messaging app.
   *
   * Recorded as a copy, because the text has left the Cockpit and the assistant
   * should be able to ask about it later. It is not a send: the app it opens
   * does not tell us whether anybody pressed send, and guessing would put a
   * false record in the log.
   */
  const openMessages = async () => {
    if (!smsLink) return;
    setBusy(true);
    try {
      const id = await ensureDraft();
      if (id && ctx.markDraftCopied) await ctx.markDraftCopied(id);
      setCopied(true);
      window.location.href = smsLink;
    } finally {
      setBusy(false);
    }
  };

  const chosenNotes = props.noteOptions.filter((_note, index) => keepNotes[index] !== false);
  const cardInput = {
    name,
    organization,
    phone,
    email,
    notes: chosenNotes,
  };

  /** Download the card. The phone decides what happens to it after that. */
  const exportCard = () => {
    const card = buildVCard(cardInput);
    if (!card || !support.canExport) return;
    const blob = new Blob([card], { type: 'text/vcard;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = cardFileName(cardInput);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /** The only path here that records contact, because you said it happened. */
  const confirmSent = async () => {
    if (!ctx.markDraftSent) return;
    setBusy(true);
    setProblem(null);
    try {
      const id = await ensureDraft();
      if (!id) return;
      const outcome = await ctx.markDraftSent(id, pressToken(`first-${props.leadId}`), sentOn, message);
      if (!outcome.sent) {
        setProblem(
          outcome.error
          ?? (outcome.status === 'not_found'
            ? 'That draft has already been dealt with.'
            : 'That could not be recorded.'),
        );
        return;
      }
      setSent({ on: outcome.sentOn ?? sentOn, activityId: outcome.activityId });
    } finally {
      setBusy(false);
    }
  };

  const nextStep = sent
    ? suggestAfterSend({
        sentOn: sent.on,
        body: message,
        repliesRecorded,
        statedDate: null,
      })
    : null;

  const applyNext = async () => {
    if (!nextStep?.date) return;
    setBusy(true);
    try {
      await ctx.update('leads', props.leadId, {
        next_action_date: nextStep.date,
        next_action: props.promise ?? 'Follow up',
      });
      setApplied(true);
    } finally {
      setBusy(false);
    }
  };

  const saveIntro = () => {
    const next = { ...settings, introduction: intro };
    writeSettings(next);
    setSettings(next);
    setIntroducing(false);
    // The composed message picks the new introduction up, unless it has been
    // edited by hand, in which case the person's wording wins.
    setEdited(false);
  };

  return (
    <div className="asst-first">
      <p className="asst-first-head">
        {sent ? 'Recorded as sent.' : 'A first message, ready to look over.'}
      </p>

      {sent ? (
        <>
          <p className="asst-sync">
            Sent {formatDay(sent.on)}, and one contact recorded against this person.
          </p>
          {nextStep ? (
            <div className="asst-next">
              <p className="asst-next-head">
                Next follow-up {nextStep.suggested ? 'suggested' : 'from what you said'}:{' '}
                <strong>{formatDay(nextStep.date)}</strong>
              </p>
              <p className="asst-hint">{nextStep.reason}</p>
              {applied ? (
                <p className="asst-hint">Saved to their record.</p>
              ) : (
                <button className="btn btn-quiet" disabled={busy} onClick={() => void applyNext()}>
                  Use that date
                </button>
              )}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <textarea
            className="asst-body"
            rows={5}
            value={message}
            aria-label="The first message"
            onChange={(event) => {
              setEdited(true);
              setBody(event.target.value);
            }}
          />

          {composed.gaps.map((gap) => (
            <p className="asst-hint" key={gap}>
              {gap}
            </p>
          ))}

          {introducing || (settings.introduction.name === null && !edited) ? (
            <div className="asst-fields asst-intro">
              <Field label="Your name">
                <input
                  value={intro.name ?? ''}
                  onChange={(event) => setIntro({ ...intro, name: event.target.value })}
                />
              </Field>
              <Field label="Your business">
                <input
                  value={intro.business ?? ''}
                  onChange={(event) => setIntro({ ...intro, business: event.target.value })}
                />
              </Field>
              <div className="asst-actions">
                <button className="btn btn-quiet" onClick={saveIntro}>
                  Use this in my messages
                </button>
              </div>
            </div>
          ) : null}

          <div className="asst-actions">
            <button className="btn btn-quiet" disabled={busy} onClick={() => void copy()}>
              Copy, not sent
            </button>
            {smsLink ? (
              <button className="btn btn-quiet" disabled={busy} onClick={() => void openMessages()}>
                Open in Messages
              </button>
            ) : null}
            <button className="btn btn-quiet" onClick={() => setShowCard(!showCard)}>
              {showCard ? 'Hide the contact card' : 'Add to phone contacts'}
            </button>
            <button className="btn" disabled={busy} onClick={() => void confirmSent()}>
              I sent this
            </button>
          </div>

          <div className="asst-sent-on">
            <Field label="The day you sent it">
              <input
                type="date"
                value={sentOn}
                onChange={(event) => setSentOn(event.target.value)}
              />
            </Field>
          </div>

          {smsLink ? (
            <p className="asst-hint">
              Open in Messages hands this text to whatever messaging app the device has. On a
              desktop with none set up, nothing will happen. Either way it does not send
              anything and does not record a send.
            </p>
          ) : null}

          {copied ? (
            <p className="asst-hint">
              Noted as copied. That is not the same as sent, so nothing is in the log yet.
            </p>
          ) : null}

          {showCard ? (
            <div className="asst-card asst-vcard">
              <p className="asst-card-head">
                This is what the contact card will contain. Untick any note you would rather
                not have in your phone.
              </p>
              <dl className="asst-summary">
                {cardPreview(cardInput).map((field, index) => (
                  <div key={`${field.label}-${index}`}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>

              {props.noteOptions.length > 0 ? (
                <div className="asst-facts">
                  {props.noteOptions.map((note, index) => (
                    <label className="asst-fact" key={note}>
                      <input
                        type="checkbox"
                        checked={keepNotes[index] !== false}
                        onChange={() =>
                          setKeepNotes((previous) =>
                            previous.map((value, i) => (i === index ? !value : value)))
                        }
                      />
                      <span className="asst-fact-body">
                        <span className="asst-fact-value">{note}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}

              <div className="asst-actions">
                <button className="btn btn-quiet" disabled={!support.canExport} onClick={exportCard}>
                  Download the contact card
                </button>
              </div>

              {/*
                The honest limits, on screen rather than in a comment.

                There is no web API that writes a contact on any platform, and
                the one that reads them is read only, experimental and in
                practice Chrome on Android. So the Cockpit cannot see your
                address book, cannot know whether this person is already in it,
                and must not claim to merge anything.
              */}
              <p className="asst-hint">
                Opening the downloaded file adds them through your phone's own contacts app,
                which is where you choose to add or merge. The Cockpit cannot see your phone
                contacts, so it does not know whether they are already there and does not
                deduplicate anything.
                {support.canExport
                  ? ''
                  : ' This browser cannot produce the file, so open the Cockpit on your phone to use this.'}
              </p>
            </div>
          ) : null}
        </>
      )}

      {problem ? <p className="asst-problem">{problem}</p> : null}
    </div>
  );
}
