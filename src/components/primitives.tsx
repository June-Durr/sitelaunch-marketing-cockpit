import type { ReactNode } from 'react';
import { NOT_CHECKED, NOT_CHECKED_LONG, formatCurrency, formatMean, formatNumber } from '../lib/format';

/* ---------------------------------------------------------------- values -- */

/**
 * A number somebody actually read off a platform.
 *
 * When there is no number, the app says so in words rather than showing a dash or a
 * zero. A zero would be a lie: it would claim the platform reported nothing happened,
 * when the truth is that nobody looked.
 */
export function Observed({
  value,
  format = 'number',
  long = false,
}: {
  value: number | null | undefined;
  format?: 'number' | 'currency';
  /** Use the fuller wording where there is room, such as a detail panel. */
  long?: boolean;
}) {
  if (value === null || value === undefined) {
    return (
      <span className="v-absent" title="This is not a zero. Nobody has recorded a number here.">
        {long ? NOT_CHECKED_LONG : NOT_CHECKED}
      </span>
    );
  }
  return (
    <span className="v-observed">
      {format === 'currency' ? formatCurrency(value) : formatNumber(value)}
    </span>
  );
}

/** A number the app worked out. Styled differently on purpose, so you can tell. */
export function Derived({
  value,
  suffix,
  title,
}: {
  value: number | null | undefined;
  suffix?: string;
  title?: string;
}) {
  return (
    <span className="v-derived" title={title ?? 'The app worked this out. Nobody read it off a platform.'}>
      {formatMean(value)}
      {value !== null && value !== undefined && suffix ? ` ${suffix}` : ''}
    </span>
  );
}

/**
 * The platform does not share this number at all. Different from nobody checking:
 * there is nothing to go and look at, so it will never be filled in.
 */
export function Unavailable({ reason, short = false }: { reason?: string | null; short?: boolean }) {
  return (
    <span className="v-unavailable" title={reason ?? 'The platform does not share this number.'}>
      {short ? 'Not shared' : 'The platform does not share this'}
    </span>
  );
}

/** We genuinely do not know, and guessing would be worse than saying so. */
export function Unknown({ note, label = 'Not known' }: { note?: string; label?: string }) {
  return (
    <span className="v-absent" title={note ?? 'We do not know, and a guess would be worse than saying so.'}>
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ tags -- */

export function Tag({
  children,
  tone = 'default',
  title,
}: {
  children: ReactNode;
  tone?: 'default' | 'violet' | 'amber' | 'crimson' | 'quiet';
  title?: string;
}) {
  const cls = tone === 'default' ? 'tag' : `tag tag-${tone}`;
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function AmplifiedTag({ amplifier }: { amplifier: string | null }) {
  return (
    <Tag
      tone="amber"
      title={`Boosted by ${amplifier ?? 'another account'}, so it is kept out of the averages. Its reach was not earned by the post itself.`}
    >
      Boosted
    </Tag>
  );
}

/* ------------------------------------------------------------- structure -- */

export function Section({
  title,
  note,
  action,
  children,
}: {
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        {action ?? (note ? <span className="section-note">{note}</span> : null)}
      </div>
      {children}
    </section>
  );
}

export function PageHead({
  kicker,
  title,
  lede,
  action,
}: {
  kicker: string;
  title: string;
  lede?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-row">
        <div>
          <p className="page-kicker">{kicker}</p>
          <h1 className="page-title">{title}</h1>
        </div>
        {action}
      </div>
      {lede ? <p className="page-lede">{lede}</p> : null}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Notice({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'violet' | 'amber' | 'crimson';
  children: ReactNode;
}) {
  const cls = tone === 'default' ? 'notice' : `notice notice-${tone}`;
  return <p className={cls}>{children}</p>;
}

/* ----------------------------------------------------------------- form --- */

export function Field({
  label,
  hint,
  span,
  children,
}: {
  label: string;
  hint?: ReactNode;
  span?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={span ? 'field span-2' : 'field'}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Stat({
  value,
  label,
  note,
}: {
  value: ReactNode;
  label: string;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <div className="stat-label">{label}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

/**
 * How to read the numbers on this page. Always on screen, because the difference
 * between these four states is the difference between a real answer and a guess.
 */
export function DataLegend() {
  return (
    <div className="legend">
      <span className="legend-item">
        <span className="v-observed">31</span> a real number, read off the platform
      </span>
      <span className="legend-item">
        <span className="v-derived">15.5</span> worked out by this app
      </span>
      <span className="legend-item">
        <span className="v-absent">{NOT_CHECKED}</span> nobody looked yet, which is not the same as zero
      </span>
      <span className="legend-item">
        <span className="v-unavailable">Not shared</span> the platform never gives you this one
      </span>
    </div>
  );
}
