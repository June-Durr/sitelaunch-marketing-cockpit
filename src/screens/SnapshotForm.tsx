import { useState } from 'react';
import { useData } from '../data/context';
import { Drawer } from '../components/Drawer';
import { Field, Notice } from '../components/primitives';
import { metricToInput, parseMetricInput } from '../lib/format';
import { fromLocalInput, toLocalInput } from '../lib/dates';
import type {
  ContentItem, MetricKey, PerformanceSnapshot, SnapshotMetrics, SnapshotWindow,
} from '../types/domain';
import {
  METRIC_GROUPS, METRIC_GUIDE, METRIC_KEYS, METRIC_LABELS, WINDOW_LABELS,
} from '../types/domain';

const WINDOWS = Object.keys(WINDOW_LABELS) as SnapshotWindow[];

/**
 * Metric entry.
 *
 * Every box starts empty and stays empty unless someone types in it. A number box
 * sitting at 0 would quietly turn "I did not check" into "it was zero", which is the
 * single mistake this whole tool exists to prevent.
 *
 * Each field carries a short explanation of what the number is and why it matters,
 * always on screen, so someone who does not know marketing can fill this in properly.
 */
export function SnapshotForm({
  item,
  snapshot,
  defaultWindow,
  onClose,
}: {
  item: ContentItem;
  snapshot: PerformanceSnapshot | null;
  defaultWindow?: SnapshotWindow;
  onClose: () => void;
}) {
  const { insert, update } = useData();

  const [windowType, setWindowType] = useState<SnapshotWindow>(
    snapshot?.window_type ?? defaultWindow ?? '24h',
  );
  const [capturedAt, setCapturedAt] = useState(
    toLocalInput(snapshot?.captured_at ?? new Date().toISOString()),
  );
  const [unavailable, setUnavailable] = useState(snapshot?.metrics_unavailable ?? false);
  const [reason, setReason] = useState(snapshot?.unavailable_reason ?? '');
  const [notes, setNotes] = useState(snapshot?.notes ?? '');
  const [values, setValues] = useState<Record<MetricKey, string>>(() => {
    const seed = {} as Record<MetricKey, string>;
    for (const key of METRIC_KEYS) seed[key] = metricToInput(snapshot?.[key] ?? null);
    return seed;
  });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const recorded = METRIC_KEYS.filter((k) => values[k].trim() !== '').length;

  async function save() {
    setSaving(true);
    setProblem(null);

    const metrics = {} as SnapshotMetrics;
    for (const key of METRIC_KEYS) {
      metrics[key] = unavailable ? null : parseMetricInput(values[key]);
    }

    const payload = {
      ...metrics,
      content_item_id: item.id,
      window_type: windowType,
      captured_at: fromLocalInput(capturedAt) ?? new Date().toISOString(),
      metrics_unavailable: unavailable,
      unavailable_reason: unavailable ? reason.trim() || null : null,
      ingest_source: 'manual' as const,
      notes: notes.trim() || null,
      is_seed: snapshot?.is_seed ?? false,
    };

    try {
      if (snapshot) {
        await update('performance_snapshots', snapshot.id, payload);
      } else {
        await insert('performance_snapshots', payload);
        // A recorded snapshot closes the matching measurement check.
        if (item.status === 'published') {
          await update('content_items', item.id, { status: 'measured' });
        }
      }
      onClose();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <Drawer
      title={snapshot ? 'Edit these numbers' : `Write down numbers for ${item.title}`}
      onClose={onClose}
    >
      <div className="form-grid">
        <Field
          label="When are you measuring"
          hint="Pick the point in time these numbers are from, so like is compared with like later."
        >
          <select
            value={windowType}
            onChange={(e) => setWindowType(e.target.value as SnapshotWindow)}
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {WINDOW_LABELS[w]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="When you read them" hint="The moment you actually looked at the platform.">
          <input
            type="datetime-local"
            value={capturedAt}
            onChange={(e) => setCapturedAt(e.target.value)}
          />
        </Field>
      </div>

      <label className="checkbox-row" style={{ marginTop: '1.25rem' }}>
        <input
          type="checkbox"
          checked={unavailable}
          onChange={(e) => setUnavailable(e.target.checked)}
        />
        <span>
          The platform does not give me any numbers for this one
          <br />
          <span className="field-hint">
            This is different from leaving the boxes blank. Blank means you have not
            looked yet and still could. This means there is nothing to go and look at,
            so the app will stop asking.
          </span>
        </span>
      </label>

      {unavailable ? (
        <div style={{ marginTop: '1rem' }}>
          <Field label="Why not" hint="Worth writing down so future you does not go hunting for it again.">
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Facebook does not show numbers for stories shared from Instagram."
            />
          </Field>
        </div>
      ) : (
        <>
          <Notice>
            Only fill in what you actually looked at. Anything you leave blank stays
            blank everywhere in the app and is kept out of every average. It never turns
            into a zero. Type 0 only when the platform really did report nothing.
          </Notice>

          {METRIC_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="fieldset-legend">{group.title}</div>
              <p className="group-blurb">{group.blurb}</p>
              <div className="form-grid">
                {group.keys.map((key) => (
                  <Field
                    key={key}
                    label={METRIC_LABELS[key]}
                    hint={
                      <>
                        {METRIC_GUIDE[key].what}
                        <br />
                        <em>{METRIC_GUIDE[key].why}</em>
                      </>
                    }
                  >
                    <input
                      type="text"
                      inputMode="decimal"
                      value={values[key]}
                      placeholder="Leave blank"
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [key]: e.target.value }))
                      }
                    />
                  </Field>
                ))}
              </div>
            </div>
          ))}

          <p className="field-hint" style={{ marginTop: '1rem' }}>
            You have filled in {recorded} of {METRIC_KEYS.length}. The rest will be saved
            as not checked, which is exactly what you want if you did not look at them.
          </p>
        </>
      )}

      <div className="form-grid" style={{ marginTop: '1.5rem' }}>
        <Field label="Notes" span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>

      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      <div className="form-actions">
        <button className="btn" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save these numbers'}
        </button>
      </div>
    </Drawer>
  );
}
