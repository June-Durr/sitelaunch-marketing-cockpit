import { useState } from 'react';
import { Field, Notice, Section } from '../components/primitives';
import { readSettings, writeSettings } from '../data/settings';
import {
  DEFAULT_PROGRAM, PROGRAM_PHASES, programLength, programPosition, validateProgram,
  type ProgramConfig,
} from '../config/program';
import { formatDay, today } from '../lib/dates';

/**
 * The editable program.
 *
 * Changing these dates changes what every figure on the Today screen counts, so
 * the panel shows the effect before you save and refuses a target that lands on
 * or before the start.
 */
export function ProgramPanel({ onSaved }: { onSaved?: () => void }) {
  const [form, setForm] = useState<ProgramConfig>(() => readSettings().program);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const set = <K extends keyof ProgramConfig>(k: K, v: ProgramConfig[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
    setProblem(null);
  };

  const valid = validateProgram(form) === null;
  const preview = valid ? programPosition(today(), form) : null;

  function save() {
    const reason = validateProgram(form);
    if (reason) {
      setProblem(reason);
      return;
    }
    writeSettings({ ...readSettings(), program: form });
    setSaved(true);
    onSaved?.();
  }

  return (
    <Section title="The program" note={valid ? `${programLength(form)} days` : undefined}>
      <p className="page-lede" style={{ marginTop: 0 }}>
        Every figure on the Today screen is counted against these dates. It is a fixed run,
        not a rolling window, so a number here can only move because something actually
        happened, never because a day went by.
      </p>

      <div className="form-grid" style={{ maxWidth: '44rem' }}>
        <Field label="Program name" span>
          <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Start date" hint="This is Day 1, not Day 0.">
          <input
            type="date"
            value={form.startDate}
            onChange={(e) => set('startDate', e.target.value)}
          />
        </Field>
        <Field label="Target date" hint="The review date. Counted as part of the program.">
          <input
            type="date"
            value={form.targetDate}
            onChange={(e) => set('targetDate', e.target.value)}
          />
        </Field>
        <Field
          label="What it is meant to produce"
          span
          hint="Optional. Written at the top of the Today screen as a reminder of the point."
        >
          <textarea
            value={form.goal ?? ''}
            onChange={(e) => set('goal', e.target.value.trim() ? e.target.value : null)}
          />
        </Field>
      </div>

      {preview ? (
        <p className="notice notice-violet">
          As things stand, today is{' '}
          {preview.status === 'before'
            ? `${preview.daysUntilStart} days before the program starts`
            : `Day ${preview.day} of ${preview.totalDays}`}
          , running {formatDay(preview.startDate)} to {formatDay(preview.targetDate)}.
        </p>
      ) : null}

      {problem ? <p className="notice notice-crimson">{problem}</p> : null}
      {saved ? <p className="notice notice-violet">Saved. The Today screen now counts against these dates.</p> : null}

      <div className="btn-row" style={{ marginTop: '0.5rem' }}>
        <button className="btn btn-primary" onClick={save}>
          Save the program
        </button>
        <button
          className="btn"
          onClick={() => {
            setForm(DEFAULT_PROGRAM);
            setSaved(false);
            setProblem(null);
          }}
        >
          Back to the agreed dates
        </button>
      </div>

      <div className="fieldset-legend">The three phases</div>
      <Notice>
        Phases are fixed against the agreed plan rather than worked out from your dates, so
        changing the start above does not silently move them.
      </Notice>
      <table className="data">
        <thead>
          <tr>
            <th>Phase</th>
            <th>What it is for</th>
            <th>Runs</th>
          </tr>
        </thead>
        <tbody>
          {PROGRAM_PHASES.map((phase) => (
            <tr key={phase.number}>
              <td data-label="Phase">Phase {phase.number}</td>
              <td data-label="What it is for">{phase.name}</td>
              <td data-label="Runs">
                {formatDay(phase.start)} to {formatDay(phase.end)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
