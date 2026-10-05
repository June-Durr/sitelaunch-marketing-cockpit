import { useState } from 'react';
import { useData } from '../data/context';
import { Drawer } from '../components/Drawer';
import { Empty, Field, Notice, PageHead, Tag } from '../components/primitives';
import { blankCalendarSync } from '../data/factories';
import { recordContactIfRelevant } from '../data/leadFollowUp';
import { activityInRange, sortActivity } from '../lib/activity';
import { formatDateTime, fromLocalInput, toLocalInput } from '../lib/dates';
import type { ActivityEvent, ActivityType } from '../types/domain';
import {
  ACTIVITY_SOURCE_LABELS, ACTIVITY_TYPE_LABELS, ACTIVITY_TYPES,
} from '../types/domain';

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

export function Activity() {
  const { data } = useData();
  const [editing, setEditing] = useState<{ event: ActivityEvent | null } | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  let rows = sortActivity(data.activityEvents);
  if (typeFilter) rows = rows.filter((a) => a.activity_type === typeFilter);
  if (from || to) {
    rows = activityInRange(rows, from || '0000-01-01', to || '9999-12-31');
  }

  const typesPresent = [...new Set(data.activityEvents.map((a) => a.activity_type))];

  return (
    <>
      <PageHead
        kicker="What actually happened"
        title="Activity"
        lede="A record of things that have already taken place. Tasks are what you plan to do; this is what you did. Nothing lands here on its own, and the app never invents activity from old records, so if it is not written down here then nobody knows it happened."
        action={
          <button className="btn btn-primary" onClick={() => setEditing({ event: null })}>
            Log something
          </button>
        }
      />

      <div className="filters">
        <Field label="Type">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All kinds</option>
            {typesPresent.map((t) => (
              <option key={t} value={t}>
                {ACTIVITY_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {typeFilter || from || to ? (
          <button
            className="btn btn-quiet"
            onClick={() => {
              setTypeFilter('');
              setFrom('');
              setTo('');
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {data.activityEvents.length === 0 ? (
        <Empty title="Nothing logged yet">
          Log the things that actually happen: an event you went to, a reply you got, a
          proposal you sent. Over time this becomes the record that explains why the
          numbers moved.
        </Empty>
      ) : rows.length === 0 ? (
        <Empty title="Nothing matches those filters">Try widening the dates or the type.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>What happened</th>
                <th>Kind</th>
                <th>Linked to</th>
                <th>Came from</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((event) => {
                const content = data.contentItems.find((c) => c.id === event.content_item_id);
                const lead = data.leads.find((l) => l.id === event.lead_id);
                const task = data.tasks.find((t) => t.id === event.task_id);
                const links = [
                  content ? `Post: ${content.title}` : null,
                  lead ? `Person: ${lead.prospect_name}` : null,
                  task ? `Task: ${task.title}` : null,
                ].filter(Boolean) as string[];

                return (
                  <tr key={event.id}>
                    <td data-label="When">{formatDateTime(event.occurred_at)}</td>
                    <td data-label="What happened">
                      <button
                        className="row-button"
                        onClick={() => setEditing({ event })}
                      >
                        {event.title}
                      </button>
                      {event.details ? (
                        <div className="queue-meta">{event.details}</div>
                      ) : null}
                    </td>
                    <td data-label="Kind">
                      <Tag tone="quiet">{ACTIVITY_TYPE_LABELS[event.activity_type]}</Tag>
                    </td>
                    <td data-label="Linked to">
                      {links.length === 0 ? (
                        <span className="v-absent">Nothing</span>
                      ) : (
                        links.join('; ')
                      )}
                    </td>
                    <td data-label="Came from">
                      <Tag tone={event.source === 'manual' ? 'quiet' : 'violet'}>
                        {ACTIVITY_SOURCE_LABELS[event.source]}
                      </Tag>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="notice">
        Anything marked as coming from a connected service was brought in automatically.
        Nothing is connected yet, so at the moment everything here was either typed in or
        created when you finished a task.
      </p>

      {editing ? (
        <ActivityForm event={editing.event} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

function ActivityForm({
  event,
  onClose,
}: {
  event: ActivityEvent | null;
  onClose: () => void;
}) {
  const { data, insert, update, remove } = useData();
  const [form, setForm] = useState({
    occurred_at: toLocalInput(event?.occurred_at ?? new Date().toISOString()),
    activity_type: (event?.activity_type ?? 'other') as ActivityType,
    title: event?.title ?? '',
    details: event?.details ?? '',
    channel: event?.channel ?? '',
    content_item_id: event?.content_item_id ?? '',
    lead_id: event?.lead_id ?? '',
    task_id: event?.task_id ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [followUpNote, setFollowUpNote] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const fromAutomation = event !== null && event.source !== 'manual';

  async function save() {
    if (!form.title.trim()) {
      setProblem('Say what happened, in a few words.');
      return;
    }
    setSaving(true);
    setProblem(null);

    const payload = {
      occurred_at: fromLocalInput(form.occurred_at) ?? new Date().toISOString(),
      activity_type: form.activity_type,
      title: form.title.trim(),
      details: blank(form.details),
      // Editing never relabels where a record came from. A record created by
      // finishing a task stays labelled that way even after you reword it.
      source: event?.source ?? ('manual' as const),
      external_id: event?.external_id ?? null,
      /* Set only by whatever imported the record, so editing leaves it alone. */
      external_source: event?.external_source ?? null,
      channel: blank(form.channel),
      evidence_source: event?.evidence_source ?? null,
      content_item_id: blank(form.content_item_id),
      lead_id: blank(form.lead_id),
      task_id: blank(form.task_id),
      external_calendar_id: event?.external_calendar_id ?? blankCalendarSync().external_calendar_id,
      external_event_id: event?.external_event_id ?? null,
      calendar_sync_status: event?.calendar_sync_status ?? ('not_synced' as const),
      last_synced_at: event?.last_synced_at ?? null,
      sync_error: event?.sync_error ?? null,
      is_seed: event?.is_seed ?? false,
    };

    try {
      if (event) {
        await update('activity_events', event.id, payload);
      } else {
        await insert('activity_events', payload);
        /**
         * Logging contact with somebody moves their follow-up on.
         *
         * Only on a new record. Rewording an old one does not mean it happened
         * again, and re-running the rule from an edit would drag a date forward
         * for no reason.
         */
        const outcome = await recordContactIfRelevant({ insert, update }, data, {
          leadId: payload.lead_id,
          activityType: payload.activity_type,
          occurredAt: payload.occurred_at,
        });
        if (outcome && outcome.taskChanged) setFollowUpNote(outcome.plan.reason);
      }
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Drawer title={event ? 'Edit this activity' : 'Log what happened'} onClose={onClose}>
      {fromAutomation ? (
        <Notice tone="violet">
          This record was created automatically when you finished a task. You can reword it,
          but it stays marked as coming from that task so the trail back is not lost.
        </Notice>
      ) : null}

      <div className="form-grid">
        <Field label="What happened" span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Met three people at the Wynwood meetup"
          />
        </Field>
        <Field label="When" hint="The time it actually happened, not when you are typing it.">
          <input
            type="datetime-local"
            value={form.occurred_at}
            onChange={(e) => set('occurred_at', e.target.value)}
          />
        </Field>
        <Field label="Kind">
          <select
            value={form.activity_type}
            onChange={(e) => set('activity_type', e.target.value as ActivityType)}
          >
            {ACTIVITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTIVITY_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Details" span>
          <textarea value={form.details} onChange={(e) => set('details', e.target.value)} />
        </Field>
      </div>

      <div className="fieldset-legend">Link it to something, if it belongs to something</div>
      <p className="group-blurb">
        Linking is optional and always your call. Leave these alone if the activity does not
        clearly belong to one post or one person.
      </p>
      <div className="form-grid">
        <Field label="A post">
          <select
            value={form.content_item_id}
            onChange={(e) => set('content_item_id', e.target.value)}
          >
            <option value="">Not linked</option>
            {data.contentItems.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="A person">
          <select value={form.lead_id} onChange={(e) => set('lead_id', e.target.value)}>
            <option value="">Not linked</option>
            {data.leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.prospect_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="A task">
          <select value={form.task_id} onChange={(e) => set('task_id', e.target.value)}>
            <option value="">Not linked</option>
            {data.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="How" span hint="Email, phone, WhatsApp, in person. Part of what makes one touch a different touch from another.">
          <input
            type="text"
            value={form.channel}
            onChange={(e) => set('channel', e.target.value)}
          />
        </Field>
      </div>

      {form.lead_id && !event ? (
        <Notice tone="violet">
          Linking this to a person counts as being in touch with them. Saving it moves
          their follow-up on by the rhythm for their stage, and reuses the follow-up
          already open rather than adding a second one. A person set to on hold, archived
          or no follow-up is left exactly as they are.
        </Notice>
      ) : null}

      {followUpNote ? <p className="notice notice-violet">{followUpNote}</p> : null}
      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      <div className="form-actions">
        {event ? (
          <button
            className="btn btn-quiet btn-danger"
            onClick={async () => {
              if (confirm(`Delete this record of "${event.title}"?`)) {
                await remove('activity_events', event.id);
                onClose();
              }
            }}
          >
            Delete
          </button>
        ) : null}
        <button className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Drawer>
  );
}
