/**
 * The group and card shells that give Data & Import its shape.
 *
 * THE PROBLEM THESE SOLVE
 *
 * Every section of that screen used to look the same: one heading weight, one
 * body size, and a paragraph of explanation before anything you could act on.
 * Finding the calendar meant reading until you hit it. These give the page three
 * distinct levels instead of one, so the eye can skip two of them:
 *
 *   Group    a band with its own heading and background, one per topic
 *   Card     one service, its state and its primary action, scannable
 *   Details  the explanation, folded away until somebody wants it
 *
 * WHAT STAYS VISIBLE
 *
 * State and action. A card never hides whether a thing is connected or what you
 * can do about it, because that is the whole reason to look at the page. What
 * folds away is prose: the paragraphs about why a sync is idempotent or which
 * calendar gets written to, which are worth having and are not worth reading
 * twice a day.
 */

import { useId, type ReactNode } from 'react';
import type { IconComponent } from './icons';
import { IconTile } from './icons';

/* ------------------------------------------------------------------ group --- */

export function DataGroup({
  id,
  title,
  lede,
  Icon,
  tone = 'plain',
  children,
}: {
  /** Also the scroll target for the section navigator. Unique per page. */
  id: string;
  title: string;
  lede?: ReactNode;
  Icon?: IconComponent;
  /** 'sunk' gives the band a tinted background, to separate it from its neighbours. */
  tone?: 'plain' | 'sunk';
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      // tabIndex -1 so the section navigator can move focus here. Without it
      // scrollIntoView moves the viewport and leaves the keyboard behind.
      tabIndex={-1}
      className={`data-group data-group-${tone}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="data-group-head">
        {Icon ? (
          <IconTile size="sm">
            <Icon size={18} />
          </IconTile>
        ) : null}
        <div>
          <h2 className="data-group-title" id={`${id}-title`}>
            {title}
          </h2>
          {lede ? <p className="data-group-lede">{lede}</p> : null}
        </div>
      </div>
      <div className="data-group-body">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- card --- */

export interface CardMeta {
  label: string;
  value: ReactNode;
}

export function IntegrationCard({
  Icon,
  title,
  purpose,
  chip,
  meta = [],
  action,
  error,
  details,
  children,
}: {
  Icon: IconComponent;
  title: string;
  /** One short sentence. Anything longer belongs in details. */
  purpose: ReactNode;
  /** The state chip. Words, never colour alone. */
  chip?: ReactNode;
  /** Identifier, last successful sync, next scheduled, and so on. */
  meta?: CardMeta[];
  action?: ReactNode;
  /** Rendered only when something is really wrong. Never a placeholder. */
  error?: ReactNode;
  /** Folded away. The explanations, not the status. */
  details?: ReactNode;
  /** Anything that has to sit in the open, such as a form. */
  children?: ReactNode;
}) {
  return (
    <article className="int-card">
      <div className="int-card-top">
        <IconTile>
          <Icon size={26} />
        </IconTile>

        <div className="int-card-headings">
          <h3 className="int-card-title">{title}</h3>
          <p className="int-card-purpose">{purpose}</p>
        </div>

        {chip ? <div className="int-card-chip">{chip}</div> : null}
      </div>

      {meta.length > 0 ? (
        <dl className="int-card-meta">
          {meta.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {children}

      {/* Only when there is a real failure. An empty slot here would train
          somebody to ignore the one place errors appear. */}
      {error ? <p className="notice notice-crimson int-card-error">{error}</p> : null}

      {action ? <div className="int-card-actions">{action}</div> : null}

      {details ? <Details>{details}</Details> : null}
    </article>
  );
}

/* ---------------------------------------------------------------- details --- */

/**
 * A disclosure, built on the native element.
 *
 * <details> is keyboard operable, announced correctly, findable by the browser's
 * own in-page search in current browsers, and works before any JavaScript runs.
 * A hand-rolled one with a button and some state is more code and less of all
 * four of those things.
 */
export function Details({
  summary = 'Details',
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <details className="int-details">
      <summary className="int-details-summary" aria-describedby={id}>
        <span>{summary}</span>
        <svg
          className="int-details-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          aria-hidden
          focusable="false"
        >
          <path
            d="M6 9.5l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="int-details-body" id={id}>
        {children}
      </div>
    </details>
  );
}
