/**
 * Writing follow-up tasks onto a dedicated Google Calendar.
 *
 * ONE DIRECTION ONLY
 *
 * Cockpit task to calendar event. Nothing is read back and turned into activity,
 * because an event on a calendar is not evidence that a business thing happened:
 * a dentist appointment and a client call look identical to an importer, and
 * classifying the first as outreach would invent history. Pulling events in can
 * come later, with a rule for telling them apart.
 *
 * WHAT IT WILL NEVER DO
 *
 * Delete an event. Not when a task is deleted, not when a lead is archived, not
 * as a tidy-up. The calendar may be shared with people who do not use this app,
 * and silently removing something from their week is not ours to do. See
 * calendar.ts, where that decision is written as a function so a test holds it.
 *
 * WHOSE CALENDAR, AND WHY THAT DEPENDS ON THE CREDENTIAL
 *
 * Writing to 'primary' means writing to whatever diary the credential happens to
 * own. Whether that is reasonable depends entirely on who the credential belongs
 * to, so the mode is required rather than defaulted:
 *
 *   service_account  'primary' is refused. The service account's own primary
 *                    calendar is a robot's empty diary nobody will ever read, and
 *                    a delegated service account's primary calendar is a real
 *                    person's week that nobody asked permission for.
 *   user_oauth       'primary' is the point. The person signed in to Google and
 *                    approved this, and their main calendar is the one they
 *                    actually look at. Asking them to create a second calendar
 *                    and copy its id is setup work with nothing to show for it.
 *
 * Either way the id is explicit and the mode is explicit. There is no path that
 * reaches a calendar by assumption.
 *
 * WHERE THE CREDENTIAL LIVES
 *
 * Nowhere in here. Every function takes a GoogleTokenSource and asks for a token
 * at call time. See googleAuth.ts and server/README.md.
 */

import type { GoogleTokenSource } from './googleAuth.ts';
import { CALENDAR_OAUTH_SCOPE } from './googleOAuth.ts';

/**
 * The narrowest scope that can write an event.
 *
 * calendar.events, not calendar: the wider one also grants creating, sharing and
 * deleting whole calendars, none of which this needs.
 */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const CALENDAR_ENDPOINT = 'https://www.googleapis.com/calendar/v3/calendars';

/**
 * Who the credential belongs to, which decides whether 'primary' is allowed.
 *
 * Not a preference and not a feature flag. It is a statement about whose diary is
 * on the other end of the token, and the two answers have opposite consequences.
 */
export type CalendarAuthMode = 'service_account' | 'user_oauth';

/** The id meaning "the main calendar of whoever this credential is". */
export const PRIMARY_CALENDAR_ID = 'primary';

/** How the primary calendar is named on screen. Never a raw id. */
export const PRIMARY_CALENDAR_LABEL = 'Primary Google Calendar';

/**
 * Calendar ids no credential may ever be pointed at.
 *
 * 'default' and the empty string are always refused, because neither names
 * anything a person chose. 'primary' is handled separately, since whether it is
 * acceptable depends on the mode.
 */
export const FORBIDDEN_CALENDAR_IDS = ['default', ''];

/**
 * Is this a calendar this credential is allowed to write to?
 *
 * The mode is required. Leaving it optional would mean a future caller that
 * forgot it got the permissive answer by accident, and the whole value of this
 * function is that reaching somebody's real diary has to be deliberate.
 */
export function isWritableCalendarId(
  calendarId: string | null,
  mode: CalendarAuthMode,
): boolean {
  if (calendarId === null) return false;
  const id = calendarId.trim().toLowerCase();
  if (FORBIDDEN_CALENDAR_IDS.includes(id)) return false;
  if (id === PRIMARY_CALENDAR_ID) return mode === 'user_oauth';
  return true;
}

/** What to show for a destination, so 'primary' never appears as a raw id. */
export function describeCalendarTarget(calendarId: string | null): string | null {
  if (calendarId === null || calendarId.trim() === '') return null;
  return calendarId.trim().toLowerCase() === PRIMARY_CALENDAR_ID
    ? PRIMARY_CALENDAR_LABEL
    : calendarId.trim();
}

/* ------------------------------------------------------------- the event id --- */

/**
 * A Google event id derived from the task id, so a retry cannot double-book.
 *
 * WHY DETERMINISTIC
 *
 * Creating an event is not atomic from this side: Google can create it and the
 * response can still be lost to a timeout. A random id would mean the retry
 * creates a second event, and nothing would ever notice. With an id derived from
 * the task, the retry asks for the same id, Google answers 409, and the sync
 * treats that as "already there" and patches instead.
 *
 * WHY IT LOOKS LIKE THIS
 *
 * Google requires event ids to be base32hex: the characters a to v and 0 to 9,
 * between 5 and 1024 long. A uuid's hex digits are all inside that set, so the
 * task's own id with the hyphens removed is already legal, and the prefix keeps
 * these distinguishable from anything created by hand.
 */
export const EVENT_ID_PREFIX = 'slc';

export function calendarEventId(taskId: string): string {
  const compact = taskId.replace(/-/g, '').toLowerCase();
  if (!/^[a-v0-9]+$/.test(compact) || compact.length < 2) {
    throw new Error('Task id cannot be expressed as a Google event id');
  }
  return `${EVENT_ID_PREFIX}${compact}`;
}

/** Google's own rule, so a bad id is caught here rather than as a 400. */
export function isValidGoogleEventId(id: string): boolean {
  return /^[a-v0-9]{5,1024}$/.test(id);
}

/* ---------------------------------------------------------------- the event --- */

/** Everything the calendar needs to know about one follow-up. */
export interface FollowUpEventInput {
  taskId: string;
  dueDate: string;
  taskTitle: string;
  taskNotes: string | null;
  prospectName: string | null;
  organization: string | null;
  preferredChannel: string | null;
  relationship: string | null;
  project: string | null;
}

export interface GoogleEventBody {
  id: string;
  summary: string;
  description: string;
  start: { date: string };
  end: { date: string };
  transparency: 'transparent';
  source?: { title: string };
}

/** The day after, because an all-day event's end date is exclusive. */
export function dayAfter(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export const MANAGED_BY_NOTE =
  'This event is created and kept up to date by SiteLaunch Cockpit. Editing it here '
  + 'will be overwritten by the next sync; change the follow-up in the Cockpit instead.';

/**
 * What one follow-up looks like on a calendar.
 *
 * All day, because the Cockpit knows a date and not a time. Inventing 9am would
 * put a specific claim on somebody's diary that nothing in the data supports.
 *
 * Marked transparent, so a day with four follow-ups on it still reads as free
 * rather than as a day somebody is fully booked.
 */
export function buildFollowUpEvent(input: FollowUpEventInput): GoogleEventBody {
  const who = input.prospectName ?? input.taskTitle;
  // A comma rather than a dash: this copy is read by a person, and the house
  // style has no em dashes in it.
  const summary = input.organization
    ? `Follow up: ${who}, ${input.organization}`
    : `Follow up: ${who}`;

  const lines = [
    input.taskNotes ?? 'No next action recorded.',
    '',
    `How to reach them: ${input.preferredChannel ?? 'not recorded'}`,
    `Relationship: ${input.relationship ?? 'not recorded'}`,
    `Project: ${input.project ?? 'not recorded'}`,
    '',
    `Cockpit task: ${input.taskId}`,
    MANAGED_BY_NOTE,
  ];

  return {
    id: calendarEventId(input.taskId),
    summary,
    description: lines.join('\n'),
    start: { date: input.dueDate },
    end: { date: dayAfter(input.dueDate) },
    transparency: 'transparent',
    source: { title: 'SiteLaunch Marketing Cockpit' },
  };
}

/* --------------------------------------------------------------- the client --- */

export interface CalendarDeps {
  tokenSource: GoogleTokenSource;
  calendarId: string;
  /** Whose credential this is. Decides whether 'primary' is acceptable. */
  mode: CalendarAuthMode;
  fetchImpl?: typeof fetch;
}

export type PushOutcome = 'created' | 'updated';

export interface PushResult {
  outcome: PushOutcome;
  eventId: string;
  /**
   * The Google address that owns the event, if Google said.
   *
   * This is the one honest way to learn which account is connected without
   * asking for an identity scope the Cockpit has no other use for. Google puts it
   * on the event it just accepted, so it is a fact about work that succeeded
   * rather than a question we had to ask.
   */
  organizerEmail: string | null;
}

/** An email address out of an event body, or null. Nothing else is kept. */
export function eventOrganizerEmail(body: unknown): string | null {
  const event = body as {
    organizer?: { email?: unknown };
    creator?: { email?: unknown };
  } | null;
  for (const candidate of [event?.organizer?.email, event?.creator?.email]) {
    if (typeof candidate === 'string' && /^[^@\s]+@[^@\s]+[.][^@\s]+$/.test(candidate)) {
      return candidate.toLowerCase();
    }
  }
  return null;
}

/**
 * Google's own reason codes, and nothing else from a failed body.
 *
 * Same rule as the Sheets client: keep only values shaped like an enum, which an
 * address, a token or a PEM block cannot be. The difference between "the calendar
 * was never shared" and "the API is switched off" is worth an afternoon.
 */
export function calendarReasons(body: unknown): string[] {
  const safe = /^[A-Z][A-Z_]{2,39}$/;
  const found = new Set<string>();
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error) return [];

  const status = error.status;
  if (typeof status === 'string' && safe.test(status)) found.add(status);

  const errors = error.errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const reason = (item as { reason?: unknown } | null)?.reason;
      // Calendar uses lowerCamelCase reasons such as 'duplicate' and
      // 'notFound', so they are upper-cased into the same shape.
      if (typeof reason === 'string' && /^[a-zA-Z]{3,40}$/.test(reason)) {
        found.add(reason.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase());
      }
    }
  }
  return [...found];
}

async function call(
  deps: CalendarDeps,
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const doFetch = deps.fetchImpl ?? fetch;
  /**
   * The narrower scope when the credential is a person's own.
   *
   * events.owned covers calendars they own, which is all the Cockpit writes to.
   * The service account path keeps events, because a calendar shared with it is
   * one it has access to rather than one it owns.
   */
  const scope = deps.mode === 'user_oauth' ? CALENDAR_OAUTH_SCOPE : CALENDAR_SCOPE;
  const token = await deps.tokenSource.getAccessToken([scope]);
  const url = `${CALENDAR_ENDPOINT}/${encodeURIComponent(deps.calendarId)}${path}`;

  const response = await doFetch(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * Put one follow-up on the calendar, creating it or bringing it up to date.
 *
 * The 409 is the whole point. Asking to create an event whose id already exists
 * is how a retry after a lost response finds out that Google did the work after
 * all, and the answer is to patch rather than to give up or to try again with a
 * different id.
 *
 * Nothing here deletes. A follow-up that no longer applies is left on the
 * calendar, because somebody may have planned their day around it.
 */
export async function pushFollowUpEvent(
  deps: CalendarDeps,
  input: FollowUpEventInput,
): Promise<PushResult> {
  if (!isWritableCalendarId(deps.calendarId, deps.mode)) {
    throw new Error(
      deps.mode === 'service_account'
        ? 'Refusing to write to a calendar that was not explicitly configured'
        : 'Refusing to write to a calendar this authorization does not name',
    );
  }

  const event = buildFollowUpEvent(input);
  if (!isValidGoogleEventId(event.id)) {
    throw new Error('Refusing to write an event id Google would reject');
  }

  const created = await call(deps, '/events', { method: 'POST', body: event });
  if (created.status >= 200 && created.status < 300) {
    return {
      outcome: 'created',
      eventId: event.id,
      organizerEmail: eventOrganizerEmail(created.body),
    };
  }

  // 409 means this exact event is already there, which is a success for our
  // purposes: it is the same follow-up, put there by an earlier attempt.
  if (created.status === 409) {
    const patched = await call(deps, `/events/${encodeURIComponent(event.id)}`, {
      method: 'PATCH',
      body: {
        summary: event.summary,
        description: event.description,
        start: event.start,
        end: event.end,
        // A cancelled event is restored by patching its status, which is how an
        // event somebody deleted by hand comes back rather than silently never
        // syncing again.
        status: 'confirmed',
      },
    });
    if (patched.status >= 200 && patched.status < 300) {
      return {
        outcome: 'updated',
        eventId: event.id,
        organizerEmail: eventOrganizerEmail(patched.body),
      };
    }
    throw new Error(describeFailure('PATCH', patched));
  }

  throw new Error(describeFailure('POST', created));
}

function describeFailure(method: string, response: { status: number; body: unknown }): string {
  const reasons = calendarReasons(response.body);
  const because = reasons.length === 0 ? '' : `: ${reasons.join(', ')}`;
  return `Google Calendar ${method} failed (HTTP ${response.status})${because}`;
}
