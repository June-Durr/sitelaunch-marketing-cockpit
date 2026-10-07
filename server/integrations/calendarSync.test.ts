/**
 * Syncing follow-ups to several people's own calendars.
 *
 * The questions worth asking here are all about more than one person: does one
 * broken authorization stop everybody else, does a sync reach only the owner it
 * was asked about, and does running it three times leave three events or one.
 *
 * Nothing reaches the network or a database. The fake Google below behaves the
 * way Calendar actually behaves in the case that decides whether a retry
 * duplicates somebody's week: it refuses a second event with an id it already
 * holds. Every person, token and date is invented.
 */

import { describe, expect, it } from 'vitest';

import {
  syncEveryConnectedOwner, syncOneOwner,
  type CalendarRunToSave, type CalendarSyncDeps, type CalendarSyncStore,
} from './calendarSync.ts';
import type { FollowUpEventInput } from './googleCalendar.ts';

/* ------------------------------------------------------------------ fakes --- */

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BRUNO = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CARA = 'cccccccc-3333-4333-8333-cccccccccccc';

function task(id: string, over: Partial<FollowUpEventInput> = {}): FollowUpEventInput {
  return {
    taskId: id,
    dueDate: '2026-10-12',
    taskTitle: 'Follow up',
    taskNotes: 'Ask about the shopfront photos.',
    prospectName: 'Imaginary Person',
    organization: 'Imaginary Trades',
    preferredChannel: 'phone',
    relationship: 'referral partner',
    project: 'website refresh',
    ...over,
  };
}

/**
 * A Google Calendar per authenticated account.
 *
 * Keyed by access token, because that is how the real thing separates them: a
 * token identifies whose calendar 'primary' means. That makes it possible to
 * assert that one person's follow-ups did not land in another person's week.
 */
function fakeGoogle(options: { failFor?: string[] } = {}) {
  const calendars = new Map<string, Map<string, Record<string, unknown>>>();
  const requests: { token: string; method: string; url: string }[] = [];

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    requests.push({ token, method, url: href });

    if (options.failFor?.includes(token)) {
      return new Response(
        JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }),
        { status: 403 },
      );
    }

    const events = calendars.get(token) ?? new Map<string, Record<string, unknown>>();
    calendars.set(token, events);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (method === 'POST') {
      const id = String(body.id);
      if (events.has(id)) {
        return new Response(
          JSON.stringify({ error: { errors: [{ reason: 'duplicate' }] } }),
          { status: 409 },
        );
      }
      events.set(id, body);
      return new Response(
        JSON.stringify({ id, organizer: { email: `${token}@example.test` } }),
        { status: 200 },
      );
    }

    if (method === 'PATCH') {
      const id = decodeURIComponent(href.split('/events/')[1]);
      events.set(id, { ...(events.get(id) ?? {}), ...body });
      return new Response(
        JSON.stringify({ id, organizer: { email: `${token}@example.test` } }),
        { status: 200 },
      );
    }

    return new Response('{}', { status: 405 });
  }) as unknown as typeof fetch;

  return { calendars, requests, fetchImpl };
}

interface FakeStore extends CalendarSyncStore {
  readonly runs: CalendarRunToSave[];
  readonly syncedTasks: { ownerId: string; taskId: string; eventId: string }[];
  readonly failedTasks: { ownerId: string; taskId: string }[];
  readonly connectionState: Map<string, { status: string; message: string | null }>;
  readonly accounts: Map<string, string>;
}

/**
 * An in-memory store.
 *
 * `tokens` decides who has connected; an owner missing from it has not. `tasks`
 * is per owner, so a test can prove a sync touched one person's tasks and not
 * another's.
 */
function fakeStore(options: {
  tokens: Record<string, string | null>;
  tasks?: Record<string, FollowUpEventInput[]>;
  tokenReadThrows?: string[];
  tasksThrowFor?: string[];
}): FakeStore {
  const runs: CalendarRunToSave[] = [];
  const syncedTasks: { ownerId: string; taskId: string; eventId: string }[] = [];
  const failedTasks: { ownerId: string; taskId: string }[] = [];
  const connectionState = new Map<string, { status: string; message: string | null }>();
  const accounts = new Map<string, string>();

  return {
    runs, syncedTasks, failedTasks, connectionState, accounts,

    async connectedOwners() {
      return Object.entries(options.tokens)
        .filter(([, token]) => token !== null)
        .map(([ownerId]) => ownerId);
    },
    async readRefreshToken(ownerId) {
      if (options.tokenReadThrows?.includes(ownerId)) {
        throw new Error('the token store is unreachable');
      }
      return options.tokens[ownerId] ?? null;
    },
    async pushableTasks(ownerId) {
      if (options.tasksThrowFor?.includes(ownerId)) {
        throw new Error('tasks read failed');
      }
      return options.tasks?.[ownerId] ?? [];
    },
    async markTaskSynced(ownerId, taskId, _calendarId, eventId) {
      syncedTasks.push({ ownerId, taskId, eventId });
    },
    async markTaskSyncFailed(ownerId, taskId) {
      failedTasks.push({ ownerId, taskId });
    },
    async connectionId() {
      return 'connection-row';
    },
    async markConnectionSynced(ownerId) {
      connectionState.set(ownerId, { status: 'connected', message: null });
    },
    async markConnectionError(ownerId, message) {
      connectionState.set(ownerId, { status: 'error', message });
    },
    async rememberGoogleAccount(ownerId, email) {
      if (!accounts.has(ownerId)) accounts.set(ownerId, email);
    },
    async saveRun(run) {
      runs.push(run);
    },
  };
}

/**
 * A refresh that turns each stored token into its own access token.
 *
 * Deliberately one to one, so the fake Google can tell two people apart.
 */
function deps(
  store: CalendarSyncStore,
  google: ReturnType<typeof fakeGoogle>,
  options: { refreshFailsFor?: string[] } = {},
): CalendarSyncDeps {
  return {
    store,
    fetchImpl: google.fetchImpl,
    refreshFor: async (refreshToken) => {
      if (options.refreshFailsFor?.includes(refreshToken)) {
        throw new Error('Google refused the stored authorization (HTTP 400): invalid_grant');
      }
      return { accessToken: `access-${refreshToken}`, expiresInSeconds: 3599 };
    },
  };
}

/* ============================================== 7. on demand, one owner only === */

describe('a sync somebody asked for touches that person and nobody else', () => {
  it('writes only the signed in owner tasks, to only their calendar', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token', [BRUNO]: 'bruno-token' },
      tasks: {
        [ALICE]: [task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
        [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
      },
    });
    const google = fakeGoogle();

    const result = await syncOneOwner(deps(store, google), ALICE);

    expect(result.ownerId).toBe(ALICE);
    expect(result.created).toBe(1);
    expect(store.syncedTasks.every((t) => t.ownerId === ALICE)).toBe(true);

    // One calendar was written, and it is the one Alice authorization opens.
    expect([...google.calendars.keys()]).toEqual(['access-alice-token']);
    expect(google.calendars.get('access-bruno-token')).toBeUndefined();
  });

  it('does nothing at all for somebody who has not connected', async () => {
    const store = fakeStore({
      tokens: { [CARA]: null },
      tasks: { [CARA]: [task('c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')] },
    });
    const google = fakeGoogle();

    const result = await syncOneOwner(deps(store, google), CARA);

    expect(result.status).toBe('not_connected');
    expect(google.requests).toEqual([]);
    /**
     * And no run record either.
     *
     * A failed run every night for somebody who never asked for a calendar would
     * put a problem on their screen that they do not have.
     */
    expect(store.runs).toEqual([]);
    expect(store.connectionState.size).toBe(0);
  });

  it('records a run and a healthy connection when it worked', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token' },
      tasks: { [ALICE]: [task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')] },
    });
    await syncOneOwner(deps(store, fakeGoogle()), ALICE);

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].ownerId).toBe(ALICE);
    expect(store.runs[0].status).toBe('succeeded');
    expect(store.runs[0].rowsWritten).toBe(1);
    expect(store.connectionState.get(ALICE)?.status).toBe('connected');
  });

  it('learns the Google address from the event Google accepted, once', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token' },
      tasks: {
        [ALICE]: [
          task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
          task('a2b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
        ],
      },
    });
    await syncOneOwner(deps(store, fakeGoogle()), ALICE);

    // No identity scope was ever requested. This is the address on the event.
    expect(store.accounts.get(ALICE)).toBe('access-alice-token@example.test');
  });
});

/* ======================================== 8. the sweep covers every owner === */

describe('the scheduled sweep walks every connected owner independently', () => {
  it('syncs each one into their own calendar', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token', [BRUNO]: 'bruno-token', [CARA]: 'cara-token' },
      tasks: {
        [ALICE]: [task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
        [BRUNO]: [
          task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
          task('b2b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
        ],
        [CARA]: [task('c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
      },
    });
    const google = fakeGoogle();

    const sweep = await syncEveryConnectedOwner(deps(store, google));

    expect(sweep.owners).toBe(3);
    expect(sweep.created).toBe(4);
    expect(sweep.brokenOwners).toBe(0);

    // Three separate calendars, with the right number of events in each.
    expect(google.calendars.get('access-alice-token')?.size).toBe(1);
    expect(google.calendars.get('access-bruno-token')?.size).toBe(2);
    expect(google.calendars.get('access-cara-token')?.size).toBe(1);
  });

  it('skips owners who have no stored authorization', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token', [BRUNO]: null },
      tasks: {
        [ALICE]: [task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
        [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
      },
    });
    const sweep = await syncEveryConnectedOwner(deps(store, fakeGoogle()));

    expect(sweep.owners).toBe(1);
    expect(sweep.results.map((r) => r.ownerId)).toEqual([ALICE]);
  });

  it('writes one run record per owner, not one for the whole sweep', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token', [BRUNO]: 'bruno-token' },
      tasks: {
        [ALICE]: [task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
        [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
      },
    });
    await syncEveryConnectedOwner(deps(store, fakeGoogle()));

    // Each person's own screen reads their own run, so one shared record would
    // show somebody else's result as theirs.
    expect(store.runs.map((r) => r.ownerId).sort()).toEqual([ALICE, BRUNO].sort());
  });
});

/* ================================= 9. one owner failing stops nobody else === */

describe('one person broken authorization does not cost anybody else their calendar', () => {
  it('carries on past a refresh that Google refuses', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'expired-token', [BRUNO]: 'bruno-token', [CARA]: 'cara-token' },
      tasks: {
        [ALICE]: [task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
        [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
        [CARA]: [task('c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
      },
    });
    const google = fakeGoogle();

    const sweep = await syncEveryConnectedOwner(
      deps(store, google, { refreshFailsFor: ['expired-token'] }),
    );

    expect(sweep.owners).toBe(3);
    expect(sweep.brokenOwners).toBe(1);
    // The two healthy people still got their follow-ups.
    expect(sweep.created).toBe(2);
    expect(google.calendars.get('access-bruno-token')?.size).toBe(1);
    expect(google.calendars.get('access-cara-token')?.size).toBe(1);
  });

  it('records the failure against that owner alone', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'expired-token', [BRUNO]: 'bruno-token' },
      tasks: {
        [ALICE]: [task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
        [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
      },
    });

    await syncEveryConnectedOwner(
      deps(store, fakeGoogle(), { refreshFailsFor: ['expired-token'] }),
    );

    expect(store.connectionState.get(ALICE)?.status).toBe('error');
    expect(store.connectionState.get(BRUNO)?.status).toBe('connected');
    // And the reason never carries the token.
    expect(store.connectionState.get(ALICE)?.message).not.toContain('expired-token');
  });

  it('carries on past Google refusing the write itself', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token', [BRUNO]: 'bruno-token' },
      tasks: {
        [ALICE]: [task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
        [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
      },
    });
    const google = fakeGoogle({ failFor: ['access-alice-token'] });

    const sweep = await syncEveryConnectedOwner(deps(store, google));

    expect(sweep.brokenOwners).toBe(1);
    expect(sweep.created).toBe(1);
    expect(store.failedTasks.map((t) => t.ownerId)).toEqual([ALICE]);
  });

  it('carries on past a database read failing for one owner', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token', [BRUNO]: 'bruno-token' },
      tasks: { [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')] },
      tasksThrowFor: [ALICE],
    });

    const sweep = await syncEveryConnectedOwner(deps(store, fakeGoogle()));

    expect(sweep.owners).toBe(2);
    expect(sweep.brokenOwners).toBe(1);
    expect(sweep.created).toBe(1);
  });

  it('carries on past the token store itself failing for one owner', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token', [BRUNO]: 'bruno-token' },
      tasks: { [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')] },
      tokenReadThrows: [ALICE],
    });

    const sweep = await syncEveryConnectedOwner(deps(store, fakeGoogle()));

    expect(sweep.brokenOwners).toBe(1);
    expect(sweep.created).toBe(1);
  });

  it('one task failing does not cost that owner their other follow-ups', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token' },
      tasks: {
        [ALICE]: [
          task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
          // Not expressible as a Google event id, so pushFollowUpEvent refuses
          // it before making a request. A realistic single bad row.
          task('zzzz-not-base32hex'),
          task('a3b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
        ],
      },
    });

    const result = await syncOneOwner(deps(store, fakeGoogle()), ALICE);

    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    // Not 'failed': most of the work landed, and calling the whole run a failure
    // would hide two follow-ups that are genuinely on the calendar.
    expect(result.status).toBe('succeeded');
  });
});

/* ======================================== 10. three syncs, one event each === */

describe('running the sync again and again changes nothing', () => {
  const ids = [
    'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    'a2b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    'a3b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  ];

  it('leaves one event per task after three identical runs', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token' },
      tasks: { [ALICE]: ids.map((id) => task(id)) },
    });
    const google = fakeGoogle();
    const d = deps(store, google);

    const first = await syncOneOwner(d, ALICE);
    const second = await syncOneOwner(d, ALICE);
    const third = await syncOneOwner(d, ALICE);

    expect(first.created).toBe(3);
    // The second and third find the ids already there, so they patch.
    expect(second.created).toBe(0);
    expect(second.updated).toBe(3);
    expect(third.updated).toBe(3);

    // Three tasks, three events, after nine attempts.
    expect(google.calendars.get('access-alice-token')?.size).toBe(3);
  });

  it('does the same across a whole sweep of several owners', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token', [BRUNO]: 'bruno-token' },
      tasks: {
        [ALICE]: ids.map((id) => task(id)),
        [BRUNO]: [task('b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d')],
      },
    });
    const google = fakeGoogle();
    const d = deps(store, google);

    await syncEveryConnectedOwner(d);
    await syncEveryConnectedOwner(d);
    const third = await syncEveryConnectedOwner(d);

    expect(third.created).toBe(0);
    expect(third.updated).toBe(4);
    expect(google.calendars.get('access-alice-token')?.size).toBe(3);
    expect(google.calendars.get('access-bruno-token')?.size).toBe(1);
  });

  it('keeps the same event id for a task whose date moved', async () => {
    const store = fakeStore({
      tokens: { [ALICE]: 'alice-token' },
      tasks: { [ALICE]: [task(ids[0], { dueDate: '2026-10-12' })] },
    });
    const google = fakeGoogle();
    await syncOneOwner(deps(store, google), ALICE);

    const moved = fakeStore({
      tokens: { [ALICE]: 'alice-token' },
      tasks: { [ALICE]: [task(ids[0], { dueDate: '2026-10-19' })] },
    });
    const again = await syncOneOwner(deps(moved, google), ALICE);

    expect(again.updated).toBe(1);
    // Moving a date moves the entry rather than adding a second.
    expect(google.calendars.get('access-alice-token')?.size).toBe(1);
  });
});

/* ====================== 11 and 12. unrelated events are never even visible === */

describe('it can only ever address events it created itself', () => {
  const store = () =>
    fakeStore({
      tokens: { [ALICE]: 'alice-token' },
      tasks: {
        [ALICE]: [
          task('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
          task('a2b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'),
        ],
      },
    });

  it('never lists a calendar, so an unrelated event is not something it sees', async () => {
    const google = fakeGoogle();
    await syncOneOwner(deps(store(), google), ALICE);

    for (const request of google.requests) {
      expect(request.method, `a ${request.method} request was made`)
        .not.toBe('GET');
      // No list call, and no free text search over somebody's diary.
      expect(request.url).not.toContain('timeMin');
      expect(request.url).not.toContain('timeMax');
      expect(request.url).not.toMatch(/[?&]q=/);
      expect(request.url).not.toContain('/events?');
    }
  });

  it('never deletes anything, whatever happens', async () => {
    const google = fakeGoogle({ failFor: ['access-alice-token'] });
    await syncOneOwner(deps(store(), google), ALICE);
    const healthy = fakeGoogle();
    await syncOneOwner(deps(store(), healthy), ALICE);

    for (const request of [...google.requests, ...healthy.requests]) {
      expect(request.method).not.toBe('DELETE');
    }
  });

  it('addresses only ids derived from Cockpit task ids', async () => {
    const google = fakeGoogle();
    const d = deps(store(), google);
    await syncOneOwner(d, ALICE);
    // The second run patches, which is the only time an id appears in a path.
    await syncOneOwner(d, ALICE);

    const addressed = google.requests
      .filter((r) => r.url.includes('/events/'))
      .map((r) => decodeURIComponent(r.url.split('/events/')[1]));

    expect(addressed.length).toBeGreaterThan(0);
    for (const id of addressed) {
      // The prefix is what keeps these distinguishable from anything a person
      // created by hand, so an id without it would mean touching somebody's own
      // event.
      expect(id, id).toMatch(/^slc[a-v0-9]+$/);
    }
  });

  it('leaves a stored event alone when a later sync cannot reach it', async () => {
    const google = fakeGoogle();
    const first = store();
    await syncOneOwner(deps(first, google), ALICE);
    const before = new Map(google.calendars.get('access-alice-token'));

    const broken = fakeGoogle({ failFor: ['access-alice-token'] });
    const second = store();
    await syncOneOwner(deps(second, broken), ALICE);

    // The failed run recorded the failure on the tasks and did not clear their
    // ids, so the next good run updates these two rather than creating more.
    expect(second.failedTasks).toHaveLength(2);
    expect(second.syncedTasks).toEqual([]);
    expect(google.calendars.get('access-alice-token')).toEqual(before);
  });
});
