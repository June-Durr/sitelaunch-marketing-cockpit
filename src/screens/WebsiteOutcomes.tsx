import { useState } from 'react';
import { useData } from '../data/context';
import { Drawer } from '../components/Drawer';
import {
  DataLegend, Empty, Field, Notice, Observed, PageHead, Stat, Unknown,
} from '../components/primitives';
import { formatDay, today } from '../lib/dates';
import { metricToInput, parseMetricInput } from '../lib/format';
import { aggregate } from '../lib/metrics';
import type { TrafficSnapshot } from '../types/domain';
import { SyncedAnalytics } from './SyncedAnalytics';

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

export function WebsiteOutcomes() {
  const { data, remove } = useData();
  const [editing, setEditing] = useState<{ row: TrafficSnapshot | null } | null>(null);

  const sessions = aggregate(data.traffic.map((t) => t.sessions));
  const leadEvents = aggregate(data.traffic.map((t) => t.generate_lead_events));
  const qualified = aggregate(data.traffic.map((t) => t.qualified_inquiries));
  const linked = data.traffic.filter((t) => t.content_item_id).length;

  return (
    <>
      <PageHead
        kicker="What the website saw"
        title="Website Outcomes"
        lede="What happened on your website. Google Analytics and Search Console now sync themselves daily, and those days appear further down, labelled as synced. The table immediately below is the fallback: rows you typed in or imported from an export, for the days nothing was syncing. A row only gets linked to a post when you say so, because a matching tag is a hint and not proof."
        action={
          <button className="btn btn-primary" onClick={() => setEditing({ row: null })}>
            Record outcome
          </button>
        }
      />

      <div className="stat-strip">
        <Stat
          value={sessions.sum === null ? 'None yet' : sessions.sum.toLocaleString()}
          label="Visits"
          note={`across ${sessions.n} of ${data.traffic.length} rows`}
        />
        <Stat
          value={leadEvents.sum === null ? 'None yet' : leadEvents.sum.toLocaleString()}
          label="Enquiries from the site"
          note={leadEvents.n === 0 ? 'none recorded' : `across ${leadEvents.n} rows`}
        />
        <Stat
          value={qualified.sum === null ? 'None yet' : qualified.sum.toLocaleString()}
          label="Good-fit enquiries"
          note={qualified.n === 0 ? 'none recorded' : `across ${qualified.n} rows`}
        />
        <Stat
          value={`${linked}/${data.traffic.length}`}
          label="Linked to a post"
          note="The rest stay unlinked, which is honest"
        />
      </div>

      {data.traffic.length === 0 ? (
        <div style={{ marginTop: '2rem' }}>
          <Empty title="Nothing recorded from your website yet">
            Type in a row by hand, or bring in a Google Analytics export from the Data and
            Import screen.
          </Empty>
        </div>
      ) : (
        <div className="table-wrap" style={{ marginTop: '2rem' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Range</th>
                <th>Source / medium</th>
                <th>Campaign</th>
                <th>Linked content</th>
                <th className="num">Sessions</th>
                <th className="num">Users</th>
                <th className="num">Engaged</th>
                <th className="num">CTA clicks</th>
                <th className="num">Form starts</th>
                <th className="num">Leads</th>
                <th className="num">Qualified</th>
              </tr>
            </thead>
            <tbody>
              {data.traffic.map((t) => {
                const content = data.contentItems.find((c) => c.id === t.content_item_id);
                return (
                  <tr key={t.id}>
                    <td data-label="Range">
                      <button className="row-button" onClick={() => setEditing({ row: t })}>
                        {formatDay(t.range_start)} – {formatDay(t.range_end)}
                      </button>
                    </td>
                    <td data-label="Source / medium">
                      {t.source ?? 'not set'} / {t.medium ?? 'not set'}
                    </td>
                    <td data-label="Campaign">{t.campaign ?? 'No tag'}</td>
                    <td data-label="Linked content">
                      {content ? content.title : <Unknown note="Not attributed to content" />}
                    </td>
                    <td className="num" data-label="Sessions">
                      <Observed value={t.sessions} />
                    </td>
                    <td className="num" data-label="Users">
                      <Observed value={t.active_users} />
                    </td>
                    <td className="num" data-label="Engaged">
                      <Observed value={t.engaged_sessions} />
                    </td>
                    <td className="num" data-label="CTA clicks">
                      <Observed value={t.cta_clicks} />
                    </td>
                    <td className="num" data-label="Form starts">
                      <Observed value={t.form_starts} />
                    </td>
                    <td className="num" data-label="Leads">
                      <Observed value={t.generate_lead_events} />
                    </td>
                    <td className="num" data-label="Qualified">
                      <Observed value={t.qualified_inquiries} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SyncedAnalytics />

      <DataLegend />

      {editing ? (
        <TrafficForm
          row={editing.row}
          onClose={() => setEditing(null)}
          onDelete={
            editing.row
              ? async () => {
                  await remove('traffic_snapshots', (editing.row as TrafficSnapshot).id);
                  setEditing(null);
                }
              : undefined
          }
        />
      ) : null}
    </>
  );
}

function TrafficForm({
  row,
  onClose,
  onDelete,
}: {
  row: TrafficSnapshot | null;
  onClose: () => void;
  onDelete?: () => Promise<void>;
}) {
  const { data, insert, update } = useData();
  const [form, setForm] = useState({
    range_start: row?.range_start ?? today(),
    range_end: row?.range_end ?? today(),
    source: row?.source ?? '',
    medium: row?.medium ?? '',
    campaign: row?.campaign ?? '',
    content_item_id: row?.content_item_id ?? '',
    sessions: metricToInput(row?.sessions ?? null),
    active_users: metricToInput(row?.active_users ?? null),
    engagement_time_secs: metricToInput(row?.engagement_time_secs ?? null),
    engaged_sessions: metricToInput(row?.engaged_sessions ?? null),
    cta_clicks: metricToInput(row?.cta_clicks ?? null),
    form_starts: metricToInput(row?.form_starts ?? null),
    generate_lead_events: metricToInput(row?.generate_lead_events ?? null),
    qualified_inquiries: metricToInput(row?.qualified_inquiries ?? null),
    notes: row?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const numericFields: [keyof typeof form, string][] = [
    ['sessions', 'Sessions'],
    ['active_users', 'Active users'],
    ['engagement_time_secs', 'Engagement time (seconds)'],
    ['engaged_sessions', 'Engaged sessions'],
    ['cta_clicks', 'CTA clicks'],
    ['form_starts', 'Form starts'],
    ['generate_lead_events', 'generate_lead events'],
    ['qualified_inquiries', 'Qualified inquiries'],
  ];

  async function save() {
    setSaving(true);
    const payload = {
      content_item_id: blank(form.content_item_id),
      range_start: form.range_start,
      range_end: form.range_end,
      source: blank(form.source),
      medium: blank(form.medium),
      campaign: blank(form.campaign),
      sessions: parseMetricInput(form.sessions),
      active_users: parseMetricInput(form.active_users),
      engagement_time_secs: parseMetricInput(form.engagement_time_secs),
      engaged_sessions: parseMetricInput(form.engaged_sessions),
      cta_clicks: parseMetricInput(form.cta_clicks),
      form_starts: parseMetricInput(form.form_starts),
      generate_lead_events: parseMetricInput(form.generate_lead_events),
      qualified_inquiries: parseMetricInput(form.qualified_inquiries),
      ingest_source: (row?.ingest_source ?? 'manual') as 'manual',
      notes: blank(form.notes),
      is_seed: row?.is_seed ?? false,
    };
    if (row) await update('traffic_snapshots', row.id, payload);
    else await insert('traffic_snapshots', payload);
    onClose();
  }

  return (
    <Drawer title={row ? 'Edit website outcome' : 'Record website outcome'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Range start">
          <input
            type="date"
            value={form.range_start}
            onChange={(e) => set('range_start', e.target.value)}
          />
        </Field>
        <Field label="Range end">
          <input
            type="date"
            value={form.range_end}
            onChange={(e) => set('range_end', e.target.value)}
          />
        </Field>
        <Field label="Source">
          <input type="text" value={form.source} onChange={(e) => set('source', e.target.value)} />
        </Field>
        <Field label="Medium">
          <input type="text" value={form.medium} onChange={(e) => set('medium', e.target.value)} />
        </Field>
        <Field label="Campaign">
          <input
            type="text"
            value={form.campaign}
            onChange={(e) => set('campaign', e.target.value)}
          />
        </Field>
        <Field
          label="Which post sent these visits"
          span
          hint="Only pick one if the source, medium and campaign tags genuinely point at a single post. Otherwise leave it, and the app will say it does not know."
        >
          <select
            value={form.content_item_id}
            onChange={(e) => set('content_item_id', e.target.value)}
          >
            <option value="">I do not know which post</option>
            {data.contentItems.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="fieldset-legend">Figures</div>
      <Notice>
        If Google Analytics did not give you a number, leave that box empty. An empty box
        stays empty everywhere in the app. It never quietly becomes a zero.
      </Notice>
      <div className="form-grid">
        {numericFields.map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              type="text"
              inputMode="decimal"
              placeholder="Leave blank if not reported"
              value={form[key] as string}
              onChange={(e) => set(key, e.target.value as never)}
            />
          </Field>
        ))}
        <Field label="Notes" span>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>

      <div className="form-actions">
        {onDelete ? (
          <button className="btn btn-quiet btn-danger" onClick={onDelete}>
            Delete
          </button>
        ) : null}
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Drawer>
  );
}
