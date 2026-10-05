import { useState } from 'react';
import { useData } from '../data/context';
import { Drawer } from '../components/Drawer';
import { Field, Notice } from '../components/primitives';
import { metricToInput, parseMetricInput } from '../lib/format';
import { today } from '../lib/dates';
import type { FollowUpMode, Lead, LeadStage } from '../types/domain';
import { STAGE_LABELS, STAGE_ORDER } from '../types/domain';
import { FOLLOW_UP_MODE_LABELS } from '../config/followUp';

const FOLLOW_UP_MODES = Object.keys(FOLLOW_UP_MODE_LABELS) as FollowUpMode[];

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

export function LeadForm({ lead, onClose }: { lead: Lead | null; onClose: () => void }) {
  const { data, insert, update, remove } = useData();

  const [form, setForm] = useState({
    prospect_name: lead?.prospect_name ?? '',
    organization: lead?.organization ?? '',
    email: lead?.email ?? '',
    phone: lead?.phone ?? '',
    project: lead?.project ?? '',
    source: lead?.source ?? '',
    related_campaign: lead?.related_campaign ?? '',
    content_item_id: lead?.content_item_id ?? '',
    stage: (lead?.stage ?? 'new_contact') as LeadStage,
    follow_up_mode: (lead?.follow_up_mode ?? 'auto') as FollowUpMode,
    relationship: lead?.relationship ?? '',
    current_status: lead?.current_status ?? '',
    preferred_channel: lead?.preferred_channel ?? '',
    next_action: lead?.next_action ?? '',
    next_action_date: lead?.next_action_date ?? '',
    proposed_value: metricToInput(lead?.proposed_value ?? null),
    closed_value: metricToInput(lead?.closed_value ?? null),
    attribution_note: lead?.attribution_note ?? '',
    notes: lead?.notes ?? '',
    first_contact_at: lead?.first_contact_at ?? today(),
  });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const isClosed = form.stage === 'won' || form.stage === 'lost';

  async function save() {
    if (!form.prospect_name.trim()) {
      setProblem('Who is this? Put in a name so you can find them again.');
      return;
    }
    setSaving(true);
    setProblem(null);

    const payload = {
      content_item_id: blank(form.content_item_id),
      prospect_name: form.prospect_name.trim(),
      organization: blank(form.organization),
      email: blank(form.email),
      phone: blank(form.phone),
      project: blank(form.project),
      source: blank(form.source),
      related_campaign: blank(form.related_campaign),
      stage: form.stage,
      follow_up_mode: form.follow_up_mode,
      relationship: blank(form.relationship),
      current_status: blank(form.current_status),
      preferred_channel: blank(form.preferred_channel),
      next_action: blank(form.next_action),
      next_action_date: blank(form.next_action_date),
      proposed_value: parseMetricInput(form.proposed_value),
      closed_value: isClosed ? parseMetricInput(form.closed_value) : null,
      attribution_note: blank(form.attribution_note),
      notes: blank(form.notes),
      first_contact_at: blank(form.first_contact_at),
      closed_at: isClosed ? (lead?.closed_at ?? today()) : null,
      /* Carried through untouched. The mirror owns the key, and a date the mirror
       * reported is evidence somebody else recorded: neither is this form's to
       * change, and dropping them would orphan a lead from its own history. */
      external_source: lead?.external_source ?? null,
      external_key: lead?.external_key ?? null,
      record_confidence: lead?.record_confidence ?? null,
      reported_last_touch_at: lead?.reported_last_touch_at ?? null,
      is_seed: lead?.is_seed ?? false,
    };

    try {
      if (lead) await update('leads', lead.id, payload);
      else await insert('leads', payload);
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Drawer title={lead ? form.prospect_name || 'Edit lead' : 'New lead'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Prospect">
          <input
            type="text"
            value={form.prospect_name}
            onChange={(e) => set('prospect_name', e.target.value)}
          />
        </Field>
        <Field label="Organization">
          <input
            type="text"
            value={form.organization}
            onChange={(e) => set('organization', e.target.value)}
          />
        </Field>
        <Field label="Email">
          <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Phone">
          <input type="text" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Project" span>
          <input type="text" value={form.project} onChange={(e) => set('project', e.target.value)} />
        </Field>
        <Field label="Stage">
          <select value={form.stage} onChange={(e) => set('stage', e.target.value as LeadStage)}>
            {STAGE_ORDER.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="First contact">
          <input
            type="date"
            value={form.first_contact_at}
            onChange={(e) => set('first_contact_at', e.target.value)}
          />
        </Field>
        <Field
          label="Relationship"
          hint="In your own words. Prospect, existing client, referral partner, somebody you met once."
        >
          <input
            type="text"
            value={form.relationship}
            onChange={(e) => set('relationship', e.target.value)}
          />
        </Field>
        <Field label="Best way to reach them" hint="Email, phone, WhatsApp, LinkedIn.">
          <input
            type="text"
            value={form.preferred_channel}
            onChange={(e) => set('preferred_channel', e.target.value)}
          />
        </Field>
        <Field
          label="Where things stand"
          span
          hint="One line on what is actually happening right now, so you do not have to reread the notes."
        >
          <input
            type="text"
            value={form.current_status}
            onChange={(e) => set('current_status', e.target.value)}
            placeholder="Waiting on their logo files"
          />
        </Field>
      </div>

      <div className="fieldset-legend">Where it came from</div>
      <Notice>
        Only link a post here if you actually know that is where they came from. If they
        told you, great. If you are guessing, leave it blank. An honest "we do not know" is
        far more useful later than a guess you will have forgotten making.
      </Notice>
      <div className="form-grid">
        <Field label="How they found you" hint="Referral, Instagram, Google, word of mouth, whatever they told you.">
          <input type="text" value={form.source} onChange={(e) => set('source', e.target.value)} />
        </Field>
        <Field label="Related campaign">
          <input
            type="text"
            value={form.related_campaign}
            onChange={(e) => set('related_campaign', e.target.value)}
          />
        </Field>
        <Field label="Related content" span>
          <select
            value={form.content_item_id}
            onChange={(e) => set('content_item_id', e.target.value)}
          >
            <option value="">I do not know</option>
            {data.contentItems.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="How do you know" span hint="What actually connects this person to that post? Write down the evidence.">
          <input
            type="text"
            value={form.attribution_note}
            onChange={(e) => set('attribution_note', e.target.value)}
            placeholder="They mentioned the story in the first call"
          />
        </Field>
      </div>

      <div className="fieldset-legend">Next action and value</div>
      <Notice>
        Normally you do not set the follow-up date by hand. Logging a contact on the
        Activity screen moves it forward on its own, by the rhythm for this stage, and
        reuses the one open follow-up rather than adding another. Set the follow-up below
        to <strong>{FOLLOW_UP_MODE_LABELS.none.toLowerCase()}</strong>,{' '}
        <strong>{FOLLOW_UP_MODE_LABELS.hold.toLowerCase()}</strong> or{' '}
        <strong>{FOLLOW_UP_MODE_LABELS.archived.toLowerCase()}</strong> and the app stops
        chasing, and stops putting them on the Today screen, without forgetting them.
      </Notice>
      <div className="form-grid">
        <Field
          label="Follow-up"
          span
          hint="A deliberate decision. Nothing the app works out from dates can override it."
        >
          <select
            value={form.follow_up_mode}
            onChange={(e) => set('follow_up_mode', e.target.value as FollowUpMode)}
          >
            {FOLLOW_UP_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {FOLLOW_UP_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Next action">
          <input
            type="text"
            value={form.next_action}
            onChange={(e) => set('next_action', e.target.value)}
          />
        </Field>
        <Field label="Follow-up date">
          <input
            type="date"
            value={form.next_action_date}
            onChange={(e) => set('next_action_date', e.target.value)}
          />
        </Field>
        <Field label="Quoted value" hint="Leave blank until you have actually put a number in front of them.">
          <input
            type="text"
            inputMode="decimal"
            value={form.proposed_value}
            placeholder="Leave blank until you have quoted"
            onChange={(e) => set('proposed_value', e.target.value)}
          />
        </Field>
        {isClosed ? (
          <Field label="Closed value">
            <input
              type="text"
              inputMode="decimal"
              value={form.closed_value}
              placeholder="What it actually closed for"
              onChange={(e) => set('closed_value', e.target.value)}
            />
          </Field>
        ) : null}
        <Field label="Notes" span>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>

      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      <div className="form-actions">
        {lead ? (
          <button
            className="btn btn-quiet btn-danger"
            onClick={async () => {
              if (confirm(`Delete ${lead.prospect_name}?`)) {
                await remove('leads', lead.id);
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
          {saving ? 'Saving…' : 'Save lead'}
        </button>
      </div>
    </Drawer>
  );
}
