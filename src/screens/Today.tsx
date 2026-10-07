import { Suspense, lazy, useState } from 'react';
import { Link } from 'react-router-dom';
import { useData } from '../data/context';
import { Empty, PageHead, Section, Stat, Tag } from '../components/primitives';
import type { CadencePoint } from '../components/CadenceChart';

/** Recharts is the bulk of the bundle and only this chart needs it. */
const CadenceChart = lazy(() =>
  import('../components/CadenceChart').then((m) => ({ default: m.CadenceChart })),
);
import { pickNextStep } from '../engine/recommendations';
import { findMeasurementGaps } from '../engine/measurement';
import { completeTask } from '../data/taskCompletion';
import { recentMeaningfulActivity } from '../lib/activity';
import { ACTIVITY_TYPE_LABELS } from '../types/domain';
import {
  addDays, daysBetween, formatDateTime, formatDay, isWithin,
  relativeDue, toDayString, today,
} from '../lib/dates';
import { isInProgram, programPosition } from '../config/program';
import {
  DUE_SOON_DAYS, NEEDS_ACTION_STATUSES, followUpStates,
} from '../config/followUp';
import { FollowUpQueue } from '../components/FollowUpQueue';
import { readSettings } from '../data/settings';
import { formatCurrency } from '../lib/format';
import { aggregate } from '../lib/metrics';
import { TASK_TYPE_LABELS, WINDOW_LABELS } from '../types/domain';

export function Today() {
  const ctx = useData();
  const { data } = ctx;
  const now = today();
  // The program is fixed, so these numbers cannot drift just because a day passed.
  const program = readSettings().program;
  const position = programPosition(now, program);

  const nextStep = pickNextStep(data, now);

  const openTasks = data.tasks.filter((t) => t.status === 'open');

  const scheduledToday = openTasks.filter(
    (t) =>
      (t.task_type === 'publish' || t.task_type === 'marketing_action') &&
      t.due_date <= now,
  );

  const measurementDue = findMeasurementGaps(data, now);

  /**
   * The one follow-up queue, in the order it should be worked.
   *
   * There used to be two sections here: one built from follow-up tasks and one
   * built from calculated lead state. Once every eligible lead has a task they
   * listed the same seven people twice, so they are one section now, and its
   * membership comes from the calculated state rather than from the tasks. The
   * task is the thing that gets done; the lead state is what decides whether it
   * is due, which is why it is the one that orders this list.
   *
   * No date arithmetic happens on this screen. followUpStates already sorted
   * these worst first, and within a status by whoever has waited longest.
   */
  const queue = followUpStates(data.leads, data.activityEvents, now);

  const dueNow = queue.filter((s) => NEEDS_ACTION_STATUSES.includes(s.status));
  const upcoming = queue.filter(
    (s) => s.status === 'due_soon' || s.status === 'scheduled',
  );
  const [showUpcoming, setShowUpcoming] = useState(false);

  /* -------------------------------------------------- program progress --- */

  const publishedInProgram = data.contentItems.filter(
    (c) =>
      isInProgram(c.published_at, program) &&
      (c.status === 'published' || c.status === 'measured'),
  );
  const measuredInProgram = publishedInProgram.filter((c) =>
    data.snapshots.some((s) => s.content_item_id === c.id && !s.metrics_unavailable),
  );
  const leadsInProgram = data.leads.filter((l) => isInProgram(l.first_contact_at, program));
  const qualifiedInProgram = leadsInProgram.filter((l) =>
    ['qualified', 'call_scheduled', 'proposal', 'waiting', 'won'].includes(l.stage),
  );
  const proposalsInProgram = leadsInProgram.filter((l) =>
    ['proposal', 'waiting', 'won'].includes(l.stage),
  );
  const wonInProgram = data.leads.filter(
    (l) => l.stage === 'won' && isInProgram(l.closed_at, program),
  );
  const wonValue = aggregate(wonInProgram.map((l) => l.closed_value));

  const recentActivity = recentMeaningfulActivity(data, 5, `${now}T23:59:59.999Z`);

  const cadence: CadencePoint[] = (() => {
    const weeks: CadencePoint[] = [];
    // Weekly buckets across the program itself, starting on Day 1. A 91 day
    // program divides into exactly 13 weeks.
    const weekCount = Math.ceil(position.totalDays / 7);
    for (let i = 0; i < weekCount; i += 1) {
      const start = addDays(program.startDate, i * 7);
      const end = addDays(start, 6);
      const count = data.contentItems.filter(
        (c) =>
          c.published_at &&
          (c.status === 'published' || c.status === 'measured') &&
          isWithin(toDayString(c.published_at), start, end),
      ).length;
      weeks.push({
        weekStart: start,
        label: formatDay(start).replace(/,.*$/, ''),
        published: count,
      });
    }
    return weeks;
  })();

  return (
    <>
      <PageHead
        kicker={formatDay(now)}
        title="Today"
        lede="What to do right now, which posts are waiting on numbers, and how the program is actually going."
      />

      <div className="program-bar">
        <div className="program-bar-main">
          <div className="program-day">
            {position.status === 'before' ? (
              <>
                Starts in {position.daysUntilStart}{' '}
                {position.daysUntilStart === 1 ? 'day' : 'days'}
              </>
            ) : (
              <>
                Day {position.day}
                <span className="program-day-of"> of {position.totalDays}</span>
              </>
            )}
          </div>
          <div className="program-meta">
            {program.name}. {formatDay(position.startDate)} to{' '}
            {formatDay(position.targetDate)}.
          </div>
          {program.goal ? <div className="program-goal">{program.goal}</div> : null}
        </div>
        <div className="program-bar-side">
          <div className="program-phase">
            {position.phase
              ? `Phase ${position.phase.number}: ${position.phase.name}`
              : position.status === 'before'
                ? 'Not started yet'
                : 'Program finished'}
          </div>
          <div className="program-meta">
            {position.daysRemaining > 0
              ? `${position.daysRemaining} days left`
              : position.daysRemaining === 0
                ? 'Target date is today'
                : `${Math.abs(position.daysRemaining)} days past the target`}
          </div>
          <Link className="program-edit" to="/data">
            Edit the program
          </Link>
        </div>
      </div>

      {nextStep ? (
        <div className="next-step">
          <div className="next-step-kicker">One recommended next step</div>
          <h2 className="next-step-title">{nextStep.title}</h2>
          <p className="next-step-why">{nextStep.why}</p>
          <p style={{ margin: '1rem 0 0' }}>
            <Link to={nextStep.href}>Go there →</Link>
          </p>
        </div>
      ) : (
        <div className="next-step">
          <div className="next-step-kicker">One recommended next step</div>
          <h2 className="next-step-title">Nothing is waiting.</h2>
          <p className="next-step-why">
            Nothing is overdue, nobody is waiting on you, and nothing is scheduled. Posting
            something new is the only thing that will move any of these numbers.
          </p>
        </div>
      )}

      <Section title="Today's scheduled action" note={`${scheduledToday.length} due`}>
        {scheduledToday.length === 0 ? (
          <p className="field-hint">Nothing scheduled for today.</p>
        ) : (
          <ul className="queue">
            {scheduledToday.map((task) => (
              <li key={task.id}>
                <div className="queue-main">
                  <div className="queue-title">{task.title}</div>
                  <div className="queue-meta">{TASK_TYPE_LABELS[task.task_type]}</div>
                </div>
                <div className="queue-side">
                  <span className={task.due_date < now ? 'due-overdue' : 'due-today'}>
                    {relativeDue(task.due_date, now)}
                  </span>
                  <button
                    className="btn btn-quiet"
                    title="Marks it done and logs it on the Activity screen."
                    onClick={() => completeTask(ctx, data, task)}
                  >
                    Done
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Awaiting measurement"
        note={`${measurementDue.length} overdue`}
        action={
          <Link className="section-note" to="/content">
            Open Content Log →
          </Link>
        }
      >
        {measurementDue.length === 0 ? (
          <p className="field-hint">
            Every post has its numbers written down for every check that has come due.
          </p>
        ) : (
          <>
            <ul className="queue">
              {measurementDue.map((m) => (
                <li key={`${m.contentItemId}-${m.window}`}>
                  <div className="queue-main">
                    <div className="queue-title">{m.title}</div>
                    <div className="queue-meta">
                      {WINDOW_LABELS[m.window]} reading · due {formatDay(m.due)}
                    </div>
                  </div>
                  <div className="queue-side">
                    <Tag tone={m.due < now ? 'crimson' : 'violet'}>
                      {relativeDue(m.due, now)}
                    </Tag>
                  </div>
                </li>
              ))}
            </ul>
            <p className="notice notice-amber">
              Platforms delete these numbers after a while. If you miss the check, there is
              no way to go back and get it. Everything else on this page can wait a day.
              This cannot.
            </p>
          </>
        )}
      </Section>

      <Section
        title="Follow-ups to make"
        note={`${dueNow.length} due now`}
        action={
          upcoming.length > 0 ? (
            <button
              className="section-note"
              style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }}
              onClick={() => setShowUpcoming((on) => !on)}
            >
              {showUpcoming
                ? 'Hide the ones that are not due yet'
                : `Show ${upcoming.length} coming up`}
            </button>
          ) : null
        }
      >
        <FollowUpQueue
          states={dueNow}
          tasks={data.tasks}
          now={now}
          emptyMessage={
            <>
              Nobody is due a follow-up today. People deliberately on hold, archived or
              set to no follow-up are not counted here, which is the point of setting
              them that way.
            </>
          }
        />

        {showUpcoming && upcoming.length > 0 ? (
          <>
            <div className="fieldset-legend">Coming up</div>
            <p className="field-hint" style={{ marginTop: 0 }}>
              Due soon means within {DUE_SOON_DAYS} days. These are here so you can see
              what the week looks like, not because they need doing now.
            </p>
            <FollowUpQueue
              states={upcoming}
              tasks={data.tasks}
              now={now}
              emptyMessage="Nothing scheduled."
            />
          </>
        ) : null}

        <p className="notice">
          This is the one follow-up list. It used to be two, one built from tasks and one
          from the leads themselves, which listed the same people twice over. Who is on it
          and in what order comes from the follow-up rules, and every row carries the one
          number that decides whether to act: how long that person has been waiting.
          Opening an email or a phone link is not recorded as contact, because tapping a
          link is not evidence that anything was sent. Log it on the Activity screen, or
          finish the task, and the next follow-up moves itself.
        </p>
      </Section>

      <Section
        title="What has actually happened"
        note={`${data.activityEvents.length} logged in total`}
        action={
          <Link className="section-note" to="/activity">
            Open Activity
          </Link>
        }
      >
        {recentActivity.length === 0 ? (
          <p className="field-hint">
            Nothing logged yet. The Activity screen is where you record what actually took
            place, rather than what you planned. Nothing appears here on its own.
          </p>
        ) : (
          <ul className="queue">
            {recentActivity.map((event) => (
              <li key={event.id}>
                <div className="queue-main">
                  <div className="queue-title">{event.title}</div>
                  <div className="queue-meta">
                    {ACTIVITY_TYPE_LABELS[event.activity_type]} ·{' '}
                    {formatDateTime(event.occurred_at)}
                  </div>
                </div>
                <div className="queue-side">
                  <span style={{ fontSize: '0.78rem', color: 'var(--ink-3)' }}>
                    {daysBetween(event.occurred_at.slice(0, 10), now) === 0
                      ? 'Today'
                      : `${daysBetween(event.occurred_at.slice(0, 10), now)} days ago`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Program progress"
        note={`${formatDay(position.startDate)} to ${formatDay(position.targetDate)}`}
      >
        <div className="stat-strip">
          <Stat
            value={publishedInProgram.length}
            label="Published"
            note="posts inside the program"
          />
          <Stat
            value={measuredInProgram.length}
            label="Measured"
            note={
              publishedInProgram.length
                ? `${publishedInProgram.length - measuredInProgram.length} still unmeasured`
                : 'nothing published yet'
            }
          />
          <Stat
            value={leadsInProgram.length}
            label="Enquiries"
            note="first made contact in the program"
          />
          <Stat value={qualifiedInProgram.length} label="Good fit" />
          <Stat value={proposalsInProgram.length} label="Proposals" />
          <Stat
            value={wonValue.sum === null ? 'None yet' : formatCurrency(wonValue.sum)}
            label="Closed won"
            note={
              wonInProgram.length === 0
                ? 'none closed'
                : `${wonValue.n} of ${wonInProgram.length} have a value`
            }
          />
        </div>

        <div style={{ marginTop: '1.75rem' }}>
          {publishedInProgram.length === 0 ? (
            <Empty title="Nothing published inside the program yet">
              The chart fills in as you add posts dated inside the program.
            </Empty>
          ) : (
            <Suspense
              fallback={<div className="chart-frame" style={{ height: 232 }} />}
            >
              <CadenceChart data={cadence} />
            </Suspense>
          )}
        </div>
      </Section>
    </>
  );
}
