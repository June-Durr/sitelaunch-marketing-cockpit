import { useState } from 'react';
import { useData } from '../data/context';
import { Drawer } from '../components/Drawer';
import { Field, Notice } from '../components/primitives';
import { buildUtmUrl } from '../lib/format';
import { fromLocalInput, measurementDueDate, toDayString, toLocalInput } from '../lib/dates';
import { blankCalendarSync } from '../data/factories';
import type { ContentFormat, ContentItem, ContentStatus, Platform } from '../types/domain';
import { FORMAT_LABELS, PLATFORM_LABELS, STATUS_LABELS } from '../types/domain';

const FORMATS = Object.keys(FORMAT_LABELS) as ContentFormat[];
const STATUSES = Object.keys(STATUS_LABELS) as ContentStatus[];

interface FormState {
  account_id: string;
  title: string;
  format: ContentFormat;
  status: ContentStatus;
  published_at: string;
  pillar: string;
  target_audience: string;
  hook: string;
  cta: string;
  destination_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  is_externally_amplified: boolean;
  amplifier_name: string;
  amplification_note: string;
  notes: string;
  screenshot_url: string;
}

function initialState(item: ContentItem | null, defaultAccount: string): FormState {
  return {
    account_id: item?.account_id ?? defaultAccount,
    title: item?.title ?? '',
    format: item?.format ?? 'post',
    status: item?.status ?? 'draft',
    published_at: toLocalInput(item?.published_at ?? null),
    pillar: item?.pillar ?? '',
    target_audience: item?.target_audience ?? '',
    hook: item?.hook ?? '',
    cta: item?.cta ?? '',
    destination_url: item?.destination_url ?? '',
    utm_source: item?.utm_source ?? '',
    utm_medium: item?.utm_medium ?? '',
    utm_campaign: item?.utm_campaign ?? '',
    is_externally_amplified: item?.is_externally_amplified ?? false,
    amplifier_name: item?.amplifier_name ?? '',
    amplification_note: item?.amplification_note ?? '',
    notes: item?.notes ?? '',
    screenshot_url: item?.screenshot_url ?? '',
  };
}

const blank = (value: string) => (value.trim() === '' ? null : value.trim());

export function ContentForm({
  item,
  onClose,
}: {
  item: ContentItem | null;
  onClose: () => void;
}) {
  const { data, insert, update } = useData();
  const [form, setForm] = useState<FormState>(() =>
    initialState(item, data.accounts[0]?.id ?? ''),
  );
  const [createChecks, setCreateChecks] = useState(!item);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const previewUrl = buildUtmUrl(form.destination_url, {
    source: form.utm_source,
    medium: form.utm_medium,
    campaign: form.utm_campaign,
  });

  const needsPublishDate = form.status === 'published' || form.status === 'measured';

  async function save() {
    if (!form.title.trim()) {
      setProblem('Give it a title first, so you can recognise it later.');
      return;
    }
    if (needsPublishDate && !form.published_at) {
      setProblem('Once something is published, the app needs to know when, so it can work out when to remind you to check the numbers.');
      return;
    }
    if (form.is_externally_amplified && !form.amplifier_name.trim()) {
      setProblem('Say who boosted it. The app will show that reason whenever it explains why this post is left out of the averages.');
      return;
    }

    setSaving(true);
    setProblem(null);
    const payload = {
      account_id: blank(form.account_id),
      cross_post_group_id: item?.cross_post_group_id ?? null,
      title: form.title.trim(),
      format: form.format,
      status: form.status,
      published_at: fromLocalInput(form.published_at),
      pillar: blank(form.pillar),
      target_audience: blank(form.target_audience),
      hook: blank(form.hook),
      cta: blank(form.cta),
      destination_url: blank(previewUrl || form.destination_url),
      utm_source: blank(form.utm_source),
      utm_medium: blank(form.utm_medium),
      utm_campaign: blank(form.utm_campaign),
      is_externally_amplified: form.is_externally_amplified,
      amplifier_name: form.is_externally_amplified ? blank(form.amplifier_name) : null,
      amplification_note: form.is_externally_amplified ? blank(form.amplification_note) : null,
      notes: blank(form.notes),
      screenshot_url: blank(form.screenshot_url),
      external_id: item?.external_id ?? null,
      is_seed: item?.is_seed ?? false,
    };

    try {
      if (item) {
        await update('content_items', item.id, payload);
      } else {
        const created = await insert('content_items', payload);
        if (createChecks && payload.published_at) {
          const publishedDay = toDayString(payload.published_at);
          for (const window of ['24h', '7d'] as const) {
            await insert('tasks', {
              content_item_id: created.id,
              lead_id: null,
              title: `Check the numbers on ${created.title} (${window === '24h' ? '1 day' : '7 days'} after posting)`,
              task_type: 'measurement_check',
              status: 'open',
              due_date: measurementDueDate(publishedDay, window),
              window_type: window,
              notes: null,
              completed_at: null,
              ...blankCalendarSync(),
              is_seed: false,
            });
          }
        }
      }
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Drawer title={item ? 'Edit this post' : 'Add a post'} onClose={onClose}>
      {data.accounts.length === 0 ? (
        <Notice tone="amber">
          You have not added any accounts yet. Add one under Data and Import, so the app
          knows which platform this went out on.
        </Notice>
      ) : null}

      <div className="form-grid">
        <Field label="Account">
          <select
            value={form.account_id}
            onChange={(e) => set('account_id', e.target.value)}
          >
            <option value="">No account</option>
            {data.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {PLATFORM_LABELS[a.platform as Platform]} · {a.handle}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Format">
          <select
            value={form.format}
            onChange={(e) => set('format', e.target.value as ContentFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Status">
          <select
            value={form.status}
            onChange={(e) => set('status', e.target.value as ContentStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Publish date and time"
          hint={needsPublishDate ? 'Required once published' : 'Optional while drafting'}
        >
          <input
            type="datetime-local"
            value={form.published_at}
            onChange={(e) => set('published_at', e.target.value)}
          />
        </Field>

        <Field label="Title" span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="SiteLaunch BTS Story"
          />
        </Field>

        <Field
          label="Theme"
          hint="What this post is about, like tips, behind the scenes, or client work. Sometimes called a content pillar. Grouping posts this way is what lets the app spot which kinds of post actually work."
        >
          <input
            type="text"
            value={form.pillar}
            onChange={(e) => set('pillar', e.target.value)}
            placeholder="Behind the scenes"
          />
        </Field>

        <Field label="Who it is for" hint="Who you had in mind when you made it.">
          <input
            type="text"
            value={form.target_audience}
            onChange={(e) => set('target_audience', e.target.value)}
          />
        </Field>

        <Field label="Opening line" span hint="The first thing people see or hear. It decides whether they keep watching.">
          <textarea value={form.hook} onChange={(e) => set('hook', e.target.value)} />
        </Field>

        <Field label="What you asked people to do" span hint="Tap the link, send a message, save it for later. If you did not ask, say so.">
          <textarea value={form.cta} onChange={(e) => set('cta', e.target.value)} />
        </Field>
      </div>

      <div className="fieldset-legend">The link and how you will track it</div>
      <div className="form-grid">
        <Field label="Link you want people to visit" span>
          <input
            type="url"
            value={form.destination_url}
            onChange={(e) => set('destination_url', e.target.value)}
            placeholder="https://sitelaunchstudios.com/"
          />
        </Field>
        <Field label="UTM source">
          <input
            type="text"
            value={form.utm_source}
            onChange={(e) => set('utm_source', e.target.value)}
            placeholder="instagram"
          />
        </Field>
        <Field label="UTM medium">
          <input
            type="text"
            value={form.utm_medium}
            onChange={(e) => set('utm_medium', e.target.value)}
            placeholder="story"
          />
        </Field>
        <Field label="UTM campaign">
          <input
            type="text"
            value={form.utm_campaign}
            onChange={(e) => set('utm_campaign', e.target.value)}
            placeholder="bts_story_2026_09"
          />
        </Field>
      </div>
      {previewUrl ? (
        <p className="notice notice-violet">
          Use this exact link when you post:{' '}
          <span style={{ overflowWrap: 'anywhere' }}>{previewUrl}</span>
          <br />
          The tags on the end are how your website recognises someone as having come from
          this post. Without them, the visit looks like it came from nowhere.
        </p>
      ) : null}

      <div className="fieldset-legend">Boosting, and keeping a record</div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={form.is_externally_amplified}
          onChange={(e) => set('is_externally_amplified', e.target.checked)}
        />
        <span>
          Someone else shared or boosted this
          <br />
          <span className="field-hint">
            Tick this if a bigger account reposted it, or you paid to promote it. The post
            stays visible, but it is kept out of the averages. Its reach came from someone
            else, so counting it would quietly raise the bar for everything you post
            normally.
          </span>
        </span>
      </label>

      {form.is_externally_amplified ? (
        <div className="form-grid" style={{ marginTop: '1rem' }}>
          <Field label="Who boosted it">
            <input
              type="text"
              value={form.amplifier_name}
              onChange={(e) => set('amplifier_name', e.target.value)}
              placeholder="Only in Dade"
            />
          </Field>
          <Field label="Anything worth noting about that">
            <input
              type="text"
              value={form.amplification_note}
              onChange={(e) => set('amplification_note', e.target.value)}
            />
          </Field>
        </div>
      ) : null}

      <div className="form-grid" style={{ marginTop: '1.25rem' }}>
        <Field label="Screenshot link" hint="Paste a link to a screenshot you saved. Platforms delete their numbers eventually; your screenshot does not.">
          <input
            type="url"
            value={form.screenshot_url}
            onChange={(e) => set('screenshot_url', e.target.value)}
          />
        </Field>
        <Field label="Notes" span>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>

      {!item ? (
        <label className="checkbox-row" style={{ marginTop: '1rem' }}>
          <input
            type="checkbox"
            checked={createChecks}
            onChange={(e) => setCreateChecks(e.target.checked)}
          />
          <span>
            Remind me to check the numbers after 1 day and after 7 days
            <br />
            <span className="field-hint">
              Needs a publish date. Platforms delete story numbers after a while, so if you
              miss the check you cannot go back and get it.
            </span>
          </span>
        </label>
      ) : null}

      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      <div className="form-actions">
        <button className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : item ? 'Save changes' : 'Add this post'}
        </button>
      </div>
    </Drawer>
  );
}
