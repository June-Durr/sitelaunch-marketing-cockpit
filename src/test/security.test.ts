/**
 * Database security, asserted against the migration files.
 *
 * These migrations cannot be executed here, so the tests read the SQL and check
 * the protections are present and correctly shaped. That is weaker than running
 * them against Postgres, and it is stated plainly in the report rather than
 * dressed up. What it does catch is the protection being deleted or weakened by a
 * later edit, which is the realistic failure.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = 'supabase/migrations';
const sqlFor = (file: string) => readFileSync(`${dir}/${file}`, 'utf8');
const allSql = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => sqlFor(f))
  .join('\n');

/**
 * Every source file that actually ships, which is everything under src except the
 * tests. The tests are excluded because they name the forbidden strings in order
 * to assert they are absent, and would otherwise trip their own check.
 */
const shippedSource = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter(
    (f) => typeof f === 'string' && /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
  )
  .map((f) => readFileSync(`src/${f}`, 'utf8'))
  .join('\n');

const OWNED_TABLES = [
  'accounts', 'content_items', 'performance_snapshots', 'traffic_snapshots',
  'leads', 'tasks', 'recommendations', 'activity_events',
  'integration_connections', 'sync_runs', 'ga4_daily_traffic', 'search_console_daily',
];

describe('every owned table has row level security on', () => {
  for (const table of OWNED_TABLES) {
    it(`${table} enables RLS`, () => {
      const enabledDirectly = allSql.includes(`alter table ${table} enable row level security`);
      // Some are enabled inside a loop over an array of table names.
      const enabledInLoop =
        allSql.includes("execute format('alter table %I enable row level security'") &&
        allSql.includes(`'${table}'`);
      expect(enabledDirectly || enabledInLoop, `${table} has no RLS`).toBe(true);
    });
  }

  it('gives every owned table an owner_id', () => {
    for (const table of OWNED_TABLES) {
      const definition = allSql.slice(allSql.indexOf(`create table ${table} (`));
      expect(definition.slice(0, 1200), table).toContain('owner_id');
    }
  });
});

describe('views do not leak across owners', () => {
  const sql = sqlFor('0004_security_hardening.sql');

  it('runs both views as the caller rather than the view owner', () => {
    // Without this a view bypasses RLS on the tables it reads, because it runs as
    // whoever owns the view.
    expect(sql).toContain('alter view content_latest_snapshot set (security_invoker = true)');
    expect(sql).toContain('alter view cohort_stats            set (security_invoker = true)');
  });

  it('takes the views away from anonymous visitors', () => {
    expect(sql).toContain('revoke all on content_latest_snapshot from anon');
    expect(sql).toContain('revoke all on cohort_stats            from anon');
  });

  it('grants them only to signed in users', () => {
    expect(sql).toContain('grant select on content_latest_snapshot to authenticated');
    expect(sql).toContain('grant select on cohort_stats            to authenticated');
  });
});

describe('a row cannot point at another owner', () => {
  const sql = sqlFor('0004_security_hardening.sql');

  it('gives every parent a unique key on id and owner together', () => {
    for (const table of ['accounts', 'content_items', 'leads', 'tasks']) {
      expect(sql, table).toContain(`unique (id, owner_id)`);
      expect(sql).toContain(`${table}_id_owner_key`);
    }
  });

  const composites: [string, string][] = [
    ['content_items_account_same_owner', 'accounts (id, owner_id)'],
    ['performance_snapshots_content_same_owner', 'content_items (id, owner_id)'],
    ['traffic_snapshots_content_same_owner', 'content_items (id, owner_id)'],
    ['leads_content_same_owner', 'content_items (id, owner_id)'],
    ['tasks_content_same_owner', 'content_items (id, owner_id)'],
    ['tasks_lead_same_owner', 'leads (id, owner_id)'],
    ['activity_events_content_same_owner', 'content_items (id, owner_id)'],
    ['activity_events_lead_same_owner', 'leads (id, owner_id)'],
    ['activity_events_task_same_owner', 'tasks (id, owner_id)'],
  ];

  for (const [constraint, target] of composites) {
    it(`${constraint} references ${target}`, () => {
      expect(sql).toContain(constraint);
      const at = sql.indexOf(constraint);
      expect(sql.slice(at, at + 260)).toContain(target);
    });
  }

  it('replaces the single column foreign keys rather than adding alongside them', () => {
    // A leftover single column key would still permit the cross-owner link.
    for (const dropped of [
      'content_items drop constraint content_items_account_id_fkey',
      'performance_snapshots drop constraint performance_snapshots_content_item_id_fkey',
      'tasks drop constraint tasks_lead_id_fkey',
      'activity_events drop constraint activity_events_task_id_fkey',
    ]) {
      expect(sql).toContain(dropped);
    }
  });

  it('refuses to let owner_id be changed after the fact', () => {
    expect(sql).toContain('refuse_owner_change');
    expect(sql).toContain('owner_id cannot be changed once a row exists');
    for (const table of OWNED_TABLES.slice(0, 8)) {
      expect(sql, table).toContain(`'${table}'`);
    }
  });
});

describe('integration tables keep the same owner rule', () => {
  const sql = sqlFor('0005_integrations.sql');

  it('ties every synced row to the connection owner', () => {
    for (const constraint of [
      'sync_runs_connection_same_owner',
      'ga4_daily_traffic_connection_same_owner',
      'search_console_daily_connection_same_owner',
    ]) {
      expect(sql).toContain(constraint);
      expect(sql.slice(sql.indexOf(constraint), sql.indexOf(constraint) + 260))
        .toContain('integration_connections (id, owner_id)');
    }
  });

  it('gives the browser read access only, since writes come from the server', () => {
    for (const policy of [
      'integration_connections_owner_read',
      'sync_runs_owner_read',
      'ga4_daily_traffic_owner_read',
      'search_console_daily_owner_read',
    ]) {
      expect(sql).toContain(policy);
      expect(sql.slice(sql.indexOf(policy), sql.indexOf(policy) + 140)).toContain('for select');
    }
  });

  it('stores no tokens anywhere in the schema', () => {
    // A token column would be readable by the browser through RLS, which defeats
    // the entire point of syncing server side.
    for (const forbidden of [
      'access_token', 'refresh_token', 'client_secret', 'api_key',
      'service_role', 'password',
    ]) {
      expect(allSql.toLowerCase(), `schema mentions ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('activity cannot be duplicated by finishing a task twice', () => {
  const sql = sqlFor('0003_activity_and_calendar.sql');

  it('enforces one automatic record per task in the database', () => {
    expect(sql).toContain('activity_one_per_completed_task');
    const at = sql.indexOf('create unique index activity_one_per_completed_task');
    expect(at).toBeGreaterThan(-1);
    const block = sql.slice(at, at + 300);
    expect(block).toContain('unique');
    expect(block).toContain('(owner_id, task_id)');
    expect(block).toContain("source = 'task_completion'");
  });
});

describe('a synced calendar event cannot land twice', () => {
  const sql = sqlFor('0003_activity_and_calendar.sql');

  for (const index of ['activity_unique_external_event', 'tasks_unique_external_event']) {
    it(`${index} is unique on the external ids`, () => {
      expect(sql).toContain(index);
      const at = sql.indexOf(`create unique index ${index}`);
      expect(at).toBeGreaterThan(-1);
      const block = sql.slice(at, at + 260);
      expect(block).toContain('(owner_id, external_calendar_id, external_event_id)');
      expect(block).toContain('where external_event_id is not null');
    });
  }
});

describe('the browser bundle carries no secrets', () => {
  it('reads only the two public Supabase values', () => {
    const client = readFileSync('src/data/supabaseClient.ts', 'utf8');
    expect(client).toContain('VITE_SUPABASE_URL');
    expect(client).toContain('VITE_SUPABASE_ANON_KEY');
    expect(client).not.toContain('SERVICE_ROLE');
  });

  it('never references a service role or provider secret under a VITE_ name', () => {
    // Anything named VITE_ is inlined into the bundle and readable by anyone.
    for (const forbidden of [
      'VITE_SUPABASE_SERVICE', 'VITE_GOOGLE_OAUTH_CLIENT_SECRET',
      'VITE_META_APP_SECRET', 'SERVICE_ROLE_KEY',
    ]) {
      expect(shippedSource, `src references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('keeps the server integration contracts out of src entirely', () => {
    // If the browser ever imported these, Vite would bundle them and the boundary
    // would exist only in the comments.
    expect(shippedSource).not.toContain("from '../../server");
    expect(shippedSource).not.toContain('server/integrations');
  });
});

/* ------------------------------------------------------------------------ */

describe('every composite SET NULL names only the nullable column', () => {
  /**
   * A bare ON DELETE SET NULL clears every column in the foreign key. owner_id is
   * part of these keys and is NOT NULL, so a bare action made parent deletion
   * impossible. src/test/pg/schema.test.ts proves the behaviour against a real
   * Postgres; this catches the SQL regressing back to the bare form.
   */
  const COMPOSITE_SET_NULL: [string, string, string][] = [
    ['0004_security_hardening.sql', 'content_items_account_same_owner', 'account_id'],
    ['0004_security_hardening.sql', 'traffic_snapshots_content_same_owner', 'content_item_id'],
    ['0004_security_hardening.sql', 'leads_content_same_owner', 'content_item_id'],
    ['0004_security_hardening.sql', 'activity_events_content_same_owner', 'content_item_id'],
    ['0004_security_hardening.sql', 'activity_events_lead_same_owner', 'lead_id'],
    ['0004_security_hardening.sql', 'activity_events_task_same_owner', 'task_id'],
    ['0005_integrations.sql', 'sync_runs_connection_same_owner', 'connection_id'],
    ['0005_integrations.sql', 'ga4_daily_traffic_connection_same_owner', 'connection_id'],
    ['0005_integrations.sql', 'search_console_daily_connection_same_owner', 'connection_id'],
  ];

  for (const [file, constraint, column] of COMPOSITE_SET_NULL) {
    it(`${constraint} clears only ${column}`, () => {
      const sql = sqlFor(file);
      const at = sql.indexOf(constraint);
      expect(at, `${constraint} is missing`).toBeGreaterThan(-1);
      const statement = sql.slice(at, sql.indexOf(';', at));

      expect(statement).toContain(`on delete set null (${column})`);
      expect(statement, 'owner_id must never be in a SET NULL list').not.toMatch(
        /set null \([^)]*owner_id/,
      );
    });
  }

  it('leaves no composite foreign key using a bare SET NULL', () => {
    for (const file of ['0004_security_hardening.sql', '0005_integrations.sql']) {
      const sql = sqlFor(file);
      // Split on statements so a bare action cannot hide next to a fixed one.
      for (const statement of sql.split(';')) {
        if (!statement.includes('foreign key (')) continue;
        if (!statement.includes('on delete set null')) continue;
        expect(
          statement,
          `${file} has a composite SET NULL with no column list`,
        ).toMatch(/on delete set null \(\w+\)/);
      }
    }
  });

  it('keeps cascade relationships as cascade, not converted by mistake', () => {
    const sql = sqlFor('0004_security_hardening.sql');
    for (const constraint of [
      'performance_snapshots_content_same_owner',
      'tasks_content_same_owner',
      'tasks_lead_same_owner',
    ]) {
      const at = sql.indexOf(constraint);
      const statement = sql.slice(at, sql.indexOf(';', at));
      expect(statement, constraint).toContain('on delete cascade');
      expect(statement, constraint).not.toContain('set null');
    }
  });
});

describe('seed data is not a migration', () => {
  it('lives at supabase/seed.sql, outside the migrations directory', () => {
    expect(existsSync('supabase/seed.sql')).toBe(true);
    expect(existsSync('supabase/migrations/0002_seed.sql')).toBe(false);
  });

  it('no migration depends on a user already existing', () => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = sqlFor(file);
      expect(sql, `${file} reads auth.users, so it cannot run on an empty project`)
        .not.toContain('from auth.users');
    }
  });

  it('the seed explains that it needs a user and runs by hand', () => {
    const seed = readFileSync('supabase/seed.sql', 'utf8');
    expect(seed).toContain('THIS IS NOT A MIGRATION');
    expect(seed).toMatch(/auth\.users/);
  });
});
