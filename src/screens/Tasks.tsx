import { useState } from 'react';
import { useData } from '../data/context';
import { Empty, Field, PageHead, Section, Tag } from '../components/primitives';
import { Drawer } from '../components/Drawer';
import { relativeDue, today } from '../lib/dates';
import { readSettings, writeSettings } from '../data/settings';
import { blankCalendarSync } from '../data/factories';
import { useTaskActions } from '../data/taskActions';
import { RecentlyDeleted } from '../components/RecentlyDeleted';
import type { Task, TaskType } from '../types/domain';
import { TASK_TYPE_LABELS } from '../types/domain';

const TASK_TYPES = Object.keys(TASK_TYPE_LABELS) as TaskType[];

export function Tasks() {
  const ctx = useData();
  // The confirmation, the Undo and the "Saving…" state all live here, so
  // Today and Tasks cannot drift into saying different things.
  const actions = useTaskActions();
  const { data, insert } = ctx;
  const [creating, setCreating] = useState(false);
  const [showDone, setShowDone] = useState(() => readSettings().showCompletedTasks);

  const now = today();
  const open = data.tasks
    .filter((t) => t.status === 'open')
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const overdue = open.filter((t) => t.due_date < now);
  const dueToday = open.filter((t) => t.due_date === now);
  const upcoming = open.filter((t) => t.due_date > now);
  const closed = data.tasks
    .filter((t) => t.status !== 'open')
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));

  const contentTitle = (task: Task) =>
    data.contentItems.find((c) => c.id === task.content_item_id)?.title;

  function TaskList({ tasks, tone }: { tasks: Task[]; tone?: 'overdue' | 'today' }) {
    if (tasks.length === 0) return <p className="field-hint">Nothing here right now.</p>;
    return (
      <ul className="queue">
        {tasks.map((task) => (
          <li
            key={task.id}
            // Worn for a moment after the write lands, so the row you clicked
            // does not simply vanish out from under the pointer.
            className={actions.recentlyDone.has(task.id) ? 'row-just-done' : undefined}
          >
            <div className="queue-main">
              <div className="queue-title">{task.title}</div>
              <div className="queue-meta">
                {TASK_TYPE_LABELS[task.task_type]}
                {contentTitle(task) ? ` · ${contentTitle(task)}` : ''}
                {task.notes ? ` · ${task.notes}` : ''}
              </div>
              {/* Beside the row that failed, not in place of it. Nothing was
                  saved, so removing the row would be a lie. */}
              {actions.errors.get(task.id) ? (
                <div className="row-error" role="alert">
                  Not saved: {actions.errors.get(task.id)}
                </div>
              ) : null}
            </div>
            <div className="queue-side">
              <span
                className={
                  tone === 'overdue' ? 'due-overdue' : tone === 'today' ? 'due-today' : undefined
                }
                style={{ fontSize: '0.78rem' }}
              >
                {relativeDue(task.due_date, now)}
              </span>
              {task.status === 'open' ? (
                <>
                  <button
                    className="btn btn-quiet"
                    title="Marks it done and logs it on the Activity screen."
                    disabled={actions.busyId !== null}
                    onClick={() => void actions.done(task)}
                  >
                    {actions.busyId === task.id ? 'Saving…' : 'Done'}
                  </button>
                  <button
                    className="btn btn-quiet"
                    title="Nothing happened, so nothing gets logged."
                    disabled={actions.busyId !== null}
                    onClick={() => void actions.skip(task)}
                  >
                    Skip
                  </button>
                </>
              ) : (
                <>
                  <Tag tone="quiet">{task.status}</Tag>
                  {/* Recovery after the confirmation has gone. Offered only
                      while there is really something stored to put back. */}
                  {task.last_operation ? (
                    <button
                      className="btn btn-quiet"
                      disabled={actions.busyId !== null}
                      title="Put this back as it was."
                      onClick={() => void actions.undoFor(task)}
                    >
                      {actions.busyId === task.id ? 'Undoing…' : 'Undo'}
                    </button>
                  ) : null}
                  <button className="btn btn-quiet" onClick={() => void actions.bin(task)}>
                    Delete
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <PageHead
        kicker="What to do"
        title="Tasks"
        lede="Things you plan to do. Marking one done also writes it to the Activity screen, which is the record of what actually happened. Skipping writes nothing, because skipping means it did not happen. The number checks come first here, because platforms delete their figures after a while."
        action={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New task
          </button>
        }
      />


      {data.tasks.length === 0 ? (
        <Empty title="Nothing to do">
          When you add a post with a publish date, the app creates its number-checking
          reminders for you automatically.
        </Empty>
      ) : (
        <>
          <Section title="Overdue" note={`${overdue.length}`}>
            <TaskList tasks={overdue} tone="overdue" />
          </Section>
          <Section title="Due today" note={`${dueToday.length}`}>
            <TaskList tasks={dueToday} tone="today" />
          </Section>
          <Section title="Upcoming" note={`${upcoming.length}`}>
            <TaskList tasks={upcoming} />
          </Section>
          <Section
            title="Completed"
            action={
              <button
                className="btn btn-quiet"
                onClick={() =>
                  setShowDone((v) => {
                    writeSettings({ ...readSettings(), showCompletedTasks: !v });
                    return !v;
                  })
                }
              >
                {showDone ? 'Hide' : `Show ${closed.length}`}
              </button>
            }
          >
            {showDone ? <TaskList tasks={closed} /> : <p className="field-hint">Hidden.</p>}
          </Section>
        </>
      )}

      {creating ? <TaskForm onClose={() => setCreating(false)} /> : null}
      <RecentlyDeleted />
    </>
  );

  function TaskForm({ onClose }: { onClose: () => void }) {
    const [title, setTitle] = useState('');
    const [taskType, setTaskType] = useState<TaskType>('marketing_action');
    const [dueDate, setDueDate] = useState(now);
    const [contentId, setContentId] = useState('');
    const [leadId, setLeadId] = useState('');
    const [notes, setNotes] = useState('');
    const [saving, setSaving] = useState(false);

    return (
      <Drawer title="New task" onClose={onClose}>
        <div className="form-grid">
          <Field label="Title" span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Type">
            <select value={taskType} onChange={(e) => setTaskType(e.target.value as TaskType)}>
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due date">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Related content">
            <select value={contentId} onChange={(e) => setContentId(e.target.value)}>
              <option value="">Not linked to anything</option>
              {data.contentItems.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Related lead">
            <select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              <option value="">Not linked to anything</option>
              {data.leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.prospect_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes" span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={saving || !title.trim()}
            onClick={async () => {
              setSaving(true);
              await insert('tasks', {
                content_item_id: contentId || null,
                lead_id: leadId || null,
                deleted_at: null,
                last_operation: null,
                title: title.trim(),
                task_type: taskType,
                status: 'open',
                due_date: dueDate,
                window_type: null,
                notes: notes.trim() || null,
                completed_at: null,
                // Made by hand, so the follow-up rule does not own it and will
      // never move, reopen or close it.
      follow_up_rule_managed: false,
      ...blankCalendarSync(),
                is_seed: false,
              });
              onClose();
            }}
          >
            {saving ? 'Saving…' : 'Create task'}
          </button>
        </div>
      </Drawer>
    );
  }
}
