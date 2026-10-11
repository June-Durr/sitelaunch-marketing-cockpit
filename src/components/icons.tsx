/**
 * Every icon in the app, drawn here rather than fetched or installed.
 *
 * WHY LOCAL SVG AND NOT A PACKAGE
 *
 * There is no icon package in this project's dependencies, and adding one to get
 * fourteen glyphs would ship a few thousand we never render. These are plain
 * components: they inline into the bundle, cost nothing at runtime, and cannot
 * fail to load the way a hotlinked image can. Nothing here reaches the network.
 *
 * WHY THE PRODUCT MARKS ARE DRAWN RATHER THAN COPIED
 *
 * These are recognisable marks in each product's own geometry and colours, not
 * the trademarked artwork. That is deliberate: it keeps the repository free of
 * other companies' asset files while still letting somebody scanning the page
 * pick out Analytics from Search Console without reading either label.
 *
 * ACCESSIBILITY, AND THE ONE RULE THAT MATTERS MOST
 *
 * Every icon here sits beside visible text, so every icon here is decorative and
 * carries aria-hidden. A screen reader announces the heading, not the picture.
 * An icon-only control must pass a `label`, which turns the svg into an img with
 * a title; there is one such control in this file's consumers and it does.
 *
 * Colour is never the only signal. The marks are coloured because that is what
 * makes them recognisable at a glance, but what a connection is *doing* is said
 * in words on a status chip. Somebody who cannot tell violet from amber still
 * reads "Connected" or "Attention".
 */

import type { ReactNode } from 'react';

export interface IconProps {
  /** Pixel size, square. Defaults to the inline text size. */
  size?: number;
  /**
   * An accessible name, for an icon that is the whole control.
   *
   * Leaving it out is the normal case and marks the icon decorative. Passing it
   * is a claim that there is no visible text saying the same thing.
   */
  label?: string;
  className?: string;
}

/** Shared wrapper, so the accessibility decision is made in exactly one place. */
function Svg({
  size = 20,
  label,
  className,
  viewBox = '0 0 24 24',
  children,
}: IconProps & { viewBox?: string; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      className={className}
      // Decorative unless somebody passes a label. A title with no role would be
      // announced by some readers and not others, which is worse than silence.
      {...(label
        ? { role: 'img', 'aria-label': label }
        : { 'aria-hidden': true, focusable: false })}
    >
      {label ? <title>{label}</title> : null}
      {children}
    </svg>
  );
}

/* ====================================================== Google products === */

/** Analytics: the ascending bars, in Google's analytics orange and yellow. */
export function Ga4Icon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="13" width="4.5" height="8" rx="2.25" fill="#F9AB00" />
      <rect x="9.75" y="8" width="4.5" height="13" rx="2.25" fill="#E37400" />
      <rect x="16.5" y="3" width="4.5" height="18" rx="2.25" fill="#E37400" opacity="0.72" />
    </Svg>
  );
}

/** Search Console: a magnifier over a baseline, in Google blue. */
export function SearchConsoleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="#4285F4" strokeWidth="2.1" />
      <path d="M15 15l5.2 5.2" stroke="#1A73E8" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M7.4 11.6l2.1-2.4 2 2 2.3-2.8" fill="none" stroke="#34A853"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Sheets: the folded document with its rule lines, in Sheets green. */
export function SheetsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 2.5h7.5L19 8v12.2a1.3 1.3 0 0 1-1.3 1.3H6a1.3 1.3 0 0 1-1.3-1.3V3.8A1.3 1.3 0 0 1 6 2.5z"
        fill="#0F9D58" />
      <path d="M13.5 2.5L19 8h-4.6a.9.9 0 0 1-.9-.9z" fill="#0B7C46" />
      <path d="M8 11.4h8v7H8z" fill="#fff" />
      <path d="M8 13.6h8M8 16.2h8M11.4 11.4v7" stroke="#0F9D58" strokeWidth="1" />
    </Svg>
  );
}

/** Calendar: the Google Calendar plate, with the date block left blank. */
export function GoogleCalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="16" rx="2.2" fill="#fff" stroke="#4285F4" strokeWidth="1.6" />
      <path d="M3.5 8.4h17" stroke="#4285F4" strokeWidth="1.6" />
      <rect x="3.5" y="4.5" width="17" height="4" rx="2.2" fill="#4285F4" />
      <path d="M8 2.6v3.2M16 2.6v3.2" stroke="#1A73E8" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="7" y="11" width="4" height="4" rx="0.7" fill="#EA4335" />
      <rect x="13" y="11" width="4" height="4" rx="0.7" fill="#9AA0A6" opacity="0.5" />
      <rect x="7" y="16.4" width="4" height="2.6" rx="0.7" fill="#9AA0A6" opacity="0.5" />
    </Svg>
  );
}

/* ================================================= Cockpit's own things === */

/**
 * The follow-up queue, deliberately NOT the Google Calendar mark.
 *
 * They are related and different: the queue is what the Cockpit's own rules
 * decided, and Google Calendar is one of the places that decision gets written
 * to. Giving the queue Google's logo would say the follow-ups come from Google,
 * which is backwards.
 */
export function FollowUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.6" width="17" height="15.9" rx="2.4" fill="none"
        stroke="currentColor" strokeWidth="1.7" opacity="0.85" />
      <path d="M3.5 9h17" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <path d="M8 2.8v3.3M16 2.8v3.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M8.3 14.6l2.4 2.4 5-5.3" fill="none" stroke="currentColor"
        strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Website enquiry forms: a form with a line of entry and a send mark. */
export function WebsiteFormsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.4" fill="none"
        stroke="currentColor" strokeWidth="1.7" />
      <path d="M7.2 8.4h9.6M7.2 12h6.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M7.2 15.8h3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      <path d="M13.6 17.4l5-2.2-5-2.2v1.7l2.4.5-2.4.5z" fill="currentColor" />
    </Svg>
  );
}

/** CSV and typed-in rows: a sheet with a cursor, the deliberate fallback. */
export function ManualImportIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 2.8h7.2L18.6 8v13.2H6z" fill="none" stroke="currentColor" strokeWidth="1.7"
        strokeLinejoin="round" />
      <path d="M13.2 2.8V8h5.4" fill="none" stroke="currentColor" strokeWidth="1.7"
        strokeLinejoin="round" />
      <path d="M8.6 12.4h7M8.6 15.4h4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15.4 17l2.8 2.8M18.2 17l-2.8 2.8" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" opacity="0.6" />
    </Svg>
  );
}

/** Backup and restore: a box with an arrow going both ways. */
export function BackupIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.4 7.4h17.2v12a1.4 1.4 0 0 1-1.4 1.4H4.8a1.4 1.4 0 0 1-1.4-1.4z"
        fill="none" stroke="currentColor" strokeWidth="1.7" />
      <rect x="2.6" y="3.4" width="18.8" height="4" rx="1.3" fill="none"
        stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 10.6v7.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9.2 15.2L12 18l2.8-2.8" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Accounts: the handles a post can go out under. */
export function AccountsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9.2" cy="8.6" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3 20.2c0-3.4 2.8-5.6 6.2-5.6s6.2 2.2 6.2 5.6" fill="none"
        stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M16.4 5.6a3.4 3.4 0 0 1 0 6.4" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" opacity="0.62" />
      <path d="M17.6 14.9c2.1.6 3.6 2.4 3.6 5.3" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" opacity="0.62" />
    </Svg>
  );
}

/** The 90-day program: a dial part way round. */
export function ProgramIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="1.7" opacity="0.32" />
      <path d="M12 3.6a8.4 8.4 0 0 1 7.3 12.6" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" />
      <path d="M12 7.4V12l3 1.8" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/* ========================================================= social marks === */

export function InstagramIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="5" fill="none"
        stroke="#C13584" strokeWidth="1.9" />
      <circle cx="12" cy="12" r="4.1" fill="none" stroke="#E1306C" strokeWidth="1.9" />
      <circle cx="17.1" cy="6.9" r="1.25" fill="#F56040" />
    </Svg>
  );
}

export function FacebookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9.2" fill="#1877F2" />
      <path d="M13.6 21.1v-7.3h2.5l.4-2.9h-2.9V9.1c0-.8.3-1.4 1.5-1.4h1.5V5.1a19 19 0 0 0-2.3-.1c-2.3 0-3.9 1.4-3.9 4v2h-2.5v2.9h2.5v7.2z"
        fill="#fff" />
    </Svg>
  );
}

export function LinkedInIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2.6" fill="#0A66C2" />
      <path d="M7.9 9.9v7.4H5.6V9.9zM6.75 6.3a1.35 1.35 0 1 1 0 2.7 1.35 1.35 0 0 1 0-2.7zM10 9.9h2.2v1c.3-.6 1.1-1.2 2.3-1.2 2.1 0 2.9 1.3 2.9 3.4v4.2H15v-3.8c0-1-.4-1.6-1.3-1.6s-1.5.6-1.5 1.6v3.8H10z"
        fill="#fff" />
    </Svg>
  );
}

export function TikTokIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.1 3h2.6c.2 1.9 1.4 3.4 3.3 3.7v2.6a6.4 6.4 0 0 1-3.3-1.1v5.9a5.4 5.4 0 1 1-5.4-5.4c.3 0 .5 0 .8.1v2.7a2.8 2.8 0 1 0 2 2.7z"
        fill="#010101" />
      <path d="M13.1 2.4h2.6c.2 1.9 1.4 3.4 3.3 3.7v2.6a6.4 6.4 0 0 1-3.3-1.1v5.9a5.4 5.4 0 1 1-5.4-5.4c.3 0 .5 0 .8.1v2.7a2.8 2.8 0 1 0 2 2.7z"
        fill="#25F4EE" opacity="0.85" />
      <path d="M13.6 2.7h2.6c.2 1.9 1.4 3.4 3.3 3.7v2.6a6.4 6.4 0 0 1-3.3-1.1v5.9a5.4 5.4 0 1 1-5.4-5.4c.3 0 .5 0 .8.1v2.7a2.8 2.8 0 1 0 2 2.7z"
        fill="#FE2C55" opacity="0.8" />
      <path d="M14.1 3h2.6c.2 1.9 1.4 3.4 3.3 3.7v2.6a6.4 6.4 0 0 1-3.3-1.1v5.9a5.4 5.4 0 1 1-5.4-5.4c.3 0 .5 0 .8.1v2.7a2.8 2.8 0 1 0 2 2.7z"
        fill="#010101" opacity="0.92" />
    </Svg>
  );
}

/* ======================================================== navigation set === */

export function TodayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 6.9V12l3.4 2" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ContentIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.2" fill="none"
        stroke="currentColor" strokeWidth="1.7" />
      <path d="M7 9h6M7 12.6h10M7 16.2h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </Svg>
  );
}

export function WebsiteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 12h17" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3.4c2.4 2.4 3.6 5.4 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.4-3.6-8.6S9.6 5.8 12 3.4z"
        fill="none" stroke="currentColor" strokeWidth="1.5" />
    </Svg>
  );
}

export function PipelineIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.2" y="4.2" width="4.6" height="15.6" rx="1.4" fill="none"
        stroke="currentColor" strokeWidth="1.7" />
      <rect x="9.7" y="4.2" width="4.6" height="11" rx="1.4" fill="none"
        stroke="currentColor" strokeWidth="1.7" />
      <rect x="16.2" y="4.2" width="4.6" height="7" rx="1.4" fill="none"
        stroke="currentColor" strokeWidth="1.7" />
    </Svg>
  );
}

export function TasksIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.4 7l2.2 2.2L9.4 5" fill="none" stroke="currentColor" strokeWidth="1.9"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.4 16.4l2.2 2.2 3.8-4.2" fill="none" stroke="currentColor" strokeWidth="1.9"
        strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.4 7.4h8.2M12.4 16.8h8.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </Svg>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.2 12.4h4l2.4-6.2 3.4 11.6 2.6-5.4h5.2" fill="none" stroke="currentColor"
        strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function RecommendationsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.4 18.4h5.2M10.2 21h3.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 2.8a6.2 6.2 0 0 1 3.7 11.2c-.5.4-.8 1-.8 1.6H9.1c0-.6-.3-1.2-.8-1.6A6.2 6.2 0 0 1 12 2.8z"
        fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </Svg>
  );
}

export function DataIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <ellipse cx="12" cy="6.2" rx="7.8" ry="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M4.2 6.2v5.6c0 1.8 3.5 3.2 7.8 3.2s7.8-1.4 7.8-3.2V6.2" fill="none"
        stroke="currentColor" strokeWidth="1.7" />
      <path d="M4.2 11.8v5.6c0 1.8 3.5 3.2 7.8 3.2s7.8-1.4 7.8-3.2v-5.6" fill="none"
        stroke="currentColor" strokeWidth="1.7" />
    </Svg>
  );
}

/* ========================================================= jump-to marks === */

/** The group marks used by the section navigator. Line art, not product marks. */
export function AnalyticsGroupIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.6 19.4h16.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6.8 19.4v-5.6M11.4 19.4V8.6M16 19.4v-8.2" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" />
    </Svg>
  );
}

export function LeadsGroupIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.2" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.2 20.2c0-3.6 3-6 6.8-6s6.8 2.4 6.8 6" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

export function SocialGroupIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6.4" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="6.4" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="17.6" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.9 10.7l5.6-2.9M8.9 13.3l5.6 2.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </Svg>
  );
}

export function SettingsGroupIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5"
        stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </Svg>
  );
}

/* =============================================================== plumbing === */

export type IconComponent = (props: IconProps) => ReactNode;

/**
 * A tinted plate behind an icon.
 *
 * It does two things: it gives every card the same optical weight at the left
 * edge whatever shape its mark happens to be, and it keeps a coloured product
 * mark legible against the ivory page. The tint is a neutral wash in every case,
 * never a state colour, because a container that turned red would be using
 * colour to say something the status chip is already saying in words.
 */
export function IconTile({
  children,
  size = 'md',
}: {
  children: ReactNode;
  size?: 'sm' | 'md';
}) {
  return <span className={`icon-tile icon-tile-${size}`}>{children}</span>;
}
