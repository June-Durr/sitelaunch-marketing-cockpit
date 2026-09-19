/**
 * The migrations, executed against a real Postgres.
 *
 * These replace guesswork with evidence. The defect that prompted them, a bare
 * ON DELETE SET NULL on a composite key that includes NOT NULL owner_id, passed
 * every string check in the previous suite while making it impossible to delete an
 * account. Only running the SQL catches that.
 *
 * Each test builds its own database, so nothing leaks between them and every test
 * also re-proves that the migrations apply cleanly from empty, in order.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_A, USER_B, freshDatabase, seedRow, type TestDatabase } from './harness';

let t: TestDatabase;

beforeEach(async () => {
  t = await freshDatabase();
});

afterEach(async () => {
  await t.close();
});

/** The usual starting point: an account and a post belonging to user A. */
async function accountAndPost() {
  const accountId = await seedRow(t, USER_A, 'accounts', {
    platform: 'instagram',
    handle: '@sitelaunchstudios',
  });
  const contentId = await seedRow(t, USER_A, 'content_items', {
    account_id: accountId,
    title: 'A post',
    format: 'post',
    status: 'published',
    published_at: '2026-09-19T12:00:00Z',
  });
  return { accountId, contentId };
}

const rows = async (sql: string, params: unknown[] = []) =>
  (await t.db.query<Record<string, unknown>>(sql, params)).rows;

const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];

async function expectRejected(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the database to reject this, and it did not');
}

/* ========================================================== migrations === */

describe('a fresh database takes every migration in order', () => {
  it('applies them all and creates every expected table', async () => {
    const tables = (
      await rows(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'
         order by table_name`,
      )
    ).map((r) => r.table_name);

    expect(tables).toEqual([
      'accounts', 'activity_events', 'content_items', 'ga4_daily_traffic',
      'integration_connections', 'leads', 'performance_snapshots',
      'recommendations', 'search_console_daily', 'sync_runs', 'tasks',
      'traffic_snapshots',
    ]);
  });

  it('creates both views', async () => {
    const views = (
      await rows(
        `select table_name from information_schema.views
         where table_schema = 'public' order by table_name`,
      )
    ).map((r) => r.table_name);
    expect(views).toEqual(['cohort_stats', 'content_latest_snapshot']);
  });

  it('turns row level security on for every owned table', async () => {
    const unprotected = await rows(
      `select relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(unprotected).toEqual([]);
  });
});

/* =================================================== SET NULL behaviour === */

describe('deleting a parent clears the relationship and keeps owner_id', () => {
  it('accounts: a deleted account leaves the post, with owner intact', async () => {
    const { accountId, contentId } = await accountAndPost();

    await t.db.query('delete from accounts where id = $1', [accountId]);

    const post = await one('select owner_id, account_id from content_items where id = $1', [
      contentId,
    ]);
    expect(post.account_id).toBeNull();
    expect(post.owner_id).toBe(USER_A);
  });

  it('content_items: a deleted post leaves the traffic row, with owner intact', async () => {
    const { contentId } = await accountAndPost();
    const trafficId = await seedRow(t, USER_A, 'traffic_snapshots', {
      content_item_id: contentId,
      range_start: '2026-09-18',
      range_end: '2026-09-19',
    });

    await t.db.query('delete from content_items where id = $1', [contentId]);

    const row = await one(
      'select owner_id, content_item_id from traffic_snapshots where id = $1',
      [trafficId],
    );
    expect(row.content_item_id).toBeNull();
    expect(row.owner_id).toBe(USER_A);
  });

  it('content_items: a deleted post leaves the lead, with owner intact', async () => {
    const { contentId } = await accountAndPost();
    const leadId = await seedRow(t, USER_A, 'leads', {
      content_item_id: contentId,
      prospect_name: 'Rivera Roofing',
    });

    await t.db.query('delete from content_items where id = $1', [contentId]);

    const row = await one('select owner_id, content_item_id from leads where id = $1', [
      leadId,
    ]);
    expect(row.content_item_id).toBeNull();
    expect(row.owner_id).toBe(USER_A);
  });

  it('activity keeps its owner when its post, lead or task is deleted', async () => {
    const { contentId } = await accountAndPost();
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Rivera' });
    const taskId = await seedRow(t, USER_A, 'tasks', {
      title: 'Call Rivera',
      due_date: '2026-09-20',
    });
    const activityId = await seedRow(t, USER_A, 'activity_events', {
      occurred_at: '2026-09-19T10:00:00Z',
      activity_type: 'follow_up_sent',
      title: 'Called Rivera',
      content_item_id: contentId,
      lead_id: leadId,
      task_id: taskId,
    });

    await t.db.query('delete from content_items where id = $1', [contentId]);
    let row = await one('select * from activity_events where id = $1', [activityId]);
    expect(row.content_item_id).toBeNull();
    expect(row.lead_id).toBe(leadId);
    expect(row.owner_id).toBe(USER_A);

    await t.db.query('delete from leads where id = $1', [leadId]);
    row = await one('select * from activity_events where id = $1', [activityId]);
    expect(row.lead_id).toBeNull();
    expect(row.owner_id).toBe(USER_A);

    await t.db.query('delete from tasks where id = $1', [taskId]);
    row = await one('select * from activity_events where id = $1', [activityId]);
    expect(row.task_id).toBeNull();
    expect(row.owner_id).toBe(USER_A);

    // The record of what happened survives losing everything it pointed at.
    expect(row.title).toBe('Called Rivera');
  });

  it('integration tables keep their owner when a connection is deleted', async () => {
    const connectionId = await seedRow(t, USER_A, 'integration_connections', {
      provider: 'ga4',
    });
    const runId = await seedRow(t, USER_A, 'sync_runs', {
      connection_id: connectionId,
      provider: 'ga4',
      idempotency_key: 'ga4:2026-09-19',
    });
    const trafficId = await seedRow(t, USER_A, 'ga4_daily_traffic', {
      connection_id: connectionId,
      date: '2026-09-19',
    });
    const scId = await seedRow(t, USER_A, 'search_console_daily', {
      connection_id: connectionId,
      date: '2026-09-19',
    });

    await t.db.query('delete from integration_connections where id = $1', [connectionId]);

    for (const [table, id] of [
      ['sync_runs', runId],
      ['ga4_daily_traffic', trafficId],
      ['search_console_daily', scId],
    ] as const) {
      const row = await one(`select owner_id, connection_id from ${table} where id = $1`, [
        id,
      ]);
      expect(row.connection_id, table).toBeNull();
      expect(row.owner_id, table).toBe(USER_A);
    }
  });

  it('never leaves a null owner_id anywhere after a cascade of deletions', async () => {
    const { accountId, contentId } = await accountAndPost();
    await seedRow(t, USER_A, 'leads', { content_item_id: contentId, prospect_name: 'X' });
    await seedRow(t, USER_A, 'traffic_snapshots', {
      content_item_id: contentId,
      range_start: '2026-09-18',
      range_end: '2026-09-19',
    });

    await t.db.query('delete from content_items where id = $1', [contentId]);
    await t.db.query('delete from accounts where id = $1', [accountId]);

    for (const table of ['leads', 'traffic_snapshots', 'content_items']) {
      const orphans = await rows(`select id from ${table} where owner_id is null`);
      expect(orphans, `${table} has rows with no owner`).toEqual([]);
    }
  });
});

/* ===================================================== CASCADE behaviour == */

describe('cascade relationships still cascade', () => {
  it('deleting a post removes its snapshots and its tasks', async () => {
    const { contentId } = await accountAndPost();
    await seedRow(t, USER_A, 'performance_snapshots', {
      content_item_id: contentId,
      window_type: '24h',
      captured_at: '2026-09-19T12:00:00Z',
      views: 31,
    });
    await seedRow(t, USER_A, 'tasks', {
      content_item_id: contentId,
      title: 'Check the numbers',
      due_date: '2026-09-20',
    });

    await t.db.query('delete from content_items where id = $1', [contentId]);

    expect(await rows('select id from performance_snapshots')).toEqual([]);
    expect(await rows('select id from tasks')).toEqual([]);
  });

  it('deleting a lead removes its tasks', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Rivera' });
    await seedRow(t, USER_A, 'tasks', {
      lead_id: leadId,
      title: 'Call Rivera',
      due_date: '2026-09-20',
    });

    await t.db.query('delete from leads where id = $1', [leadId]);
    expect(await rows('select id from tasks')).toEqual([]);
  });

  it('deleting the user removes everything they owned', async () => {
    await accountAndPost();
    await t.db.query('delete from auth.users where id = $1', [USER_A]);

    for (const table of ['accounts', 'content_items']) {
      expect(await rows(`select id from ${table}`), table).toEqual([]);
    }
  });
});

/* ================================================== cross-owner refusal === */

describe('a row cannot point at another owner', () => {
  it('refuses a post on somebody else account', async () => {
    const accountId = await seedRow(t, USER_B, 'accounts', {
      platform: 'instagram',
      handle: '@theirs',
    });

    const message = await expectRejected(() =>
      seedRow(t, USER_A, 'content_items', {
        account_id: accountId,
        title: 'Stolen',
        format: 'post',
        status: 'published',
        published_at: '2026-09-19T12:00:00Z',
      }),
    );
    expect(message).toMatch(/content_items_account_same_owner|foreign key/i);
  });

  it('refuses a snapshot on somebody else post', async () => {
    const theirContent = await seedRow(t, USER_B, 'content_items', {
      title: 'Theirs',
      format: 'post',
      status: 'published',
      published_at: '2026-09-19T12:00:00Z',
    });

    await expectRejected(() =>
      seedRow(t, USER_A, 'performance_snapshots', {
        content_item_id: theirContent,
        window_type: '24h',
        captured_at: '2026-09-19T12:00:00Z',
      }),
    );
  });

  it('refuses activity pointing at somebody else lead or task', async () => {
    const theirLead = await seedRow(t, USER_B, 'leads', { prospect_name: 'Theirs' });
    const theirTask = await seedRow(t, USER_B, 'tasks', {
      title: 'Theirs',
      due_date: '2026-09-20',
    });

    await expectRejected(() =>
      seedRow(t, USER_A, 'activity_events', {
        occurred_at: '2026-09-19T10:00:00Z',
        activity_type: 'other',
        title: 'Snooping',
        lead_id: theirLead,
      }),
    );
    await expectRejected(() =>
      seedRow(t, USER_A, 'activity_events', {
        occurred_at: '2026-09-19T10:00:00Z',
        activity_type: 'other',
        title: 'Snooping',
        task_id: theirTask,
      }),
    );
  });

  it('refuses a sync run on somebody else connection', async () => {
    const theirConnection = await seedRow(t, USER_B, 'integration_connections', {
      provider: 'ga4',
    });

    await expectRejected(() =>
      seedRow(t, USER_A, 'sync_runs', {
        connection_id: theirConnection,
        provider: 'ga4',
        idempotency_key: 'k',
      }),
    );
  });

  it('refuses the same theft through an update, not just an insert', async () => {
    const { contentId } = await accountAndPost();
    const theirAccount = await seedRow(t, USER_B, 'accounts', {
      platform: 'facebook',
      handle: '@theirs',
    });

    await expectRejected(() =>
      t.db.query('update content_items set account_id = $1 where id = $2', [
        theirAccount,
        contentId,
      ]),
    );
  });
});

/* ================================================== owner_id immutable ==== */

describe('owner_id cannot be changed once a row exists', () => {
  it('refuses handing a row to another user', async () => {
    const { contentId } = await accountAndPost();

    const message = await expectRejected(() =>
      t.db.query('update content_items set owner_id = $1 where id = $2', [
        USER_B,
        contentId,
      ]),
    );
    expect(message).toMatch(/owner_id cannot be changed/);
  });

  it('refuses it on every owned table', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Rivera' });
    const activityId = await seedRow(t, USER_A, 'activity_events', {
      occurred_at: '2026-09-19T10:00:00Z',
      activity_type: 'other',
      title: 'Something',
    });

    for (const [table, id] of [
      ['leads', leadId],
      ['activity_events', activityId],
    ] as const) {
      const message = await expectRejected(() =>
        t.db.query(`update ${table} set owner_id = $1 where id = $2`, [USER_B, id]),
      );
      expect(message, table).toMatch(/owner_id cannot be changed/);
    }
  });

  it('still allows a normal edit that leaves owner_id alone', async () => {
    const { contentId } = await accountAndPost();
    await t.db.query('update content_items set title = $1 where id = $2', [
      'Renamed',
      contentId,
    ]);

    const row = await one('select title, owner_id from content_items where id = $1', [
      contentId,
    ]);
    expect(row.title).toBe('Renamed');
    expect(row.owner_id).toBe(USER_A);
  });
});

/* ============================================ row level security ========= */

describe('row level security keeps users apart', () => {
  beforeEach(async () => {
    await seedRow(t, USER_A, 'accounts', { platform: 'instagram', handle: '@a' });
    await seedRow(t, USER_B, 'accounts', { platform: 'instagram', handle: '@b' });
  });

  it('shows each user only their own rows', async () => {
    const aSees = await t.asUser(USER_A, () => rows('select handle from accounts'));
    const bSees = await t.asUser(USER_B, () => rows('select handle from accounts'));

    expect(aSees.map((r) => r.handle)).toEqual(['@a']);
    expect(bSees.map((r) => r.handle)).toEqual(['@b']);
  });

  it('hides another user row even when asked for by id', async () => {
    const theirId = (await one('select id from accounts where handle = $1', ['@b'])).id;
    const found = await t.asUser(USER_A, () =>
      rows('select id from accounts where id = $1', [theirId]),
    );
    expect(found).toEqual([]);
  });

  it('refuses to let a user insert a row owned by somebody else', async () => {
    await t.asUser(USER_A, async () => {
      await expectRejected(() =>
        t.db.query(
          `insert into accounts (owner_id, platform, handle) values ($1, 'instagram', '@forged')`,
          [USER_B],
        ),
      );
    });
  });

  it('refuses to let a user delete another user row', async () => {
    await t.asUser(USER_A, () => t.db.query(`delete from accounts where handle = '@b'`));
    // Still there: the delete matched nothing, rather than removing it.
    const still = await rows(`select handle from accounts where handle = '@b'`);
    expect(still).toHaveLength(1);
  });

  it('shows an anonymous visitor nothing at all', async () => {
    const seen = await t.asAnon(() => rows('select handle from accounts'));
    expect(seen).toEqual([]);
  });
});

/* ====================================================== views and RLS ==== */

describe('the views respect row level security', () => {
  beforeEach(async () => {
    for (const [user, handle] of [
      [USER_A, '@a'],
      [USER_B, '@b'],
    ] as const) {
      const accountId = await seedRow(t, user, 'accounts', {
        platform: 'instagram',
        handle,
      });
      const contentId = await seedRow(t, user, 'content_items', {
        account_id: accountId,
        title: `${handle} post`,
        format: 'story',
        status: 'measured',
        published_at: '2026-09-19T12:00:00Z',
      });
      await seedRow(t, user, 'performance_snapshots', {
        content_item_id: contentId,
        window_type: '24h',
        captured_at: '2026-09-19T12:00:00Z',
        views: user === USER_A ? 10 : 5000,
      });
    }
  });

  it('runs both views as the caller, not the view owner', async () => {
    const options = await rows(
      `select c.relname, c.reloptions from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v' order by c.relname`,
    );
    for (const view of options) {
      expect(String(view.reloptions), String(view.relname)).toContain(
        'security_invoker=true',
      );
    }
  });

  it('gives each user only their own rows through content_latest_snapshot', async () => {
    const aSees = await t.asUser(USER_A, () =>
      rows('select views from content_latest_snapshot'),
    );
    expect(aSees).toHaveLength(1);
    expect(Number(aSees[0].views)).toBe(10);

    const bSees = await t.asUser(USER_B, () =>
      rows('select views from content_latest_snapshot'),
    );
    expect(bSees).toHaveLength(1);
    expect(Number(bSees[0].views)).toBe(5000);
  });

  it('does not mix owners together in cohort_stats', async () => {
    const aStats = await t.asUser(USER_A, () =>
      rows('select cohort_size, views_mean from cohort_stats'),
    );
    expect(aStats).toHaveLength(1);
    expect(Number(aStats[0].cohort_size)).toBe(1);
    // The other user's 5000 views must not be anywhere in this average.
    expect(Number(aStats[0].views_mean)).toBe(10);
  });

  it('refuses an anonymous visitor entirely', async () => {
    await t.asAnon(async () => {
      await expectRejected(() => t.db.query('select * from cohort_stats'));
      await expectRejected(() => t.db.query('select * from content_latest_snapshot'));
    });
  });
});

/* ================================================= idempotent imports ==== */

describe('repeated daily imports upsert rather than duplicate', () => {
  const upsertGa4 = (sessions: number) =>
    t.db.query(
      `insert into ga4_daily_traffic (owner_id, date, source, medium, campaign, sessions)
       values ($1, '2026-09-19', 'instagram', 'story', 'bts_2026_09', $2)
       on conflict (owner_id, date, source, medium, campaign)
       do update set sessions = excluded.sessions, synced_at = now()`,
      [USER_A, sessions],
    );

  it('leaves one row after ten identical runs', async () => {
    for (let i = 0; i < 10; i += 1) await upsertGa4(4);
    expect(await rows('select id from ga4_daily_traffic')).toHaveLength(1);
  });

  it('updates the figure when a provider restates a day', async () => {
    await upsertGa4(4);
    await upsertGa4(9);
    const row = await one('select sessions from ga4_daily_traffic');
    expect(Number(row.sessions)).toBe(9);
  });

  it('refuses a duplicate day when inserted without the conflict clause', async () => {
    await upsertGa4(4);
    const message = await expectRejected(() =>
      seedRow(t, USER_A, 'ga4_daily_traffic', {
        date: '2026-09-19',
        source: 'instagram',
        medium: 'story',
        campaign: 'bts_2026_09',
      }),
    );
    expect(message).toMatch(/unique|duplicate/i);
  });

  it('keeps two owners days apart', async () => {
    await upsertGa4(4);
    await seedRow(t, USER_B, 'ga4_daily_traffic', {
      date: '2026-09-19',
      source: 'instagram',
      medium: 'story',
      campaign: 'bts_2026_09',
      sessions: 99,
    });
    expect(await rows('select id from ga4_daily_traffic')).toHaveLength(2);
  });

  it('treats an empty dimension as a value, so two such days stay separate', async () => {
    for (const date of ['2026-09-18', '2026-09-19']) {
      await seedRow(t, USER_A, 'ga4_daily_traffic', { date, sessions: 1 });
    }
    const all = await rows('select date, campaign from ga4_daily_traffic order by date');
    expect(all).toHaveLength(2);
    // The default placeholder, not null, is what makes the unique index work.
    expect(all[0].campaign).toBe('(none)');
  });

  it('refuses a repeated sync run idempotency key', async () => {
    await seedRow(t, USER_A, 'sync_runs', {
      provider: 'ga4',
      idempotency_key: 'ga4:2026-09-19',
    });
    await expectRejected(() =>
      seedRow(t, USER_A, 'sync_runs', {
        provider: 'ga4',
        idempotency_key: 'ga4:2026-09-19',
      }),
    );
  });
});

/* ============================================ activity and calendar ====== */

describe('activity cannot be duplicated by finishing a task twice', () => {
  it('refuses a second task_completion record for the same task', async () => {
    const taskId = await seedRow(t, USER_A, 'tasks', {
      title: 'Call Rivera',
      due_date: '2026-09-20',
    });
    const make = () =>
      seedRow(t, USER_A, 'activity_events', {
        occurred_at: '2026-09-19T10:00:00Z',
        activity_type: 'follow_up_sent',
        title: 'Called Rivera',
        task_id: taskId,
        source: 'task_completion',
      });

    await make();
    await expectRejected(make);
    expect(await rows('select id from activity_events')).toHaveLength(1);
  });

  it('still allows a hand written note about the same task', async () => {
    const taskId = await seedRow(t, USER_A, 'tasks', {
      title: 'Call Rivera',
      due_date: '2026-09-20',
    });
    await seedRow(t, USER_A, 'activity_events', {
      occurred_at: '2026-09-19T10:00:00Z',
      activity_type: 'follow_up_sent',
      title: 'Automatic',
      task_id: taskId,
      source: 'task_completion',
    });
    await seedRow(t, USER_A, 'activity_events', {
      occurred_at: '2026-09-19T11:00:00Z',
      activity_type: 'reply_received',
      title: 'They replied',
      task_id: taskId,
      source: 'manual',
    });

    expect(await rows('select id from activity_events')).toHaveLength(2);
  });
});

describe('a synced calendar event cannot land twice', () => {
  it('refuses the same external event on activity', async () => {
    const make = () =>
      seedRow(t, USER_A, 'activity_events', {
        occurred_at: '2026-09-19T10:00:00Z',
        activity_type: 'networking_event',
        title: 'Meetup',
        external_calendar_id: 'cal_1',
        external_event_id: 'evt_1',
        source: 'calendar',
      });

    await make();
    await expectRejected(make);
  });

  it('refuses the same external event on a task', async () => {
    const make = () =>
      seedRow(t, USER_A, 'tasks', {
        title: 'Meetup',
        due_date: '2026-09-20',
        external_calendar_id: 'cal_1',
        external_event_id: 'evt_1',
      });

    await make();
    await expectRejected(make);
  });

  it('lets two rows sit unsynced, since almost every row has no event id', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedRow(t, USER_A, 'tasks', { title: `Task ${i}`, due_date: '2026-09-20' });
    }
    expect(await rows('select id from tasks')).toHaveLength(3);
  });
});

/* ============================================ unknown is still not zero == */

describe('unknown metrics stay null in the database', () => {
  it('leaves every unrecorded metric null rather than defaulting to zero', async () => {
    const { contentId } = await accountAndPost();
    await seedRow(t, USER_A, 'performance_snapshots', {
      content_item_id: contentId,
      window_type: '24h',
      captured_at: '2026-09-19T12:00:00Z',
      views: 31,
    });

    const row = await one('select * from performance_snapshots');
    expect(Number(row.views)).toBe(31);
    for (const metric of ['likes', 'shares', 'saves', 'leads', 'qualified_leads']) {
      expect(row[metric], metric).toBeNull();
    }
  });

  it('keeps a recorded zero distinct from an unrecorded metric', async () => {
    const { contentId } = await accountAndPost();
    await seedRow(t, USER_A, 'performance_snapshots', {
      content_item_id: contentId,
      window_type: '24h',
      captured_at: '2026-09-19T12:00:00Z',
      link_clicks: 0,
    });

    const row = await one('select link_clicks, views from performance_snapshots');
    expect(Number(row.link_clicks)).toBe(0);
    expect(row.views).toBeNull();
  });
});

/* ============================================ the seed workflow ========== */

describe('the seed runs after the migrations, once a user exists', () => {
  it('applies cleanly and attaches every row to the signed in user', async () => {
    const seed = readFileSync('supabase/seed.sql', 'utf8');

    // Sign in as user A, exactly as the instructions in the file say to.
    await t.db.query('select set_config($1, $2, false)', [
      'request.jwt.claim.sub',
      USER_A,
    ]);
    await t.db.exec(seed);

    const accounts = await rows('select owner_id, handle from accounts order by handle');
    expect(accounts).toHaveLength(2);
    for (const account of accounts) {
      expect(account.owner_id).toBe(USER_A);
    }

    const content = await rows('select owner_id, title from content_items');
    expect(content).toHaveLength(3);
    for (const item of content) expect(item.owner_id).toBe(USER_A);

    // The one observed figure survives, and the unrecorded ones stay null.
    const snapshot = await one(
      `select views, likes, link_clicks from performance_snapshots where views is not null`,
    );
    expect(Number(snapshot.views)).toBe(31);
    expect(snapshot.likes).toBeNull();
    expect(snapshot.link_clicks).toBeNull();
  });

  it('is rejected on an empty project, which is why it is not a migration', async () => {
    // No signed in user and no users at all: the file refuses rather than guessing.
    const empty = await freshDatabase();
    await empty.db.exec('delete from auth.users');

    const message = await (async () => {
      try {
        await empty.db.exec(readFileSync('supabase/seed.sql', 'utf8'));
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    })();

    expect(message).toMatch(/No user found/);
    await empty.close();
  });
});
