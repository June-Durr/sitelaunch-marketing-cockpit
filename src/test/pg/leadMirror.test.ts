/**
 * The lead mirror reconciliation, run against a real Postgres.
 *
 * PGlite is PostgreSQL compiled to WebAssembly, so the unique indexes, the
 * triggers and row level security behave as they will on Supabase. That matters
 * here more than anywhere: the promise that importing three times does not
 * duplicate anything rests on two partial unique indexes, and no amount of
 * string-matching on the SQL would prove they work.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT
 *
 * The plan comes from the real planner in server/integrations/leadMirror.ts. The
 * writes are the same statements supabase/functions/_shared/leadMirrorStore.ts
 * makes, reproduced here in SQL, because that file imports the Supabase client
 * from jsr: and cannot be loaded in this runtime.
 *
 * THE TOUCH UPSERT IS WRITTEN THE WAY POSTGREST WRITES IT, ON PURPOSE
 *
 * An earlier version of this file spelled the conflict target as
 * `on conflict (...) where external_id is not null and external_source is not
 * null do nothing`. That passed, and the real import failed, because PostgREST's
 * onConflict parameter is a list of column names with nowhere to put a WHERE
 * clause, and Postgres will not use a partial unique index as an arbiter unless
 * the statement restates its predicate. Writing the predicate here reproduced the
 * intent and not the mechanism, which is the only kind of test that is worse than
 * no test at all. The bare form below is what the client actually sends, so this
 * now fails if the index ever goes back to being partial. See migration 0008.
 *
 * Every record here is invented. No production data is needed to run this.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEAD_HEADERS, MIRROR_SOURCE, TOUCH_HEADERS, dayToTimestamp, parseLeadRows,
  parseTouchRows, planReconciliation, type ExistingActivity, type ExistingLead,
  type ReconciliationPlan,
} from '../../../server/integrations/leadMirror';
import { freshDatabase, seedRow, USER_A, USER_B, type TestDatabase } from './harness';

let t: TestDatabase;

beforeEach(async () => {
  t = await freshDatabase();
});

afterEach(async () => {
  await t.close();
});

/* ---------------------------------------------------------------- the sheet --- */

function leadRow(values: Partial<Record<(typeof LEAD_HEADERS)[number], string>>): string[] {
  return LEAD_HEADERS.map((header) => values[header] ?? '');
}

function touchRow(values: Partial<Record<(typeof TOUCH_HEADERS)[number], string>>): string[] {
  return TOUCH_HEADERS.map((header) => values[header] ?? '');
}

/**
 * A small sheet with the shapes that actually appear in the real one: a lead with
 * everything filled in, a lead that is deliberately not scheduled, and a lead with
 * a reported last-touch date and no touch history behind it.
 */
const SHEET_LEADS = [
  leadRow({
    'Lead ID': 'taylor-handyman',
    Contact: 'Taylor',
    Organization: 'Your Local Handyman',
    Relationship: 'Prospect',
    Stage: 'Follow-up',
    'Current status': 'Awaiting materials',
    Source: 'Flyer',
    'First contact': '09/19/26',
    'Last touch': '09/24/26',
    'Days since touch': '11',
    'Next action': 'Send one concise final follow-up',
    'Next follow-up': '10/06/26',
    'Follow-up status': 'DUE SOON',
    Channel: 'Phone + email',
    Email: 'taylor@example.com',
    'Context / notes': 'Cold call on Sep 19.',
    'Record confidence': 'Confirmed',
  }),
  leadRow({
    'Lead ID': 'olde-capital',
    Contact: 'Name pending',
    Organization: 'Olde Capital Investments',
    Stage: 'Waiting',
    'Next action': 'No action unless they re-engage',
    'Follow-up status': 'NOT SCHEDULED',
    'Record confidence': 'Incomplete',
  }),
  leadRow({
    'Lead ID': 'moth-to-flame',
    Contact: 'Tyson Harvey',
    Organization: 'Moth to Flame',
    Stage: 'Waiting',
    'Last touch': '09/13/26',
    'Next follow-up': '11/09/26',
    'Follow-up status': 'SCHEDULED',
    Email: 'tyson@example.com',
  }),
];

const SHEET_TOUCHES = [
  touchRow({
    Date: '09/24/26',
    'Lead ID': 'taylor-handyman',
    Contact: 'Taylor',
    Organization: 'Your Local Handyman',
    Activity: 'Follow-up sent',
    Channel: 'Email',
    Details: 'Second attempt',
    'Evidence / source': 'Gmail',
  }),
  touchRow({
    Date: '09/19/26',
    'Lead ID': 'taylor-handyman',
    Contact: 'Taylor',
    Organization: 'Your Local Handyman',
    Activity: 'Discovery conversation',
    Channel: 'Phone',
    'Evidence / source': 'User report',
  }),
];

/* --------------------------------------------------------------- the applier --- */

/** Everything in the database that the planner needs to see, as the owner. */
async function readState(owner: string): Promise<{
  leads: ExistingLead[];
  activities: ExistingActivity[];
}> {
  const leads = await t.db.query<ExistingLead>(
    `select id, prospect_name, organization, email, external_source, external_key,
            relationship, stage, current_status, source, first_contact_at,
            reported_last_touch_at, next_action, next_action_date, follow_up_mode,
            preferred_channel, phone, proposed_value, notes, record_confidence
     from leads where owner_id = $1`,
    [owner],
  );
  const activities = await t.db.query<ExistingActivity>(
    `select external_source, external_id from activity_events
     where owner_id = $1 and external_source = $2`,
    [owner, MIRROR_SOURCE],
  );
  return { leads: leads.rows, activities: activities.rows };
}

/**
 * The same writes the Edge Function's store makes, in SQL.
 *
 * Deliberately not clever: insert the creates, patch exactly the changed fields
 * on the updates, insert the touches with an ON CONFLICT DO NOTHING against the
 * index from migration 0007. If the plan is ever wrong about what already exists,
 * that conflict clause is what still stops a duplicate.
 */
async function applyPlan(owner: string, plan: ReconciliationPlan) {
  let leadsCreated = 0;
  let leadsUpdated = 0;
  let touchesCreated = 0;
  const idByKey = new Map<string, string>();

  for (const entry of plan.leads) {
    if (entry.action === 'ambiguous') continue;
    if (entry.leadId !== null) idByKey.set(entry.row.leadKey, entry.leadId);
  }

  for (const entry of plan.leads) {
    if (entry.action !== 'create') continue;
    const fields: Record<string, unknown> = {
      owner_id: owner,
      external_source: MIRROR_SOURCE,
      external_key: entry.row.leadKey,
      ...entry.fields,
      is_seed: false,
    };
    const keys = Object.keys(fields);
    const result = await t.db.query<{ id: string }>(
      `insert into leads (${keys.join(', ')})
       values (${keys.map((_, i) => `$${i + 1}`).join(', ')})
       returning id`,
      Object.values(fields),
    );
    idByKey.set(entry.row.leadKey, result.rows[0].id);
    leadsCreated += 1;
  }

  for (const entry of plan.leads) {
    if (entry.action !== 'update') continue;
    const patch: Record<string, unknown> = {};
    for (const change of entry.changes) patch[change.field] = change.to;
    patch.external_source = MIRROR_SOURCE;
    patch.external_key = entry.row.leadKey;

    const keys = Object.keys(patch);
    await t.db.query(
      `update leads set ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
       where id = $${keys.length + 1} and owner_id = $${keys.length + 2}`,
      [...Object.values(patch), entry.leadId, owner],
    );
    idByKey.set(entry.row.leadKey, entry.leadId as string);
    leadsUpdated += 1;
  }

  for (const touch of plan.touches) {
    if (touch.action !== 'create') continue;
    const leadId = idByKey.get(touch.row.leadKey);
    // A touch with nobody to attach to is left out, never written orphaned.
    if (leadId === undefined) continue;

    const result = await t.db.query<{ id: string }>(
      `insert into activity_events
         (owner_id, occurred_at, activity_type, title, details, source,
          external_source, external_id, channel, evidence_source, lead_id, is_seed)
       values ($1, $2, $3, $4, $5, 'import', $6, $7, $8, $9, $10, false)
       on conflict (owner_id, external_source, external_id) do nothing
       returning id`,
      [
        owner,
        dayToTimestamp(touch.row.occurredOn),
        touch.row.activityType,
        touch.row.activityLabel,
        touch.row.details,
        MIRROR_SOURCE,
        touch.row.externalId,
        touch.row.channel,
        touch.row.evidenceSource,
        leadId,
      ],
    );
    touchesCreated += result.rows.length;
  }

  return { leadsCreated, leadsUpdated, touchesCreated, idByKey };
}

/** One full reconciliation, as the function would run it. */
async function reconcile(owner: string) {
  const state = await readState(owner);
  const plan = planReconciliation({
    leads: parseLeadRows(SHEET_LEADS),
    touches: parseTouchRows(SHEET_TOUCHES),
    existingLeads: state.leads,
    existingActivities: state.activities,
  });
  const applied = await applyPlan(owner, plan);
  return { plan, applied };
}

async function counts(owner: string) {
  const leads = await t.db.query<{ n: string }>(
    'select count(*)::text as n from leads where owner_id = $1',
    [owner],
  );
  const activities = await t.db.query<{ n: string }>(
    'select count(*)::text as n from activity_events where owner_id = $1',
    [owner],
  );
  return { leads: Number(leads.rows[0].n), activities: Number(activities.rows[0].n) };
}

/* ========================================================== the main event === */

describe('running the whole reconciliation three times', () => {
  it('imports everything once and then changes nothing at all', async () => {
    const first = await reconcile(USER_A);
    expect(first.applied).toMatchObject({
      leadsCreated: 3,
      leadsUpdated: 0,
      touchesCreated: 2,
    });
    expect(await counts(USER_A)).toEqual({ leads: 3, activities: 2 });

    const second = await reconcile(USER_A);
    expect(second.applied).toMatchObject({
      leadsCreated: 0,
      leadsUpdated: 0,
      touchesCreated: 0,
    });
    expect(await counts(USER_A)).toEqual({ leads: 3, activities: 2 });

    const third = await reconcile(USER_A);
    expect(third.applied).toMatchObject({
      leadsCreated: 0,
      leadsUpdated: 0,
      touchesCreated: 0,
    });
    expect(await counts(USER_A)).toEqual({ leads: 3, activities: 2 });

    // And the plan itself says so, not just the row counts.
    expect(third.plan.leadsUnchanged).toBe(3);
    expect(third.plan.touchesAlreadyPresent).toBe(2);
    expect(third.plan.ambiguous).toEqual([]);
    expect(third.plan.rejected).toEqual([]);
  });

  it('keeps every activity pointing at the right person, run after run', async () => {
    await reconcile(USER_A);
    await reconcile(USER_A);
    await reconcile(USER_A);

    const linked = await t.db.query<{
      title: string;
      prospect_name: string;
      external_key: string;
      occurred_on: string | Date;
    }>(
      `select a.title, l.prospect_name, l.external_key,
              (a.occurred_at at time zone 'UTC')::date as occurred_on
       from activity_events a
       join leads l on l.id = a.lead_id
       where a.owner_id = $1
       order by a.occurred_at`,
      [USER_A],
    );

    expect(linked.rows).toHaveLength(2);
    for (const row of linked.rows) {
      expect(row.external_key).toBe('taylor-handyman');
      expect(row.prospect_name).toBe('Taylor');
    }
    expect(linked.rows.map((r) => r.title)).toEqual([
      'Discovery conversation',
      'Follow-up sent',
    ]);

    // The day written is the day read back, which is why noon UTC is used.
    const days = linked.rows.map((r) =>
      typeof r.occurred_on === 'string'
        ? r.occurred_on.slice(0, 10)
        : r.occurred_on.toISOString().slice(0, 10),
    );
    expect(days).toEqual(['2026-09-19', '2026-09-24']);

    // No activity ever ends up without a person.
    const orphans = await t.db.query(
      `select id from activity_events
       where owner_id = $1 and external_source = $2 and lead_id is null`,
      [USER_A, MIRROR_SOURCE],
    );
    expect(orphans.rows).toEqual([]);
  });

  it('turns a readable sheet id into a uuid primary key, keeping both', async () => {
    await reconcile(USER_A);

    const rows = await t.db.query<{ id: string; external_key: string }>(
      'select id, external_key from leads where owner_id = $1 order by external_key',
      [USER_A],
    );
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (const row of rows.rows) {
      // The database chose the id, and the sheet's own key is kept beside it.
      expect(UUID.test(row.id), row.external_key).toBe(true);
      expect(UUID.test(row.external_key), row.external_key).toBe(false);
    }
    expect(rows.rows.map((r) => r.external_key)).toEqual([
      'moth-to-flame', 'olde-capital', 'taylor-handyman',
    ]);
  });

  it('writes blanks as null and never as a zero or an empty string', async () => {
    await reconcile(USER_A);

    const olde = await t.db.query<Record<string, unknown>>(
      'select * from leads where owner_id = $1 and external_key = $2',
      [USER_A, 'olde-capital'],
    );
    const row = olde.rows[0];

    for (const column of [
      'email', 'phone', 'proposed_value', 'first_contact_at', 'reported_last_touch_at',
      'next_action_date', 'relationship', 'current_status', 'preferred_channel',
      'source', 'notes',
    ]) {
      expect(row[column], column).toBeNull();
    }
    // The ones it did have are there.
    expect(row.next_action).toBe('No action unless they re-engage');
    expect(row.record_confidence).toBe('Incomplete');
  });

  it('records a deliberate NOT SCHEDULED as a mode rather than as a missing date', async () => {
    await reconcile(USER_A);

    const rows = await t.db.query<{ external_key: string; follow_up_mode: string }>(
      'select external_key, follow_up_mode from leads where owner_id = $1 order by external_key',
      [USER_A],
    );
    const modes = Object.fromEntries(rows.rows.map((r) => [r.external_key, r.follow_up_mode]));

    expect(modes['olde-capital']).toBe('none');
    expect(modes['taylor-handyman']).toBe('auto');
    expect(modes['moth-to-flame']).toBe('auto');
  });

  it('keeps a reported last-touch date without inventing an activity for it', async () => {
    await reconcile(USER_A);

    const moth = await t.db.query<{ id: string; reported_last_touch_at: string | Date }>(
      'select id, reported_last_touch_at from leads where owner_id = $1 and external_key = $2',
      [USER_A, 'moth-to-flame'],
    );
    expect(moth.rows[0].reported_last_touch_at).not.toBeNull();

    // And no activity was fabricated to carry it.
    const activities = await t.db.query(
      'select id from activity_events where owner_id = $1 and lead_id = $2',
      [USER_A, moth.rows[0].id],
    );
    expect(activities.rows).toEqual([]);

    // The derivation then reports it as reported, not as something logged.
    const state = await t.db.query<{ last_touch_basis: string }>(
      'select last_touch_basis from lead_follow_up_state($1) where lead_id = $2',
      ['2026-10-05', moth.rows[0].id],
    );
    expect(state.rows[0].last_touch_basis).toBe('reported');
  });

  it('leaves everything the sheet never mentions exactly as it was', async () => {
    const untouchedId = await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Somebody Added In The Cockpit',
      organization: 'Not In The Sheet',
      email: 'cockpit@example.com',
      stage: 'qualified',
      notes: 'A note nobody should touch',
      proposed_value: 4200,
    });
    const before = await t.db.query<Record<string, unknown>>(
      'select * from leads where id = $1',
      [untouchedId],
    );

    await reconcile(USER_A);
    await reconcile(USER_A);

    const after = await t.db.query<Record<string, unknown>>(
      'select * from leads where id = $1',
      [untouchedId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await counts(USER_A)).toEqual({ leads: 4, activities: 2 });
  });

  it('never reaches into another account', async () => {
    await reconcile(USER_A);
    expect(await counts(USER_B)).toEqual({ leads: 0, activities: 0 });

    // The same sheet reconciled for a second owner creates their own copies.
    await reconcile(USER_B);
    expect(await counts(USER_B)).toEqual({ leads: 3, activities: 2 });
    expect(await counts(USER_A)).toEqual({ leads: 3, activities: 2 });
  });
});

/* =============================================== the database's own guards === */

describe('the database refuses a duplicate even if the code asks for one', () => {
  it('will not accept two leads with the same mirror key', async () => {
    await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Taylor',
      external_source: MIRROR_SOURCE,
      external_key: 'taylor-handyman',
    });

    await expect(
      seedRow(t, USER_A, 'leads', {
        prospect_name: 'Taylor Again',
        external_source: MIRROR_SOURCE,
        external_key: 'taylor-handyman',
      }),
    ).rejects.toThrow(/leads_unique_external_key|duplicate key/i);
  });

  it('lets two different owners use the same key, because they are different sheets', async () => {
    await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Mine',
      external_source: MIRROR_SOURCE,
      external_key: 'taylor-handyman',
    });
    await expect(
      seedRow(t, USER_B, 'leads', {
        prospect_name: 'Theirs',
        external_source: MIRROR_SOURCE,
        external_key: 'taylor-handyman',
      }),
    ).resolves.toBeTruthy();
  });

  it('lets any number of leads have no key at all', async () => {
    for (const name of ['One', 'Two', 'Three']) {
      await expect(
        seedRow(t, USER_A, 'leads', { prospect_name: name }),
      ).resolves.toBeTruthy();
    }
  });

  it('will not accept two activities with the same fingerprint', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    const shared = {
      occurred_at: '2026-09-24T12:00:00.000Z',
      activity_type: 'follow_up_sent',
      title: 'Follow-up sent',
      source: 'import',
      external_source: MIRROR_SOURCE,
      external_id: 'touch\u001ftaylor-handyman\u001f2026-09-24\u001ffollow-up sent\u001femail',
      lead_id: leadId,
    };

    await expect(seedRow(t, USER_A, 'activity_events', shared)).resolves.toBeTruthy();
    await expect(seedRow(t, USER_A, 'activity_events', shared)).rejects.toThrow(
      /activity_events_unique_external_key|duplicate key/i,
    );
  });

  it('accepts the bare ON CONFLICT that PostgREST actually sends', async () => {
    /**
     * The regression this exists for.
     *
     * A partial unique index enforces the right rule and still cannot arbitrate
     * an upsert, so the first live reconciliation created every lead and then
     * failed on every touch. Nothing in the suite noticed, because the only test
     * that exercised the conflict wrote a predicate the real client cannot send.
     */
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    const insert = `
      insert into activity_events
        (owner_id, occurred_at, activity_type, title, source, external_source,
         external_id, lead_id)
      values ($1, $2, 'follow_up_sent', 'Follow-up sent', 'import', $3, $4, $5)
      on conflict (owner_id, external_source, external_id) do nothing
      returning id`;
    const args = [
      USER_A, '2026-09-24T12:00:00.000Z', MIRROR_SOURCE, 'touch-fingerprint', leadId,
    ];

    const first = await t.db.query<{ id: string }>(insert, args);
    expect(first.rows).toHaveLength(1);

    // And the second one is silently ignored rather than raising, which is what
    // ignoreDuplicates means in the store.
    const second = await t.db.query<{ id: string }>(insert, args);
    expect(second.rows).toHaveLength(0);

    const total = await t.db.query<{ n: string }>(
      'select count(*)::text as n from activity_events where owner_id = $1',
      [USER_A],
    );
    expect(Number(total.rows[0].n)).toBe(1);
  });

  it('lets any number of activities have no external id', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    for (const title of ['One', 'Two', 'Three']) {
      await expect(
        seedRow(t, USER_A, 'activity_events', {
          occurred_at: '2026-09-24T12:00:00.000Z',
          activity_type: 'follow_up_sent',
          title,
          lead_id: leadId,
        }),
      ).resolves.toBeTruthy();
    }
  });
});

describe('the rule owns one follow-up per lead and no more', () => {
  it('refuses a second rule-managed follow-up for the same lead', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    const task = {
      title: 'Follow up with Taylor',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-10-12',
      lead_id: leadId,
      follow_up_rule_managed: true,
    };

    await expect(seedRow(t, USER_A, 'tasks', task)).resolves.toBeTruthy();
    await expect(seedRow(t, USER_A, 'tasks', task)).rejects.toThrow(
      /tasks_one_managed_follow_up_per_lead|duplicate key/i,
    );
  });

  it('still refuses a second one once the first has been finished', async () => {
    /**
     * Why the index is not scoped to open tasks.
     *
     * The rule's task recurs: finishing it reopens it. An index that only looked
     * at open tasks would let a second one be created the moment the first was
     * marked done, which is precisely the duplicate this is meant to prevent.
     */
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    const first = await seedRow(t, USER_A, 'tasks', {
      title: 'Follow up with Taylor',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-10-12',
      lead_id: leadId,
      follow_up_rule_managed: true,
    });

    await t.db.query('update tasks set status = $1 where id = $2', ['done', first]);

    await expect(
      seedRow(t, USER_A, 'tasks', {
        title: 'Follow up with Taylor',
        task_type: 'follow_up',
        status: 'open',
        due_date: '2026-10-19',
        lead_id: leadId,
        follow_up_rule_managed: true,
      }),
    ).rejects.toThrow(/tasks_one_managed_follow_up_per_lead|duplicate key/i);
  });

  it('does not stop somebody keeping their own follow-up for the same lead', async () => {
    // The rule owns one task. It does not own the person's task list.
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    await seedRow(t, USER_A, 'tasks', {
      title: 'Follow up with Taylor',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-10-12',
      lead_id: leadId,
      follow_up_rule_managed: true,
    });
    await expect(
      seedRow(t, USER_A, 'tasks', {
        title: 'Drop off the printed mockup',
        task_type: 'follow_up',
        status: 'open',
        due_date: '2026-10-13',
        lead_id: leadId,
      }),
    ).resolves.toBeTruthy();
  });

  it('keeps the history in the activity log rather than in finished tasks', async () => {
    /**
     * Where the record of what was chased actually lives.
     *
     * One recurring task means there is no trail of finished follow-ups to read,
     * which is fine, because a finished task was never the record. The activity
     * log is, and nothing about the task lifecycle touches it.
     */
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    const taskId = await seedRow(t, USER_A, 'tasks', {
      title: 'Follow up with Taylor',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-09-01',
      lead_id: leadId,
      follow_up_rule_managed: true,
    });

    for (const day of ['2026-09-01', '2026-09-08', '2026-09-15']) {
      await seedRow(t, USER_A, 'activity_events', {
        occurred_at: `${day}T12:00:00.000Z`,
        activity_type: 'follow_up_sent',
        title: 'Follow-up sent',
        lead_id: leadId,
      });
      // The one task moves on each time rather than a new one appearing.
      await t.db.query('update tasks set due_date = $1 where id = $2', [day, taskId]);
    }

    const tasks = await t.db.query<{ n: string }>(
      'select count(*)::text as n from tasks where lead_id = $1',
      [leadId],
    );
    const history = await t.db.query<{ n: string }>(
      'select count(*)::text as n from activity_events where lead_id = $1',
      [leadId],
    );
    expect(Number(tasks.rows[0].n)).toBe(1);
    expect(Number(history.rows[0].n)).toBe(3);
  });

  it('does not stop a lead having other kinds of open task', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    await seedRow(t, USER_A, 'tasks', {
      title: 'Follow up with Taylor',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-10-12',
      lead_id: leadId,
      follow_up_rule_managed: true,
    });
    await expect(
      seedRow(t, USER_A, 'tasks', {
        title: 'Chase the invoice',
        task_type: 'admin',
        status: 'open',
        due_date: '2026-10-12',
        lead_id: leadId,
      }),
    ).resolves.toBeTruthy();
  });

  it('does not stop two different leads each having one', async () => {
    const a = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    const b = await seedRow(t, USER_A, 'leads', { prospect_name: 'Ariel' });
    for (const leadId of [a, b]) {
      await expect(
        seedRow(t, USER_A, 'tasks', {
          title: 'Follow up',
          task_type: 'follow_up',
          status: 'open',
          due_date: '2026-10-12',
          lead_id: leadId,
          follow_up_rule_managed: true,
        }),
      ).resolves.toBeTruthy();
    }
  });

  it('does not stop open follow-ups that belong to no lead', async () => {
    for (const title of ['One', 'Two']) {
      await expect(
        seedRow(t, USER_A, 'tasks', {
          title,
          task_type: 'follow_up',
          status: 'open',
          due_date: '2026-10-12',
          follow_up_rule_managed: true,
        }),
      ).resolves.toBeTruthy();
    }
  });
});

/* ============================================== the new columns are owned === */

describe('the new columns keep the rules the rest of the schema has', () => {
  it('scopes every new lead column to the owner through row level security', async () => {
    await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Mine',
      external_source: MIRROR_SOURCE,
      external_key: 'mine',
      relationship: 'Prospect',
      follow_up_mode: 'hold',
      reported_last_touch_at: '2026-09-13',
    });

    const theirs = await t.asUser(USER_B, async () => {
      const result = await t.db.query('select external_key from leads');
      return result.rows;
    });
    expect(theirs).toEqual([]);
  });

  it('will not let follow_up_mode be anything the enum does not allow', async () => {
    await expect(
      seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor', follow_up_mode: 'maybe' }),
    ).rejects.toThrow(/invalid input value for enum|follow_up_mode/i);
  });

  it('defaults follow_up_mode to auto, so an existing lead keeps being chased', async () => {
    const id = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    const row = await t.db.query<{ follow_up_mode: string }>(
      'select follow_up_mode from leads where id = $1',
      [id],
    );
    expect(row.rows[0].follow_up_mode).toBe('auto');
  });

  it('gives sync_runs a details object that defaults to empty rather than null', async () => {
    await t.db.query(
      `insert into sync_runs (owner_id, provider, status, idempotency_key, completed_at)
       values ($1, 'google_sheets', 'succeeded', 'google_sheets:export:2026-10-05', now())`,
      [USER_A],
    );
    const row = await t.db.query<{ details: unknown }>(
      'select details from sync_runs where owner_id = $1',
      [USER_A],
    );
    expect(row.rows[0].details).toEqual({});
  });

  it('accepts google_sheets as a provider', async () => {
    await expect(
      t.db.query(
        `insert into integration_connections (owner_id, provider, status)
         values ($1, 'google_sheets', 'ready')`,
        [USER_A],
      ),
    ).resolves.toBeTruthy();
  });

  it('accepts conversation as an activity type', async () => {
    const leadId = await seedRow(t, USER_A, 'leads', { prospect_name: 'Taylor' });
    await expect(
      seedRow(t, USER_A, 'activity_events', {
        occurred_at: '2026-09-19T12:00:00.000Z',
        activity_type: 'conversation',
        title: 'Discovery conversation',
        lead_id: leadId,
      }),
    ).resolves.toBeTruthy();
  });
});

/* ======================================================= ambiguity is safe === */

describe('an ambiguous row writes nothing at all', () => {
  it('leaves both candidates untouched and creates nothing', async () => {
    // Two existing leads with the same email as a sheet row.
    const a = await seedRow(t, USER_A, 'leads', {
      prospect_name: 'Taylor',
      organization: 'Your Local Handyman',
      email: 'taylor@example.com',
    });
    const b = await seedRow(t, USER_A, 'leads', {
      prospect_name: 'T. Smith',
      organization: 'Handyman Services',
      email: 'taylor@example.com',
    });

    const before = await t.db.query('select * from leads where owner_id = $1 order by id', [
      USER_A,
    ]);

    const { plan, applied } = await reconcile(USER_A);

    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].label).toBe('taylor-handyman');
    expect(plan.ambiguous[0].candidateIds.sort()).toEqual([a, b].sort());

    // The other two sheet rows still import; only the ambiguous one is skipped.
    expect(applied.leadsCreated).toBe(2);
    expect(applied.leadsUpdated).toBe(0);
    // And both of Taylor's touches are left out, because they have nowhere safe to go.
    expect(applied.touchesCreated).toBe(0);

    const after = await t.db.query('select * from leads where owner_id = $1 and id in ($2, $3) order by id', [
      USER_A, a, b,
    ]);
    expect(after.rows).toEqual(
      before.rows.filter((r) => [a, b].includes((r as { id: string }).id)),
    );
  });
});
