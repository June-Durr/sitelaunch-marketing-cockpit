import { Link } from 'react-router-dom';
import { Tag, Unknown } from './primitives';
import { formatDay, relativeDue } from '../lib/dates';
import {
  FOLLOW_UP_STATUS_EXPLANATIONS, FOLLOW_UP_STATUS_LABELS, FOLLOW_UP_STATUS_TONES,
  LAST_TOUCH_BASIS_LABELS, type FollowUpState,
} from '../config/followUp';
import { managedFollowUpTask } from '../config/followUpTasks';
import {
  CALENDAR_STATE_EXPLANATIONS, CALENDAR_STATE_LABELS, CALENDAR_STATE_TONES,
  calendarStateFor,
} from '../lib/calendarState';
import type { Task } from '../types/domain';

/**
 * One person to get in touch with, and everything needed to decide whether to.
 *
 * Shared by the Today queue and the Pipeline's action queue so the two cannot
 * drift into saying different things about the same person. Neither screen does
 * any date arithmetic of its own: the state arrives already worked out by
 * src/config/followUp.ts, and this only renders it.
 *
 * WHY THERE IS NO "MARK CONTACTED" BUTTON HERE
 *
 * Opening an email client, a phone dialler or WhatsApp is not evidence that a
 * message was sent. Treating it as contact would move somebody's follow-up date
 * forward because a link was tapped, which is exactly the kind of invented
 * history this app refuses to produce. Recording what happened is a deliberate
 * act on the Activity screen, or finishing the task.
 */

export interface FollowUpQueueProps {
  states: readonly FollowUpState[];
  /** Every task, so each row can find the one the rule keeps for its lead. */
  tasks: readonly Task[];
  /** Today, as the caller worked it out. Never read from a clock in here. */
  now: string;
  /** Shown when there is nobody in this queue. */
  emptyMessage: React.ReactNode;
}

export function FollowUpQueue({ states, tasks, now, emptyMessage }: FollowUpQueueProps) {
  if (states.length === 0) {
    return <p className="field-hint">{emptyMessage}</p>;
  }

  return (
    <ul className="queue">
      {states.map((state) => (
        <FollowUpQueueRow
          key={state.lead.id}
          state={state}
          task={managedFollowUpTask(tasks, state.lead.id)}
          now={now}
        />
      ))}
    </ul>
  );
}

function FollowUpQueueRow({
  state,
  task,
  now,
}: {
  state: FollowUpState;
  task: Task | null;
  now: string;
}) {
  const { lead, daysSince, lastTouch, status } = state;
  const calendar = calendarStateFor(task);

  return (
    <li>
      <div className="queue-main">
        <div className="queue-title">{lead.prospect_name}</div>

        <div className="queue-meta">
          {lead.organization ?? 'No organization recorded'}
          {lead.preferred_channel ? ` · ${lead.preferred_channel}` : ' · No preferred channel'}
        </div>

        {/* What they actually intend to do, in their own words where there are any. */}
        <div className="queue-meta">
          {lead.next_action ?? 'No next action recorded'}
        </div>

        <div className="queue-meta">
          {daysSince === null ? (
            <Unknown label="No contact on record" note={LAST_TOUCH_BASIS_LABELS.none} />
          ) : (
            <span title={LAST_TOUCH_BASIS_LABELS[lastTouch.basis]}>
              {daysSince} {daysSince === 1 ? 'day' : 'days'} since the last touch
              {lastTouch.basis === 'reported' ? ', reported rather than logged' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="queue-side">
        <Tag tone={FOLLOW_UP_STATUS_TONES[status]} title={FOLLOW_UP_STATUS_EXPLANATIONS[status]}>
          {FOLLOW_UP_STATUS_LABELS[status]}
        </Tag>

        <span
          className={
            status === 'overdue' ? 'due-overdue' : status === 'due_today' ? 'due-today' : undefined
          }
        >
          {lead.next_action_date === null
            ? 'No date set'
            : `${relativeDue(lead.next_action_date, now)} · ${formatDay(lead.next_action_date)}`}
        </span>

        <Tag tone={CALENDAR_STATE_TONES[calendar]} title={CALENDAR_STATE_EXPLANATIONS[calendar]}>
          {CALENDAR_STATE_LABELS[calendar]}
        </Tag>

        {/*
          * Opens this exact person, not the pipeline in general.
          *
          * The visible word is short because this sits at the end of a row that
          * already carries three labels, and on a phone "Open Jonathan and
          * Cecilia Villeda" pushed the row off the screen. The accessible name
          * still says who it opens, so a screen reader and a test both get the
          * whole sentence.
          */}
        <Link
          className="btn btn-quiet"
          to={`/pipeline?lead=${lead.id}`}
          aria-label={`Open ${lead.prospect_name}`}
          title={`Open ${lead.prospect_name}`}
        >
          Open
        </Link>
      </div>
    </li>
  );
}
