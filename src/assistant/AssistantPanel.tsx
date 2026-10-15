/**
 * The assistant, on every screen.
 *
 * A launcher in the corner and a panel beside the page. Deliberately not a
 * modal: the question is usually about what is on the screen behind it, and a
 * dialog that blacks that out makes somebody close it to check the thing they
 * are asking about.
 *
 * WHAT THE HEADER IS FOR
 *
 * Saying what it can see. "Looking at the Pipeline" and "About Chef Jamie" are
 * the two facts that change every answer, so they are on screen rather than
 * implied. A person who can see that it is pinned to the wrong contact can
 * unpin it in one press, which is cheaper than an answer about the wrong person.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { screenName } from './screens';
import { formatCost, useAssistant, type Turn } from './context';
import { ProposalCard } from './ProposalCard';

/** Things to try, for somebody looking at an empty box with no idea what it takes. */
const EXAMPLES = [
  'Met a guy called Eddie at the chamber mixer, runs a taco truck, wants a one page site, said to text him next week',
  'Where did we leave off with Chef Jamie?',
  'Write the follow-up for Ariel in Spanish',
  'Who am I overdue with?',
];

export function AssistantLauncher() {
  const { available, open, setOpen, turns } = useAssistant();
  if (!available || open) return null;

  return (
    <button
      className="asst-launcher"
      onClick={() => setOpen(true)}
      aria-label="Open the assistant"
    >
      <span className="asst-launcher-mark" aria-hidden="true">
        {/* Two lines of a conversation. Decorative; the label says what this is. */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2 4.5h12M2 8h8M2 11.5h5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      Ask
      {turns.length > 0 ? <span className="asst-launcher-count">{turns.length}</span> : null}
    </button>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.kind === 'you') {
    return (
      <div className="asst-turn asst-turn-you">
        <span className="asst-who">You</span>
        <p className="asst-text">{turn.text}</p>
      </div>
    );
  }

  return (
    <div className="asst-turn asst-turn-assistant">
      <span className="asst-who">Assistant</span>
      {/*
        A failed turn has no reply of its own, so its text and its error are the
        same sentence. Printed once, as the problem it is, rather than twice.
      */}
      {turn.text !== '' && turn.text !== turn.error ? (
        <p className="asst-text">{turn.text}</p>
      ) : null}

      {turn.error ? <p className="asst-problem">{turn.error}</p> : null}

      {turn.proposal?.question ? (
        <p className="asst-question">{turn.proposal.question}</p>
      ) : null}

      {turn.proposal && turn.proposal.corrections.length > 0 ? (
        <ul className="asst-corrections">
          {turn.proposal.corrections.map((correction) => (
            <li key={correction}>I {correction}.</li>
          ))}
        </ul>
      ) : null}

      <Candidates turn={turn} />
      <ProposalCard turn={turn} />

      {turn.saveError ? <p className="asst-problem">{turn.saveError}</p> : null}

      {turn.model ? (
        <p className="asst-meta">
          {turn.model}
          {turn.costMicros !== null
            ? `, ${turn.priced ? formatCost(turn.costMicros) : 'cost not on file for this model'}`
            : ''}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The two or three people it could have meant.
 *
 * Shown rather than resolved, because resolving it would be a guess and this is
 * the one question worth asking: everything written afterwards hangs off which
 * person this is. Pressing one pins it, which is a plain state change and costs
 * nothing.
 */
function Candidates({ turn }: { turn: Extract<Turn, { kind: 'assistant' }> }) {
  const { pin, focusLeadId } = useAssistant();
  if (turn.candidates.length < 2 || focusLeadId) return null;

  return (
    <div className="asst-candidates">
      <p className="asst-candidates-head">Which one?</p>
      {turn.candidates.map((candidate) => (
        <button
          key={candidate.id}
          className="btn btn-quiet asst-candidate"
          onClick={() => pin(candidate.id)}
        >
          {candidate.label}
          {candidate.reasons.length > 0 ? (
            <span className="asst-candidate-why">matched on {candidate.reasons.join(' and ')}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function AssistantPanel() {
  const {
    available, open, setOpen, turns, busy, ask, clear, focusLabel, focusLeadId,
    pin, usage, notice,
  } = useAssistant();
  const location = useLocation();
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, busy]);

  if (!available || !open) return null;

  const send = () => {
    const message = text;
    setText('');
    void ask(message);
  };

  return (
    <aside className="asst-panel" aria-label="Assistant">
      <div className="asst-head">
        <div>
          <h2 className="asst-title">Assistant</h2>
          <p className="asst-where">
            Looking at {screenName(location.pathname)}
            {focusLabel ? (
              <>
                , about <strong>{focusLabel}</strong>
              </>
            ) : null}
          </p>
        </div>
        <div className="asst-head-actions">
          {focusLeadId ? (
            <button className="btn btn-quiet" onClick={() => pin(null)}>
              Not about them
            </button>
          ) : null}
          {turns.length > 0 ? (
            <button className="btn btn-quiet" onClick={clear}>
              Start over
            </button>
          ) : null}
          <button className="btn btn-quiet" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>

      {notice ? <p className="notice notice-amber asst-notice">{notice}</p> : null}

      <div className="asst-scroll">
        {turns.length === 0 ? (
          <div className="asst-empty">
            <p>
              Tell me about somebody you met, ask where you left off with a contact, or ask
              me to write a follow-up. I propose, you decide. Nothing is saved and nothing
              is sent until you press a button that says so.
            </p>
            <div className="asst-examples">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  className="asst-example"
                  onClick={() => setText(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
        )}
        {busy ? (
          <p className="asst-working" role="status">
            Thinking.
          </p>
        ) : null}
        <div ref={endRef} />
      </div>

      <form
        className="asst-compose"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          className="asst-input"
          rows={3}
          value={text}
          placeholder="What happened, or what do you need?"
          aria-label="What you want to say"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, because this is a chat. Shift and Enter is a new line,
            // which is what a messy paragraph needs.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="asst-compose-foot">
          <span className="asst-usage">
            {usage && usage.requests > 0 ? (
              <>
                {usage.requests} {usage.requests === 1 ? 'request' : 'requests'} in the last 30
                days, {usage.unknownCost > 0 ? 'at least ' : ''}
                {formatCost(usage.costMicros)}
                {usage.unknownCost > 0
                  ? `, with ${usage.unknownCost} whose cost is not known`
                  : ''}
                {usage.failures > 0
                  ? `, and ${usage.failures} that failed and were still billed`
                  : ''}
              </>
            ) : (
              'Nothing spent yet.'
            )}
          </span>
          <button className="btn" type="submit" disabled={busy || text.trim() === ''}>
            {busy ? 'Thinking' : 'Ask'}
          </button>
        </div>
      </form>
    </aside>
  );
}
