/**
 * What the assistant proposed, and the buttons that turn it into a record.
 *
 * Every card here is a form before anything is saved and a summary afterwards,
 * and the summary is still a form. That is the whole design: the assistant's
 * version of what happened is a draft of a record, and the person's edit of it
 * is the record. Nothing is written by arriving on screen.
 *
 * WHAT THE WORDING IS CAREFUL ABOUT
 *
 * Copy is "Copy, not sent". Sending is "I sent this", in the first person,
 * because the person is the one making the claim. A saved touch says which day
 * it is recorded against and where the follow-up landed, and the sync line says
 * queued until the worker reports otherwise.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Field, Tag } from '../components/primitives';
import { useData } from '../data/context';
import { leadLabel } from '../lib/leadLabel';
import { FOLLOW_UP_CADENCE_DAYS, nextFollowUpDate } from '../config/followUp';
import { formatDay, today } from '../lib/dates';
import {
  FACT_KIND_LABELS, PROVENANCE_LABELS, PROVENANCE_NOTES,
  type FactKind, type Provenance,
} from '../types/assistant';
import { useAssistant, type SavedRecord, type Turn } from './context';
import type { ProposedFact } from './wire';

type AssistantTurn = Extract<Turn, { kind: 'assistant' }>;

/* --------------------------------------------------------------- the facts --- */

/**
 * The facts, each wearing where it came from.
 *
 * The provenance is a visible part of the row and not a tooltip, because the
 * difference between "they said it" and "I worked it out" is the difference
 * between evidence and a guess, and it has to survive being skim read. Unticking
 * one means it is not written; there is no "reject" state to record, because a
 * fact nobody saved never existed.
 */
function FactList({
  facts,
  keep,
  onToggle,
}: {
  facts: ProposedFact[];
  keep: boolean[];
  onToggle: (index: number) => void;
}) {
  if (facts.length === 0) return null;

  /**
   * A gradient of certainty, strongest first.
   *
   * violet for what the contact said, plain for what the person reports, quiet
   * for what they reckon, amber for what a model guessed. Colour is never the
   * only signal: the label beside it says the same thing in words.
   */
  const tone = (provenance: Provenance): 'violet' | 'default' | 'quiet' | 'amber' => {
    if (provenance === 'contact_stated') return 'violet';
    if (provenance === 'user_stated') return 'default';
    if (provenance === 'user_impression') return 'quiet';
    return 'amber';
  };

  return (
    <div className="asst-facts">
      <p className="asst-facts-head">What I took from that. Untick anything you do not want kept.</p>
      {facts.map((fact, index) => (
        <label className="asst-fact" key={`${fact.kind}-${fact.value}-${index}`}>
          <input
            type="checkbox"
            checked={keep[index] !== false}
            onChange={() => onToggle(index)}
          />
          <span className="asst-fact-body">
            <span className="asst-fact-value">{fact.value}</span>
            <span className="asst-fact-meta">
              <Tag tone="quiet">{FACT_KIND_LABELS[fact.kind as FactKind] ?? fact.kind}</Tag>
              <Tag
                tone={tone(fact.provenance as Provenance)}
                title={PROVENANCE_NOTES[fact.provenance as Provenance]}
              >
                {PROVENANCE_LABELS[fact.provenance as Provenance] ?? fact.provenance}
              </Tag>
              {fact.occurredOn ? <span className="asst-fact-day">{formatDay(fact.occurredOn)}</span> : null}
            </span>
            {fact.provenance === 'assistant_inferred' && fact.sourceExcerpt ? (
              <span className="asst-fact-source">From your words: {fact.sourceExcerpt}</span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- the links --- */

/** Where the record went, so it can be checked rather than taken on trust. */
function ResultLinks({ saved }: { saved: SavedRecord }) {
  const { setOpen } = useAssistant();
  if (!saved.leadId) return null;

  return (
    <p className="asst-links">
      <Link
        className="asst-link"
        to={`/pipeline?lead=${saved.leadId}`}
        onClick={() => setOpen(false)}
      >
        Open {saved.label}
      </Link>
      {saved.activityId ? (
        <Link className="asst-link" to="/activity" onClick={() => setOpen(false)}>
          See it in the activity log
        </Link>
      ) : null}
      {saved.nextDueDate ? (
        <Link className="asst-link" to="/tasks" onClick={() => setOpen(false)}>
          See the follow-up
        </Link>
      ) : null}
    </p>
  );
}

/** What the queued syncs are actually doing. Never a claim beyond what is known. */
function SyncLine({ saved }: { saved: SavedRecord }) {
  if (saved.sync === 'none') return null;
  const words = {
    queued: 'Saved here. The calendar and the sheet are syncing.',
    synced: 'Saved and synced.',
    partial: 'Saved. One sync finished and something else in the queue did not; it will retry.',
  };
  return <p className="asst-sync">{words[saved.sync]}</p>;
}

/* ------------------------------------------------------- the saved summary --- */

/**
 * What was written, and a way to change it.
 *
 * Editable because the assistant's reading of a messy paragraph is a first
 * draft, and the moment to correct it is while it is still on screen. The edit
 * goes through the ordinary update path, so this is not a private channel into
 * the database: anything that can be changed here can be changed on the
 * Pipeline, and the other way round.
 */
function SavedCard({ turn }: { turn: AssistantTurn }) {
  const { reviseSaved, busy } = useAssistant();
  const saved = turn.saved!;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(saved.label);
  const [nextAction, setNextAction] = useState(turn.proposal?.conversation.nextAction ?? '');
  const [nextDueDate, setNextDueDate] = useState(saved.nextDueDate ?? '');
  const [summary, setSummary] = useState(turn.proposal?.conversation.summary ?? '');

  const what = {
    contact: saved.reused ? 'This contact was already saved.' : 'Contact saved.',
    touch: saved.reused ? 'This was already recorded.' : 'Contact recorded.',
    draft: 'Draft saved. Nothing has been sent.',
    sent: 'Recorded as sent.',
  }[saved.kind];

  return (
    <div className="asst-card asst-card-saved">
      <p className="asst-saved-head">{what}</p>

      <dl className="asst-summary">
        <div>
          <dt>Who</dt>
          <dd>{saved.label}</dd>
        </div>
        {saved.occurredOn ? (
          <div>
            <dt>{saved.kind === 'sent' ? 'Sent on' : 'Recorded on'}</dt>
            <dd>{formatDay(saved.occurredOn)}</dd>
          </div>
        ) : null}
        {saved.kind === 'contact' && !saved.occurredOn ? (
          <div>
            <dt>Met on</dt>
            <dd className="asst-absent">
              Not recorded, because the day was not known. Tell me the day and I will add it.
            </dd>
          </div>
        ) : null}
        {/*
          Not on a draft. A draft changes no dates, so quoting the contact's
          follow-up here would read as something this save had decided.
        */}
        {saved.kind !== 'draft' ? (
          <div>
            <dt>Next follow-up</dt>
            <dd>{saved.nextDueDate ? formatDay(saved.nextDueDate) : 'None scheduled'}</dd>
          </div>
        ) : null}
        {saved.factsWritten > 0 || saved.factsSkipped > 0 ? (
          <div>
            <dt>Notes kept</dt>
            <dd>
              {saved.factsWritten}
              {saved.factsSkipped > 0
                ? `, and ${saved.factsSkipped} left out because there was nothing behind them`
                : ''}
            </dd>
          </div>
        ) : null}
      </dl>

      <SyncLine saved={saved} />
      <ResultLinks saved={saved} />

      {editing ? (
        <div className="asst-fields">
          {saved.leadId ? (
            <>
              <Field label="Name">
                <input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="Next step">
                <input
                  value={nextAction}
                  onChange={(event) => setNextAction(event.target.value)}
                />
              </Field>
              <Field label="Next follow-up">
                <input
                  type="date"
                  value={nextDueDate}
                  onChange={(event) => setNextDueDate(event.target.value)}
                />
              </Field>
            </>
          ) : null}
          {saved.activityId ? (
            <Field label="What happened" span>
              <textarea
                rows={2}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </Field>
          ) : null}
          <div className="asst-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void reviseSaved(turn.id, {
                  name,
                  nextAction,
                  nextDueDate,
                  summary: saved.activityId ? summary : undefined,
                }).then(() => setEditing(false))
              }
            >
              Save the change
            </button>
            <button className="btn btn-quiet" onClick={() => setEditing(false)}>
              Leave it
            </button>
          </div>
        </div>
      ) : saved.kind === 'draft' ? null : (
        <button className="btn btn-quiet" onClick={() => setEditing(true)}>
          Something is wrong, let me fix it
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- capture a person --- */

function CaptureCard({ turn }: { turn: AssistantTurn }) {
  const { saveContact, busy } = useAssistant();
  const proposal = turn.proposal!;
  const { person, conversation } = proposal;

  const [name, setName] = useState(person.name ?? '');
  const [organization, setOrganization] = useState(person.organization ?? '');
  const [channel, setChannel] = useState(person.channel ?? '');
  const [handle, setHandle] = useState(person.handle ?? '');
  const [metOn, setMetOn] = useState(person.metOn ?? conversation.occurredOn ?? '');
  const [interest, setInterest] = useState(person.interest ?? '');
  const [nextAction, setNextAction] = useState(conversation.nextAction ?? '');

  /*
   * Where the follow-up date comes from, and saying so.
   *
   * Three different things can put a date in this box and they are not the same
   * claim. The person may have named one. The Cockpit's cadence rule may have
   * suggested one, which for a new contact is thirty days and has nothing to do
   * with this particular person. Or they may have typed one just now.
   *
   * The first live capture showed why this matters: a promise to text examples
   * came with a suggested date a month out, and nothing on screen said the
   * month was a default rather than a reading of what was said.
   */
  const cadence = FOLLOW_UP_CADENCE_DAYS.new_contact;
  const ruleDate = nextFollowUpDate('new_contact', today());
  const stated = conversation.nextDueDate;
  const [nextDueDate, setNextDueDate] = useState(stated ?? ruleDate ?? '');
  const [datePicked, setDatePicked] = useState(false);
  const [keep, setKeep] = useState<boolean[]>(proposal.facts.map(() => true));

  const dateSource: 'you' | 'rule' | 'edited' = datePicked
    ? 'edited'
    : stated !== null
      ? 'you'
      : 'rule';

  const dateLabel = {
    you: 'Next follow-up, from what you said',
    rule: 'Next follow-up, suggested',
    edited: 'Next follow-up, your date',
  }[dateSource];

  const dateHint = {
    you: 'You named this day, so it was not changed.',
    rule:
      `Nobody named a day, so the Cockpit's own rhythm for a new contact put it `
      + `${cadence} days out. It is not a reading of anything you said. Change it `
      + 'if you meant sooner, or clear it for no follow-up.',
    edited: 'Yours, and it is what will be saved.',
  }[dateSource];

  return (
    <div className="asst-card">
      <p className="asst-card-head">A new contact, from what you told me.</p>
      <div className="asst-fields">
        <Field label="Name" hint={name === '' ? 'Leave it blank if you did not catch it.' : undefined}>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Business">
          <input
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
          />
        </Field>
        <Field label="How to reach them">
          <input value={channel} onChange={(event) => setChannel(event.target.value)} />
        </Field>
        <Field label="Their handle or address">
          <input value={handle} onChange={(event) => setHandle(event.target.value)} />
        </Field>
        <Field
          label="Met on"
          hint={metOn === '' ? 'Blank is fine. Nothing gets recorded as happening on a day nobody knows.' : undefined}
        >
          <input type="date" value={metOn} onChange={(event) => setMetOn(event.target.value)} />
        </Field>
        <Field label="What they want">
          <input value={interest} onChange={(event) => setInterest(event.target.value)} />
        </Field>
        <Field label="Next step">
          <input
            value={nextAction}
            onChange={(event) => setNextAction(event.target.value)}
          />
        </Field>
        <Field label={dateLabel} hint={dateHint}>
          <input
            type="date"
            className={dateSource === 'rule' ? 'asst-suggested' : undefined}
            value={nextDueDate}
            onChange={(event) => {
              setDatePicked(true);
              setNextDueDate(event.target.value);
            }}
          />
        </Field>
      </div>

      <FactList
        facts={proposal.facts}
        keep={keep}
        onToggle={(index) =>
          setKeep((previous) => previous.map((value, i) => (i === index ? !value : value)))
        }
      />

      <div className="asst-actions">
        <button
          className="btn"
          disabled={busy || (name.trim() === '' && organization.trim() === '')}
          onClick={() =>
            void saveContact(turn.id, {
              name, organization, channel, handle, metOn, interest,
              nextAction, nextDueDate, keepFacts: keep,
            })
          }
        >
          Save this contact
        </button>
      </div>
      {name.trim() === '' && organization.trim() === '' ? (
        <p className="asst-hint">A name or a business is enough to save them. I need one of the two.</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------- record a contact --- */

function TouchCard({ turn }: { turn: AssistantTurn }) {
  const { saveTouch, busy } = useAssistant();
  const proposal = turn.proposal!;
  const { conversation } = proposal;
  const leadId = proposal.leadId ?? turn.leadId;

  const [occurredOn, setOccurredOn] = useState(conversation.occurredOn ?? '');
  const [summary, setSummary] = useState(conversation.summary ?? '');
  const [channel, setChannel] = useState(conversation.channel ?? '');
  const [outcome, setOutcome] = useState(conversation.outcome ?? '');
  const [nextAction, setNextAction] = useState(conversation.nextAction ?? '');
  const [nextDueDate, setNextDueDate] = useState(conversation.nextDueDate ?? '');

  if (!leadId) {
    return (
      <div className="asst-card">
        <p className="asst-hint">
          I am not sure which contact this is about, so there is nothing to record against yet.
          Tell me who, or open them and ask again.
        </p>
      </div>
    );
  }

  return (
    <div className="asst-card">
      <p className="asst-card-head">Something that already happened.</p>
      <div className="asst-fields">
        <Field
          label="The day it happened"
          hint={occurredOn === '' ? 'Needed. A contact with no day is not a record of anything.' : undefined}
        >
          <input
            type="date"
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </Field>
        <Field label="How">
          <input value={channel} onChange={(event) => setChannel(event.target.value)} />
        </Field>
        <Field label="What happened" span>
          <textarea
            rows={2}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </Field>
        <Field label="What came of it">
          <input value={outcome} onChange={(event) => setOutcome(event.target.value)} />
        </Field>
        <Field label="Next step">
          <input
            value={nextAction}
            onChange={(event) => setNextAction(event.target.value)}
          />
        </Field>
        <Field
          label="Next follow-up"
          hint="Leave this blank to let the follow-up rule decide."
        >
          <input
            type="date"
            value={nextDueDate}
            onChange={(event) => setNextDueDate(event.target.value)}
          />
        </Field>
      </div>

      <div className="asst-actions">
        <button
          className="btn"
          disabled={busy || occurredOn === '' || summary.trim() === ''}
          onClick={() =>
            void saveTouch(turn.id, {
              leadId, occurredOn, summary, channel, outcome, nextAction, nextDueDate,
            })
          }
        >
          Record this
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- write a message --- */

/**
 * The draft, and the three different things somebody can do with it.
 *
 * Save, copy and "I sent this" are deliberately three buttons. One button that
 * copied and marked it sent would be convenient and would put a false record in
 * the log the first time somebody copied a message and then changed their mind.
 */
function DraftCard({ turn }: { turn: AssistantTurn }) {
  const { saveDraft, copyDraft, confirmSent, busy } = useAssistant();
  const proposal = turn.proposal!;
  const leadId = proposal.leadId ?? turn.leadId;

  const [body, setBody] = useState(proposal.draft.body ?? '');
  const [channel, setChannel] = useState(proposal.draft.channel ?? '');
  const [sentOn, setSentOn] = useState(today());
  const [copied, setCopied] = useState(false);
  const saved = turn.saved;

  if (!leadId) {
    return (
      <div className="asst-card">
        <p className="asst-hint">
          Tell me who this is for and I will keep it with them. I will not save a message
          against nobody.
        </p>
        <textarea
          className="asst-body"
          rows={6}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="asst-card">
      <p className="asst-card-head">A message for you to look over. Nothing is sent from here.</p>
      <div className="asst-fields">
        <Field label="Channel">
          <input value={channel} onChange={(event) => setChannel(event.target.value)} />
        </Field>
      </div>
      <textarea
        className="asst-body"
        rows={7}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label="The message"
      />

      <div className="asst-actions">
        <button
          className="btn btn-quiet"
          disabled={busy || body.trim() === ''}
          onClick={() => void saveDraft(turn.id, { leadId, channel, body })}
        >
          {saved?.draftId ? 'Save the changes' : 'Keep this draft'}
        </button>
        <button
          className="btn btn-quiet"
          disabled={body.trim() === ''}
          onClick={() =>
            void copyDraft(turn.id, body).then(() => setCopied(true))
          }
        >
          Copy, not sent
        </button>
        <button
          className="btn"
          disabled={busy || body.trim() === ''}
          onClick={() => void confirmSent(turn.id, sentOn, body)}
        >
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

      {copied ? (
        <p className="asst-hint">
          Copied to your clipboard and noted as copied. That is not the same as sent, so
          nothing is in the log yet.
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- the switch --- */

/**
 * An answer writes nothing, so its links are the whole result.
 *
 * The ids come back from the server already checked against the contacts that
 * were in the prompt, and the names come from the dataset rather than from the
 * answer. A link that said a name the model wrote would be a label nobody
 * verified; this way the worst case is a link that does not render.
 */
function AnswerLinks({ turn }: { turn: AssistantTurn }) {
  const { setOpen, pin } = useAssistant();
  const { data } = useData();
  const ids = turn.proposal?.references ?? [];
  if (ids.length === 0) return null;

  return (
    <p className="asst-links">
      {ids.map((id) => {
        const lead = data.leads.find((candidate) => candidate.id === id);
        if (!lead) return null;
        return (
          <Link
            key={id}
            className="asst-link"
            to={`/pipeline?lead=${id}`}
            onClick={() => {
              pin(id);
              setOpen(false);
            }}
          >
            Open {leadLabel(lead)}
          </Link>
        );
      })}
    </p>
  );
}

export function ProposalCard({ turn }: { turn: AssistantTurn }) {
  if (turn.saved && turn.saved.kind !== 'draft') return <SavedCard turn={turn} />;
  if (!turn.proposal) return null;

  switch (turn.proposal.intent) {
    case 'capture':
      return <CaptureCard turn={turn} />;
    case 'record':
      return <TouchCard turn={turn} />;
    case 'draft':
      return (
        <>
          <DraftCard turn={turn} />
          {turn.saved ? <SavedCard turn={turn} /> : null}
        </>
      );
    default:
      return <AnswerLinks turn={turn} />;
  }
}
