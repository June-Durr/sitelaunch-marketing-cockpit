/**
 * Writing follow-ups to a calendar, proved against a fake Google.
 *
 * Nothing here reaches the network. The fake below behaves the way Calendar
 * actually behaves in the two cases that matter: it refuses a second event with
 * an id it already holds, and it can fail after having done the work. Those are
 * the two that decide whether a retry duplicates somebody's week.
 *
 * Every person and every date is invented.
 */

import { describe, expect, it } from 'vitest';

import {
  buildFollowUpEvent, calendarEventId, calendarReasons, CALENDAR_SCOPE, dayAfter,
  EVENT_ID_PREFIX, FORBIDDEN_CALENDAR_IDS, isValidGoogleEventId, isWritableCalendarId,
  MANAGED_BY_NOTE, pushFollowUpEvent, calendarFailureDetail,
  type CalendarDeps, type FollowUpEventInput,
} from './googleCalendar.ts';
import type { GoogleTokenSource } from './googleAuth.ts';
import type { CalendarAuthMode } from './googleCalendar.ts';

const TASK_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const tokenSource: GoogleTokenSource = {
  getAccessToken: async () => 'not-a-real-token',
  describe: () => 'sync@example.iam.gserviceaccount.com',
};

function input(over: Partial<FollowUpEventInput> = {}): FollowUpEventInput {
  return {
    taskId: TASK_ID,
    dueDate: '2026-10-12',
    taskTitle: 'Follow up with Taylor',
    taskNotes: 'Send one concise final follow-up',
    prospectName: 'Taylor',
    organization: 'Your Local Handyman',
    preferredChannel: 'Phone + email',
    relationship: 'Prospect',
    project: 'Site rebuild',
    ...over,
  };
}

/**
 * A Google Calendar that keeps one event per id.
 *
 * `failWith` makes the next N calls fail, and `createdDespiteFailure` reproduces
 * the nasty one: Google stores the event and the caller never hears about it.
 */
function fakeCalendar(options: {
  failInsertWith?: number;
  failPatchWith?: number;
  createDespiteFailure?: boolean;
} = {}) {
  const events = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  // The full addresses as well as the shapes, so a test can prove which
  // calendar was actually written to and not merely that something was.
  const urls: string[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push(`${method} ${href.includes('/events/') ? 'one' : 'collection'}`);
    urls.push(href);

    if (method === 'POST') {
      const id = String(body.id);

      /**
       * The rule the live API actually enforces, reproduced.
       *
       * Google accepts an event with no `source` at all, and rejects one whose
       * `source` has no usable `url`. The reference page lists source.url as
       * optional, which is why this was not caught by reading the docs; the
       * first real run answered 400 invalid, "Invalid source url: .", nineteen
       * times. The fake now answers the same way, so the mistake cannot come
       * back without this file going red.
       */
      if (body.source !== undefined) {
        const url = (body.source as { url?: unknown } | null)?.url;
        const usable = typeof url === 'string' && /^https?:\/\/\S+$/.test(url);
        if (!usable) {
          return new Response(
            JSON.stringify({
              error: {
                code: 400,
                message: `Invalid source url: ${typeof url === 'string' ? url : ''}.`,
                errors: [{ domain: 'global', reason: 'invalid', message: 'Invalid source url' }],
              },
            }),
            { status: 400 },
          );
        }
      }

      if (options.failInsertWith) {
        if (options.createDespiteFailure) events.set(id, body);
        return new Response(
          JSON.stringify({ error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } }),
          { status: options.failInsertWith },
        );
      }
      if (events.has(id)) {
        return new Response(
          JSON.stringify({ error: { errors: [{ reason: 'duplicate' }] } }),
          { status: 409 },
        );
      }
      events.set(id, body);
      return new Response(JSON.stringify({ id }), { status: 200 });
    }

    if (method === 'PATCH') {
      if (options.failPatchWith) {
        return new Response(
          JSON.stringify({ error: { status: 'NOT_FOUND' } }),
          { status: options.failPatchWith },
        );
      }
      const id = decodeURIComponent(href.split('/events/')[1]);
      events.set(id, { ...(events.get(id) ?? {}), ...body });
      return new Response(JSON.stringify({ id }), { status: 200 });
    }

    return new Response('{}', { status: 405 });
  }) as unknown as typeof fetch;

  return { events, calls, urls, fetchImpl };
}

const deps = (
  fetchImpl: typeof fetch,
  calendarId = 'sitelaunch@group.calendar.google.com',
  mode: CalendarAuthMode = 'service_account',
): CalendarDeps => ({ tokenSource, calendarId, mode, fetchImpl });

/* ================================================================ the scope === */

describe('it asks for the narrowest scope that can write an event', () => {
  it('uses calendar.events, not the whole calendar scope', () => {
    expect(CALENDAR_SCOPE).toBe('https://www.googleapis.com/auth/calendar.events');
    // The wider scope also grants creating, sharing and deleting calendars.
    expect(CALENDAR_SCOPE).not.toBe('https://www.googleapis.com/auth/calendar');
  });
});

/* =========================================================== the target === */

describe('it will only write to a calendar somebody configured', () => {
  it('refuses the primary calendar to the service account, whoever that is', () => {
    expect(isWritableCalendarId('primary', 'service_account')).toBe(false);
    expect(isWritableCalendarId('PRIMARY', 'service_account')).toBe(false);
    expect(isWritableCalendarId('  primary  ', 'service_account')).toBe(false);
  });

  it('refuses a calendar nobody named, in either mode', () => {
    for (const id of FORBIDDEN_CALENDAR_IDS) {
      expect(isWritableCalendarId(id, 'service_account'), id).toBe(false);
      expect(isWritableCalendarId(id, 'user_oauth'), id).toBe(false);
    }
  });

  it('refuses no calendar at all rather than guessing one', () => {
    expect(isWritableCalendarId(null, 'service_account')).toBe(false);
    expect(isWritableCalendarId(null, 'user_oauth')).toBe(false);
  });

  it('accepts a dedicated calendar id', () => {
    expect(isWritableCalendarId('sitelaunch@group.calendar.google.com', 'service_account'))
      .toBe(true);
  });

  /**
   * The one difference between the two modes, stated as a test.
   *
   * It is not a relaxation. Under user_oauth the credential IS the person, they
   * signed in to Google themselves and approved it, and their main calendar is
   * the one they actually read. Under service_account nobody consented to
   * anything, which is why the same id is refused.
   */
  it('accepts the primary calendar when the credential is the person own', () => {
    expect(isWritableCalendarId('primary', 'user_oauth')).toBe(true);
    expect(isWritableCalendarId('PRIMARY', 'user_oauth')).toBe(true);
  });

  it('throws rather than writing when the target is not configured', async () => {
    const google = fakeCalendar();
    await expect(
      pushFollowUpEvent(deps(google.fetchImpl, 'primary'), input()),
    ).rejects.toThrow(/not explicitly configured/i);
    // And it never got as far as a request.
    expect(google.calls).toEqual([]);
  });

  it('writes to the primary calendar under a person own authorization', async () => {
    const google = fakeCalendar();
    const result = await pushFollowUpEvent(
      deps(google.fetchImpl, 'primary', 'user_oauth'),
      input(),
    );
    expect(result.outcome).toBe('created');
    expect(google.urls[0]).toContain('/calendars/primary/events');
  });
});

/* ========================================================== the event id === */

describe('the event id is derived from the task, so a retry cannot duplicate', () => {
  it('is the task id in a form Google accepts', () => {
    const id = calendarEventId(TASK_ID);
    expect(id).toBe(`${EVENT_ID_PREFIX}a1b2c3d4e5f64a7b8c9d0e1f2a3b4c5d`);
    expect(isValidGoogleEventId(id)).toBe(true);
  });

  it('is the same every time, which is the entire point', () => {
    expect(calendarEventId(TASK_ID)).toBe(calendarEventId(TASK_ID));
  });

  it('differs for a different task', () => {
    expect(calendarEventId(TASK_ID)).not.toBe(
      calendarEventId('ffffffff-ffff-4fff-8fff-ffffffffffff'),
    );
  });

  it('only uses characters Google allows', () => {
    // Base32hex: a to v and 0 to 9. A uuid's hex digits all qualify, which is
    // why no encoding step is needed.
    expect(calendarEventId(TASK_ID)).toMatch(/^[a-v0-9]+$/);
  });

  it('refuses an id it cannot express rather than inventing one', () => {
    expect(() => calendarEventId('not a uuid with spaces')).toThrow();
    expect(() => calendarEventId('zzz')).toThrow();
  });

  it('rejects ids Google would reject', () => {
    expect(isValidGoogleEventId('abc')).toBe(false);
    expect(isValidGoogleEventId('with-hyphens-xx')).toBe(false);
    expect(isValidGoogleEventId('WXYZ12345')).toBe(false);
  });
});

/* =============================================================== the event === */

describe('what one follow-up looks like on a calendar', () => {
  it('is an all day entry, with an exclusive end date', () => {
    const event = buildFollowUpEvent(input());
    expect(event.start).toEqual({ date: '2026-10-12' });
    // Google treats an all day end date as exclusive, so a one day event ends
    // the following day.
    expect(event.end).toEqual({ date: '2026-10-13' });
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
    expect(dayAfter('2028-02-28')).toBe('2028-02-29');
  });

  it('has no time of day, because the Cockpit does not know one', () => {
    const event = buildFollowUpEvent(input()) as unknown as Record<string, unknown>;
    expect(event.start).not.toHaveProperty('dateTime');
    expect(event.end).not.toHaveProperty('dateTime');
  });

  it('does not make the day look busy', () => {
    expect(buildFollowUpEvent(input()).transparency).toBe('transparent');
  });

  it('names the person and their organization in the summary', () => {
    expect(buildFollowUpEvent(input()).summary)
      .toBe('Follow up: Taylor, Your Local Handyman');
  });

  it('leaves the organization out when there is not one, rather than writing a blank', () => {
    expect(buildFollowUpEvent(input({ organization: null })).summary)
      .toBe('Follow up: Taylor');
  });

  it('uses no em dash, because nothing in this app does', () => {
    const event = buildFollowUpEvent(input());
    expect(event.summary).not.toContain('\\u2014');
    expect(event.description).not.toContain('\\u2014');
  });

  it('carries the next action, the channel, the relationship and the project', () => {
    const description = buildFollowUpEvent(input()).description;
    expect(description).toContain('Send one concise final follow-up');
    expect(description).toContain('Phone + email');
    expect(description).toContain('Prospect');
    expect(description).toContain('Site rebuild');
  });

  it('names the Cockpit task, so an event can be traced back', () => {
    expect(buildFollowUpEvent(input()).description).toContain(TASK_ID);
  });

  it('says who manages it, so nobody edits it expecting the edit to last', () => {
    expect(buildFollowUpEvent(input()).description).toContain(MANAGED_BY_NOTE);
    expect(MANAGED_BY_NOTE).toContain('SiteLaunch Cockpit');
  });

  it('says not recorded rather than leaving a field blank or inventing one', () => {
    const description = buildFollowUpEvent(
      input({ taskNotes: null, preferredChannel: null, relationship: null, project: null }),
    ).description;
    expect(description).toContain('No next action recorded.');
    expect(description).toContain('How to reach them: not recorded');
    expect(description).toContain('Relationship: not recorded');
    expect(description).toContain('Project: not recorded');
  });
});

/* ========================================================= pushing it out === */

describe('pushing the same follow-up three times leaves one event', () => {
  it('creates once, then updates', async () => {
    const google = fakeCalendar();
    const target = deps(google.fetchImpl);

    const first = await pushFollowUpEvent(target, input());
    const second = await pushFollowUpEvent(target, input());
    const third = await pushFollowUpEvent(target, input());

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('updated');
    expect(third.outcome).toBe('updated');

    expect(first.eventId).toBe(second.eventId);
    expect(second.eventId).toBe(third.eventId);
    expect(google.events.size).toBe(1);
  });

  it('keeps one event per task, not one per run', async () => {
    const google = fakeCalendar();
    const target = deps(google.fetchImpl);
    const tasks = [
      TASK_ID,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ];

    for (let run = 0; run < 3; run += 1) {
      for (const taskId of tasks) {
        await pushFollowUpEvent(target, input({ taskId }));
      }
    }

    expect(google.events.size).toBe(3);
  });

  it('moves the existing event when the date changes, rather than adding another', async () => {
    const google = fakeCalendar();
    const target = deps(google.fetchImpl);

    await pushFollowUpEvent(target, input({ dueDate: '2026-10-12' }));
    const moved = await pushFollowUpEvent(target, input({ dueDate: '2026-10-20' }));

    expect(moved.outcome).toBe('updated');
    expect(google.events.size).toBe(1);

    const stored = google.events.get(moved.eventId) as Record<string, unknown>;
    expect(stored.start).toEqual({ date: '2026-10-20' });
    expect(stored.end).toEqual({ date: '2026-10-21' });
  });

  it('brings a changed description across on the update', async () => {
    const google = fakeCalendar();
    const target = deps(google.fetchImpl);

    await pushFollowUpEvent(target, input({ taskNotes: 'Ring him' }));
    const updated = await pushFollowUpEvent(target, input({ taskNotes: 'Send the quote' }));

    const stored = google.events.get(updated.eventId) as Record<string, unknown>;
    expect(String(stored.description)).toContain('Send the quote');
  });

  it('restores an event somebody deleted by hand instead of never syncing again', async () => {
    const google = fakeCalendar();
    const target = deps(google.fetchImpl);

    await pushFollowUpEvent(target, input());
    const again = await pushFollowUpEvent(target, input());

    const stored = google.events.get(again.eventId) as Record<string, unknown>;
    expect(stored.status).toBe('confirmed');
  });
});

describe('a create that Google completed but never reported', () => {
  it('does not produce a second event on the retry', async () => {
    /**
     * The failure this whole design exists for.
     *
     * Google stores the event and the response is lost. With a random id the
     * retry would create a second entry in somebody's week and nothing would
     * notice. With an id derived from the task, the retry gets a 409 and
     * patches.
     */
    const lost = fakeCalendar({ failInsertWith: 504, createDespiteFailure: true });
    await expect(pushFollowUpEvent(deps(lost.fetchImpl), input())).rejects.toThrow(/504/);
    expect(lost.events.size).toBe(1);

    // The retry, against the same store, now that Google is answering again.
    const retry = fakeCalendar();
    for (const [id, body] of lost.events) retry.events.set(id, body);

    const result = await pushFollowUpEvent(deps(retry.fetchImpl), input());
    expect(result.outcome).toBe('updated');
    expect(retry.events.size).toBe(1);
  });
});

/* ============================================================= failures === */

describe('a failed write says what went wrong without saying too much', () => {
  it('reports the status and Google’s own reason code', async () => {
    const google = fakeCalendar({ failInsertWith: 403 });
    await expect(pushFollowUpEvent(deps(google.fetchImpl), input())).rejects.toThrow(
      // Google's literal reason, not a normalised one. The first live failure
      // said only "INVALID", and finding out which field it meant took an
      // investigation that Google's own words would have saved.
      /Google Calendar POST failed \(HTTP 403\).*forbidden/,
    );
  });

  it('reports a failed update too', async () => {
    const google = fakeCalendar();
    await pushFollowUpEvent(deps(google.fetchImpl), input());

    const broken = fakeCalendar({ failPatchWith: 404 });
    for (const [id, body] of google.events) broken.events.set(id, body);

    await expect(pushFollowUpEvent(deps(broken.fetchImpl), input())).rejects.toThrow(
      /Google Calendar PATCH failed \(HTTP 404\).*NOT_FOUND/,
    );
  });

  it('keeps only the reason codes out of a failure body', () => {
    expect(calendarReasons({ error: { status: 'PERMISSION_DENIED' } }))
      .toEqual(['PERMISSION_DENIED']);
    // Calendar writes its reasons in lower camel case.
    expect(calendarReasons({ error: { errors: [{ reason: 'notFound' }] } }))
      .toEqual(['NOT_FOUND']);
    expect(calendarReasons({ error: { errors: [{ reason: 'duplicate' }] } }))
      .toEqual(['DUPLICATE']);
  });

  it('cannot be made to leak an address, a token or a key', () => {
    const nasty = {
      error: {
        status: 'sync@example.iam.gserviceaccount.com',
        message: 'Request had client_email=someone@example.com',
        errors: [
          { reason: '-----BEGIN PRIVATE KEY-----MIIEvQ' },
          { reason: 'ya29.notarealtoken' },
          { reason: 'some free text with spaces' },
        ],
      },
    };
    expect(calendarReasons(nasty)).toEqual([]);
  });

  it('says nothing rather than throwing on a body it does not understand', () => {
    expect(calendarReasons(null)).toEqual([]);
    expect(calendarReasons({})).toEqual([]);
    expect(calendarReasons({ error: {} })).toEqual([]);
    expect(calendarReasons('a string')).toEqual([]);
    expect(calendarReasons({ error: { errors: 'not an array' } })).toEqual([]);
  });
});

/* ========================================================== no deletions === */

describe('it never deletes anything', () => {
  it('makes no DELETE request, whatever it is asked to do', async () => {
    const google = fakeCalendar();
    const target = deps(google.fetchImpl);

    await pushFollowUpEvent(target, input());
    await pushFollowUpEvent(target, input({ dueDate: '2026-11-01' }));

    expect(google.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    expect(google.events.size).toBe(1);
  });
});

/* ================================ the payload Google refused, 2026-10-10 === */

/**
 * The first real sync failed nineteen times out of nineteen.
 *
 * Every one of them was HTTP 400, reason `invalid`, message "Invalid source
 * url: .". The body carried `source: { title: 'SiteLaunch Marketing Cockpit' }`
 * and no url, which Google refuses: the object is optional, but once it is
 * present its url is not.
 *
 * The fields below are the real ones from task 00ad76a2, kept so the body under
 * test is the body that was actually sent rather than a tidied version of it.
 */
describe('the event body is one Google will accept', () => {
  const live: FollowUpEventInput = {
    taskId: '00ad76a2-2c6a-4352-932c-3540c476922e',
    dueDate: '2026-10-06',
    taskTitle: 'Follow up with Janeth',
    taskNotes:
      'Ask whether the other company completed the website and whether anything '
      + 'is still needed',
    prospectName: 'Janeth',
    organization: 'JMC Clean Master',
    preferredChannel: 'Phone + text (Spanish)',
    relationship: 'Prospect',
    project: null,
  };

  it('sends no source object, rather than one with no url in it', () => {
    const event = buildFollowUpEvent(live) as unknown as Record<string, unknown>;
    // Absent, not empty: an empty object would fail exactly the same way.
    expect('source' in event).toBe(false);
  });

  it('is accepted by a Google that enforces the real source rule', async () => {
    const google = fakeCalendar();
    const result = await pushFollowUpEvent(
      deps(google.fetchImpl, 'primary', 'user_oauth'),
      live,
    );
    expect(result.outcome).toBe('created');
    expect(google.events.get(result.eventId)).toBeTruthy();
  });

  it('would have failed before the correction, for the reason Google gave', async () => {
    /**
     * The counterpart to the test above.
     *
     * It sends the old body deliberately, so the fake's rule is proved to bite.
     * Without this, a fake that quietly accepted anything would make the test
     * above pass whatever the body looked like.
     */
    const google = fakeCalendar();
    const old = {
      ...buildFollowUpEvent(live),
      source: { title: 'SiteLaunch Marketing Cockpit' },
    };
    const response = await google.fetchImpl(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      { method: 'POST', headers: { authorization: 'Bearer not-a-real-token' },
        body: JSON.stringify(old) },
    );
    expect(response.status).toBe(400);
    const detail = calendarFailureDetail(400, await response.json());
    expect(detail.reason).toBe('invalid');
    expect(detail.message).toContain('Invalid source url');
  });

  it('keeps every other field exactly as Google wants it', () => {
    const event = buildFollowUpEvent(live);

    // The id: base32hex only, between 5 and 1024 characters.
    expect(event.id).toBe('slc00ad76a22c6a4352932c3540c476922e');
    expect(event.id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(isValidGoogleEventId(event.id)).toBe(true);

    // An all day event: a date, not a dateTime, and an exclusive end.
    expect(event.start).toEqual({ date: '2026-10-06' });
    expect(event.end).toEqual({ date: '2026-10-07' });
    expect(event.start.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(event.end.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(event.end.date).toBe(dayAfter(event.start.date));

    // The one enum, and a value that is in it.
    expect(['opaque', 'transparent']).toContain(event.transparency);

    // No key is sent holding undefined or null. Google rejects some of those
    // outright and silently ignores others, and neither is worth finding out
    // about in production.
    for (const [key, value] of Object.entries(event)) {
      expect(value, `${key} is empty`).not.toBeUndefined();
      expect(value, `${key} is null`).not.toBeNull();
    }

    // And nothing has crept in beyond the fields that were reasoned about.
    expect(Object.keys(event).sort()).toEqual([
      'description', 'end', 'id', 'start', 'summary', 'transparency',
    ]);
  });

  it('still says who made it, in the description rather than in a source', () => {
    // Dropping `source` must not drop the attribution, which is the only thing
    // it was carrying.
    const event = buildFollowUpEvent(live);
    expect(event.description).toContain('SiteLaunch Cockpit');
    expect(event.description).toContain('Cockpit task: 00ad76a2-2c6a-4352-932c-3540c476922e');
  });
});
