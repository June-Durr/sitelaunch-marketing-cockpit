/**
 * Display formatting.
 *
 * The central rule of this file: a metric nobody recorded says so in words. It never
 * shows as 0 and never shows as a dash. "Nobody checked" and "the platform said zero"
 * are different facts, and every judgement the app makes depends on telling them apart.
 */

/** Short form, for table cells where space is tight. */
export const NOT_CHECKED = 'Not checked';
/** Long form, for detail panels where there is room to say it properly. */
export const NOT_CHECKED_LONG = 'Nobody has checked this yet';

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NOT_CHECKED;
  return value.toLocaleString();
}

/** One decimal place, for calculated means. */
export function formatMean(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NOT_CHECKED;
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NOT_CHECKED;
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return NOT_CHECKED;
  }
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

/**
 * Parse a form field into a metric value. An empty field stays null, so leaving
 * something blank never quietly turns into a recorded zero.
 */
export function parseMetricInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** The reverse: nothing recorded becomes an empty field, and 0 stays a visible zero. */
export function metricToInput(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Compose a destination URL with UTM parameters, preserving anything already there. */
export function buildUtmUrl(
  base: string,
  utm: { source?: string | null; medium?: string | null; campaign?: string | null },
): string {
  if (!base.trim()) return '';
  try {
    const url = new URL(base.trim());
    if (utm.source) url.searchParams.set('utm_source', utm.source);
    if (utm.medium) url.searchParams.set('utm_medium', utm.medium);
    if (utm.campaign) url.searchParams.set('utm_campaign', utm.campaign);
    return url.toString();
  } catch {
    return base.trim();
  }
}
