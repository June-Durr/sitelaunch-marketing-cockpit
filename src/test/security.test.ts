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
 * The migrations other than the OAuth token store.
 *
 * 0010 is the one place in the schema that is allowed to name a refresh token at
 * all, because it is the private store that holds one. It gets its own, stricter
 * tests below rather than an exemption: a blanket text search over it would
 * either pass by accident or force the store to be written dishonestly.
 */
const sqlWithoutTokenStore = readdirSync(dir)
  .filter((f) => f.endsWith('.sql') && !f.startsWith('0010_'))
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

/**
 * Everything under server/, which must never be reachable from the browser.
 *
 * Read here so the tests below can assert what is in it as well as what is not in
 * src. The lead mirror is the first integration that asks Google for a write
 * scope, so the boundary matters more than it did.
 */
const serverSource = readdirSync('server', { recursive: true, encoding: 'utf8' })
  .filter((f) => typeof f === 'string' && /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
  .map((f) => readFileSync(`server/${f}`, 'utf8'))
  .join('\n');

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

  it('stores no tokens anywhere in the browser readable schema', () => {
    // A token column would be readable by the browser through RLS, which defeats
    // the entire point of syncing server side. 0010 is excluded and tested
    // harder, because it is the private store that genuinely holds one.
    for (const forbidden of [
      'access_token', 'refresh_token', 'client_secret', 'api_key',
      'service_role', 'password',
    ]) {
      expect(sqlWithoutTokenStore.toLowerCase(), `schema mentions ${forbidden}`)
        .not.toContain(forbidden);
    }
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The calendar token store, which is the only part of the schema that holds a
 * secret at all.
 *
 * The rule everywhere else is "no token columns". Here the rule has to be
 * different, because a scheduled calendar sync genuinely needs a refresh token
 * weeks after somebody pressed a button. So the token lives in Vault, the tables
 * that reference it are reachable by no browser role at all, and the only way in
 * or out is through functions the service role alone may execute. These are
 * asserted separately, because any one of them failing on its own would be
 * enough to expose a token.
 */
describe('the calendar token store is reachable by nothing a browser can be', () => {
  const sql = sqlFor('0010_calendar_oauth.sql');
  const tables = ['calendar_oauth_states', 'calendar_oauth_tokens'];

  it('keeps no token column on either table', () => {
    for (const table of tables) {
      const at = sql.indexOf(`create table ${table} (`);
      expect(at, `${table} is not created`).toBeGreaterThan(-1);
      const definition = sql.slice(at, sql.indexOf(');', at));
      for (const forbidden of ['refresh_token', 'access_token', 'token text']) {
        expect(definition.toLowerCase(), `${table} has a ${forbidden} column`)
          .not.toContain(forbidden);
      }
    }
    // What is stored instead: a hash of the state, and a pointer into Vault.
    expect(sql).toContain('state_hash');
    expect(sql).toContain('vault_secret_id');
  });

  it('turns row level security on and then grants no policy at all', () => {
    for (const table of tables) {
      expect(sql).toContain(`alter table ${table} enable row level security`);
      expect(sql).toContain(`revoke all on ${table} from anon, authenticated`);
      // RLS on with no policy denies every row to anon and authenticated. A
      // policy on either of these would be a mistake, so its absence is
      // asserted rather than assumed.
      expect(sql, `${table} has a policy`).not.toContain(`on ${table} for select`);
      expect(sql, `${table} has a policy`).not.toContain(`on ${table} for all`);
    }
  });

  it('names a refresh token only inside the functions, never in the tables', () => {
    /**
     * Where the word appears matters more than how often.
     *
     * Everything before the first function is table and index DDL, which is what
     * PostgREST exposes and what a leaked anon key would be pointed at. A single
     * mention of a token up there would mean a column, so the assertion is about
     * position rather than about a count.
     */
    const ddl = sql.slice(0, sql.indexOf('create or replace function')).toLowerCase();
    expect(ddl).not.toContain('refresh_token');
    expect(ddl).not.toContain('access_token');

    // Inside the functions it is a parameter and a Vault secret name, and both
    // of those are the point of the migration.
    const bodies = sql.slice(sql.indexOf('create or replace function')).toLowerCase();
    expect(bodies).toContain('p_refresh_token');
    expect(bodies).toContain('vault.create_secret');
  });

  it('lets only the service role execute the token functions', () => {
    /**
     * The privileges themselves are proved against real Postgres in the pg
     * schema test, which is the stronger check. This one guards the thing a text
     * search can guard: that every function is security definer and appears in
     * the list the grant loop walks, so a fifth function added later without
     * being added to that list shows up here rather than silently ending up
     * executable by anyone.
     */
    const signatures = [
      'calendar_oauth_store_token(uuid, text)',
      'calendar_oauth_read_token(uuid)',
      'calendar_oauth_forget_token(uuid)',
      'calendar_oauth_owners()',
      'calendar_oauth_issue_state(uuid, text, integer)',
      'calendar_oauth_consume_state(text)',
      'calendar_oauth_prune_states(integer)',
    ];
    const created = [...sql.matchAll(/create or replace function (calendar_oauth_\w+)/g)]
      .map((m) => m[1]);
    expect(created.length).toBe(signatures.length);

    for (const name of created) {
      const at = sql.indexOf(`create or replace function ${name}`);
      expect(sql.slice(at, at + 2500), `${name} is not security definer`)
        .toContain('security definer');
      expect(signatures.some((sig) => sig.startsWith(`${name}(`)), `${name} is not granted`)
        .toBe(true);
    }

    for (const sig of signatures) expect(sql).toContain(`'${sig}'`);
    expect(sql).toContain("revoke all on function %s from public");
    expect(sql).toContain("revoke all on function %s from anon, authenticated");
    expect(sql).toContain("grant execute on function %s to service_role");
  });

  it('is never reached from the browser bundle', () => {
    for (const name of [
      'calendar_oauth_store_token', 'calendar_oauth_read_token',
      'calendar_oauth_forget_token', 'calendar_oauth_states', 'calendar_oauth_tokens',
    ]) {
      expect(shippedSource, `src names ${name}`).not.toContain(name);
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

/* ------------------------------------------------------------------------ */

describe('the Google Sheet mirror keeps every credential server side', () => {
  const shippedFiles = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter(
    (f) => typeof f === 'string' && /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
  ) as string[];

  it('never names the spreadsheet id variable anywhere in src', () => {
    // It is an Edge Function secret. The browser does not know which spreadsheet
    // it is, which is why the panel shows the sheet's title read back from the
    // connection row rather than its id.
    expect(shippedSource).not.toContain('GOOGLE_SHEETS_SPREADSHEET_ID');
    expect(shippedSource).not.toContain('VITE_GOOGLE_SHEETS');
    expect(shippedSource).not.toContain('GOOGLE_SERVICE_ACCOUNT_KEY');
  });

  it('never names the real spreadsheet id in src either', () => {
    // Not a secret in the sense a key is, but it is configuration and it belongs
    // in one place. A literal in the bundle is a literal nobody can rotate.
    expect(shippedSource).not.toContain('1umabdzkbi2VI5w0');
  });

  it('calls no Google API from the browser', () => {
    for (const host of [
      'sheets.googleapis.com', 'googleapis.com', 'oauth2.googleapis.com',
      'www.googleapis.com/auth/spreadsheets',
    ]) {
      expect(shippedSource, `src reaches ${host}`).not.toContain(host);
    }
  });

  it('keeps the Sheets scope and the Sheets client on the server', () => {
    // Where they are supposed to be, asserted positively, so a later refactor
    // that moved them into src would fail here rather than silently succeed.
    expect(serverSource).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(serverSource).toContain('sheets.googleapis.com');
  });

  it('never imports the Sheets client or the mirror logic into src', () => {
    for (const file of shippedFiles) {
      const text = readFileSync(`src/${file}`, 'utf8');
      for (const forbidden of [
        'integrations/sheets', 'leadMirrorShared', 'leadMirrorExport',
        'integrations/leadMirror', 'googleAuth',
      ]) {
        expect(text, `src/${file} imports ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('asks the server to do the work rather than doing it', () => {
    const repo = readFileSync('src/data/supabaseRepository.ts', 'utf8');
    // The only thing the browser sends is its own session, to one function name.
    expect(repo).toContain('sync-lead-mirror');
    expect(repo).toContain('authorization');
    expect(repo).not.toContain('private_key');
  });
});

describe('the Google Sheet mirror schema stores nothing secret', () => {
  const sql = sqlFor('0007_lead_mirror.sql');

  /**
   * The same SQL with its prose removed.
   *
   * The migration explains at length that it holds no credential and no
   * spreadsheet id, so searching the whole file for those words finds the
   * explanation rather than a column. What matters is the executable part.
   */
  const statements = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*/g, ' ')
    .toLowerCase();

  it('adds no column that could hold a credential or a spreadsheet id', () => {
    for (const forbidden of [
      'token', 'secret', 'private_key', 'credential', 'spreadsheet_id',
      'service_account', 'password', 'api_key',
    ]) {
      expect(statements, `0007 declares something called ${forbidden}`)
        .not.toContain(forbidden);
    }
  });

  it('really did strip only the prose, and still has the schema in it', () => {
    // So the assertion above cannot pass by having removed everything.
    expect(statements).toContain('create unique index leads_unique_external_key');
    expect(statements).toContain('alter table leads');
    expect(statements).toContain('follow_up_mode');
  });

  it('runs the follow-up derivation as the caller, not as its definer', () => {
    // A security definer function here would hand every caller every owner's
    // pipeline, because the sync tables are written with the service role.
    const at = sql.indexOf('create or replace function lead_follow_up_state');
    expect(at).toBeGreaterThan(-1);
    const body = sql.slice(at, sql.indexOf('$$;', at));
    expect(body).not.toContain('security definer');
    expect(sql).toContain('revoke all on function lead_follow_up_state(date) from anon');
    expect(sql).toContain('grant execute on function lead_follow_up_state(date) to authenticated');
  });

  it('runs the convenience view as the caller too', () => {
    expect(sql).toContain('alter view lead_follow_up_today set (security_invoker = true)');
    expect(sql).toContain('revoke all on lead_follow_up_today from anon');
    expect(sql).toContain('grant select on lead_follow_up_today to authenticated');
  });

  it('makes a duplicate impossible rather than merely unlikely', () => {
    for (const [index, columns] of [
      ['leads_unique_external_key', '(owner_id, external_source, external_key)'],
      ['tasks_one_open_follow_up_per_lead', '(owner_id, lead_id)'],
    ] as [string, string][]) {
      const at = sql.indexOf(`create unique index ${index}`);
      expect(at, `${index} is missing`).toBeGreaterThan(-1);
      const block = sql.slice(at, at + 400);
      expect(block, index).toContain(columns);
      // Partial, so the index covers only the rows it is meant to. Neither of
      // these is ever an ON CONFLICT target, so a predicate costs them nothing.
      expect(block, index).toContain('where');
    }
  });

  it('keeps the activity external key usable as an upsert target', () => {
    /**
     * Migration 0008 replaced 0007's partial version of this index.
     *
     * Postgres will not use a partial unique index to arbitrate an upsert unless
     * the statement restates the predicate, and PostgREST cannot. Nulls are
     * distinct in a unique index anyway, so dropping the predicate kept the rule
     * and made the upsert work. If it ever goes back, the touch import breaks
     * again, so this pins it.
     */
    const later = sqlFor('0008_mirror_conflict_target.sql');
    // 0008 quotes 0007's old definition in its own explanation, so the executable
    // part has to be looked at on its own.
    const executable = later
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--.*/g, ' ')
      .toLowerCase();

    expect(executable).toContain('drop index if exists activity_events_unique_external_key');

    const at = executable.indexOf('create unique index activity_events_unique_external_key');
    expect(at, 'the index is not recreated').toBeGreaterThan(-1);
    const statement = executable.slice(at, executable.indexOf(';', at));

    expect(statement).toContain('(owner_id, external_source, external_id)');
    expect(statement, 'a predicate makes it unusable for ON CONFLICT')
      .not.toContain('where');
  });

  it('keeps the one-open-follow-up index to open follow-ups', () => {
    const at = sql.indexOf('create unique index tasks_one_open_follow_up_per_lead');
    const block = sql.slice(at, at + 400);
    expect(block).toContain("task_type = 'follow_up'");
    expect(block).toContain("status = 'open'");
    expect(block).toContain('lead_id is not null');
  });
});

describe('the two copies of the follow-up rule say the same thing', () => {
  /**
   * The rule is implemented twice on purpose: in src/config/followUp.ts for the
   * screens, and in SQL for the Sheet export and anything server side. These
   * check the labels and the configuration match. src/test/pg/followUp.test.ts
   * checks the behaviour matches, case by case, against a real Postgres.
   */
  const sql = sqlFor('0007_lead_mirror.sql');
  const config = readFileSync('src/config/followUp.ts', 'utf8');
  const exporter = readFileSync('server/integrations/leadMirrorExport.ts', 'utf8');

  it('uses the same due-soon threshold in the SQL as in the module', () => {
    const match = /export const DUE_SOON_DAYS = (\d+);/.exec(config);
    expect(match, 'DUE_SOON_DAYS is not declared as a literal').toBeTruthy();
    const days = match?.[1] as string;
    expect(sql).toContain(`l.next_action_date <= as_of + ${days}`);
  });

  it('excludes the same activity types from a touch in both places', () => {
    const match = /NON_TOUCH_ACTIVITY: ActivityType\[\] = \[([\s\S]*?)\];/.exec(config);
    expect(match, 'NON_TOUCH_ACTIVITY is not a literal list').toBeTruthy();
    const types = [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(0);

    for (const type of types) {
      expect(sql, `the SQL does not exclude ${type}`).toContain(`'${type}'`);
      expect(exporter, `the exporter does not exclude ${type}`).toContain(`'${type}'`);
    }
  });

  it('spells every status the same way in the sheet, both sides', () => {
    const forConfig = /FOLLOW_UP_STATUS_SHEET_LABELS: Record<FollowUpStatus, string> = \{([\s\S]*?)\};/.exec(config);
    const forServer = /FOLLOW_UP_STATUS_SHEET_LABELS: Record<string, string> = \{([\s\S]*?)\};/.exec(exporter);
    expect(forConfig, 'config labels').toBeTruthy();
    expect(forServer, 'server labels').toBeTruthy();

    const pairs = (text: string) =>
      Object.fromEntries(
        [...text.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]),
      );
    const fromConfig = pairs(forConfig?.[1] ?? '');
    // Not empty, so the comparison cannot pass by both sides finding nothing.
    expect(Object.keys(fromConfig)).toHaveLength(8);
    expect(pairs(forServer?.[1] ?? '')).toEqual(fromConfig);
  });

  it('spells every stage the same way in the sheet as on screen', () => {
    const domain = readFileSync('src/types/domain.ts', 'utf8');
    const forDomain = /STAGE_LABELS: Record<LeadStage, string> = \{([\s\S]*?)\};/.exec(domain);
    const forServer = /STAGE_SHEET_LABELS: Record<LeadStage, string> = \{([\s\S]*?)\};/.exec(exporter);
    expect(forDomain, 'domain labels').toBeTruthy();
    expect(forServer, 'server labels').toBeTruthy();

    const pairs = (text: string) =>
      Object.fromEntries(
        [...text.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]),
      );
    const fromDomain = pairs(forDomain?.[1] ?? '');
    expect(Object.keys(fromDomain)).toHaveLength(8);
    expect(pairs(forServer?.[1] ?? '')).toEqual(fromDomain);
  });

  it('lists the same pipeline stages on both sides of the boundary', () => {
    // server/integrations/types.ts repeats LeadStage rather than importing it,
    // because the boundary only holds if it holds in both directions.
    const domain = readFileSync('src/types/domain.ts', 'utf8');
    const server = readFileSync('server/integrations/types.ts', 'utf8');

    const stages = (text: string) => {
      const match = /export type LeadStage =([\s\S]*?);/.exec(text);
      return [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    };
    expect(stages(server)).toEqual(stages(domain));
    expect(stages(server).length).toBe(8);
  });

  it('lists the same integration providers on both sides', () => {
    const browser = readFileSync('src/types/integrations.ts', 'utf8');
    const server = readFileSync('server/integrations/types.ts', 'utf8');

    const providers = (text: string) => {
      const match = /export type IntegrationProvider =([\s\S]*?);/.exec(text);
      return [...(match?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
    };
    expect(providers(server)).toEqual(providers(browser));
    expect(providers(server)).toContain('google_sheets');
  });
});

/* ------------------------------------------------------------------------ */

describe('the built bundle carries no Google credential', () => {
  /**
   * The real check, against the real output.
   *
   * Everything above reads source. This reads dist/, which is what actually ships
   * to a browser, because a secret can reach a bundle through a dependency or a
   * define, not only through an import somebody wrote. npm run build has to have
   * run; the test says so plainly rather than passing quietly when it has not.
   */
  const builtFiles = existsSync('dist')
    ? (readdirSync('dist', { recursive: true, encoding: 'utf8' }) as string[])
        .filter((f) => typeof f === 'string' && /\.(js|css|html|map)$/.test(f))
    : [];

  it('has a build to look at', () => {
    expect(
      builtFiles.length,
      'dist/ has no built assets. Run npm run build before this suite so the bundle check means something.',
    ).toBeGreaterThan(0);
  });

  it('contains no private key, in any of its usual spellings', () => {
    const forbidden = [
      '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----',
      'BEGIN PRIVATE KEY',
      'private_key',
      'private_key_id',
      'gserviceaccount.com',
      'client_email',
      'GOOGLE_SERVICE_ACCOUNT_KEY',
    ];

    for (const file of builtFiles) {
      const text = readFileSync(`dist/${file}`, 'utf8');
      for (const needle of forbidden) {
        expect(text.includes(needle), `dist/${file} contains "${needle}"`).toBe(false);
      }
    }
  });

  it('contains no service role key, cron secret or spreadsheet id', () => {
    const forbidden = [
      'SUPABASE_SERVICE_ROLE_KEY',
      'service_role',
      'SYNC_CRON_SECRET',
      'x-sync-cron-secret',
      'GOOGLE_SHEETS_SPREADSHEET_ID',
      '1umabdzkbi2VI5w0',
      'GA4_PROPERTY_ID',
    ];

    for (const file of builtFiles) {
      const text = readFileSync(`dist/${file}`, 'utf8');
      for (const needle of forbidden) {
        expect(text.includes(needle), `dist/${file} contains "${needle}"`).toBe(false);
      }
    }
  });

  it('calls no Google endpoint from the bundle', () => {
    for (const file of builtFiles) {
      const text = readFileSync(`dist/${file}`, 'utf8');
      expect(
        text.includes('sheets.googleapis.com'),
        `dist/${file} calls the Sheets API`,
      ).toBe(false);
      expect(
        text.includes('oauth2.googleapis.com'),
        `dist/${file} mints Google tokens`,
      ).toBe(false);
    }
  });

  /**
   * 13. No OAuth credential reaches what ships.
   *
   * The client secret is the one that would matter most: with it and a redirect
   * uri, somebody else can run the whole consent flow as SiteLaunch. The client
   * id is public by design and still absent, because the browser has no use for
   * it: the server builds the authorize url, since it has to record the state
   * first anyway.
   */
  it('contains no OAuth client, token or Vault reference', () => {
    /**
     * Google's OAuth, specifically.
     *
     * 'refresh_token' and 'grant_type' are deliberately not on this list:
     * supabase-js manages the signed in person's own Supabase session with a
     * refresh token, so those strings are in the bundle legitimately and
     * forbidding them would make this test fail for the wrong reason. What must
     * not be there is anything that could act as SiteLaunch against Google.
     */
    const forbidden = [
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_OAUTH_REDIRECT_URI',
      'apps.googleusercontent.com',
      'client_secret',
      'calendar_oauth_store_token',
      'calendar_oauth_read_token',
      'calendar_oauth_tokens',
      'vault.decrypted_secrets',
      'accounts.google.com/o/oauth2',
      'googleapis.com/auth/calendar',
    ];

    for (const file of builtFiles) {
      const text = readFileSync(`dist/${file}`, 'utf8');
      for (const needle of forbidden) {
        expect(text.includes(needle), `dist/${file} contains "${needle}"`).toBe(false);
      }
    }
  });

  it('does carry the two public Supabase values, which are meant to be there', () => {
    // The counterpart to every assertion above: this proves the search is
    // actually looking at the shipped JavaScript and would find a string in it.
    const js = builtFiles.filter((f) => f.endsWith('.js'));
    expect(js.length).toBeGreaterThan(0);
    const all = js.map((f) => readFileSync(`dist/${f}`, 'utf8')).join('\n');
    expect(all).toContain('supabase');
  });
});

/* ------------------------------------------------------------------------ */

describe('the follow-up calendar keeps every credential server side', () => {
  const shippedFiles = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter(
    (f) => typeof f === 'string' && /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
  ) as string[];

  it('never names the calendar id or the key variable anywhere in src', () => {
    // Both are Edge Function secrets. The browser learns which calendar is being
    // written to from the connection row the server wrote, not from a build.
    expect(shippedSource).not.toContain('GOOGLE_CALENDAR_ID');
    expect(shippedSource).not.toContain('VITE_GOOGLE_CALENDAR');
  });

  it('calls no Google Calendar endpoint from the browser', () => {
    for (const host of [
      'www.googleapis.com/calendar', 'googleapis.com/calendar/v3',
      'https://www.googleapis.com/auth/calendar',
    ]) {
      expect(shippedSource, `src reaches ${host}`).not.toContain(host);
    }
  });

  it('keeps the calendar scope and the client on the server', () => {
    expect(serverSource).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(serverSource).toContain('googleapis.com/calendar/v3/calendars');
  });

  it('asks for the narrowest scope that can write an event', () => {
    const provider = readFileSync('server/integrations/googleCalendar.ts', 'utf8');
    const match = /CALENDAR_SCOPE = '([^']+)'/.exec(provider);
    expect(match?.[1]).toBe('https://www.googleapis.com/auth/calendar.events');
    // The wider scope also grants creating, sharing and deleting whole calendars.
    expect(provider).not.toContain("'https://www.googleapis.com/auth/calendar'");
  });

  it('never imports the calendar client into src', () => {
    for (const file of shippedFiles) {
      const text = readFileSync(`src/${file}`, 'utf8');
      expect(text, `src/${file} imports the calendar client`)
        .not.toContain('googleCalendar');
    }
  });

  it('asks the server to do the work rather than doing it', () => {
    const repo = readFileSync('src/data/supabaseRepository.ts', 'utf8');
    expect(repo).toContain('sync-calendar');
    expect(repo).toContain('authorization');
  });
});

/**
 * 4. A token has no path to a browser, and no path to a log.
 *
 * Three separate claims, because any one of them failing on its own would be
 * enough: the browser never receives one, the browser never asks for one, and a
 * failure never prints one. The database half of this is in the pg tests, which
 * prove it against real Postgres rather than against a text search.
 */
describe('the calendar authorization never reaches a browser', () => {
  const start = readFileSync('supabase/functions/calendar-oauth/index.ts', 'utf8');
  const callback = readFileSync('supabase/functions/calendar-oauth-callback/index.ts', 'utf8');
  const store = readFileSync('supabase/functions/_shared/calendarOAuthStore.ts', 'utf8');
  const repo = readFileSync('src/data/supabaseRepository.ts', 'utf8');

  it('never names a token or a client secret anywhere in src', () => {
    for (const forbidden of [
      'refresh_token', 'refreshToken', 'client_secret', 'clientSecret',
      'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_ID',
    ]) {
      expect(shippedSource, `src names ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never stores anything about the connection in browser storage', () => {
    // A token in localStorage survives the tab, the session and the sign out.
    const panel = readFileSync('src/screens/CalendarPanel.tsx', 'utf8');
    for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie']) {
      expect(panel, `the panel uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('builds the authorize url on the server, so the browser needs no client id', () => {
    expect(start).toContain('buildAuthorizeUrl');
    expect(repo).not.toContain('buildAuthorizeUrl');
    expect(repo).not.toContain('accounts.google.com/o/oauth2');
    // The browser asks for a url and checks where it points. It does not assemble
    // one, because the state in it has to have been recorded first.
    expect(repo).toContain('calendar-oauth');
    expect(repo).toContain("hostname === 'accounts.google.com'");
  });

  it('returns a status and a url from the start call, and nothing else', () => {
    const returned = start.slice(start.indexOf("status: 'ready'"), start.indexOf("status: 'ready'") + 200);
    expect(returned).toContain('authorizeUrl');
    expect(returned).not.toContain('token');
  });

  it('exchanges the code server side, in the callback and nowhere else', () => {
    expect(callback).toContain('exchangeAuthorizationCode');
    expect(shippedSource).not.toContain('exchangeAuthorizationCode');
  });

  it('hands the token straight to the store without returning or logging it', () => {
    // The only thing done with the exchanged token is storing it.
    expect(callback).toContain('storeRefreshToken(client, ownerId, tokens.refreshToken)');
    /**
     * And nothing is ever interpolated into a log here.
     *
     * The test looks for the template placeholder rather than for the word, so a
     * fixed message that happens to say "code" passes and a message that splices
     * the code in does not.
     */
    for (const call of callback.match(/safeLog\([^;]*\)/g) ?? []) {
      expect(call, call).not.toContain('tokens.');
      expect(call, call).not.toContain('${code');
      expect(call, call).not.toContain('${state');
      expect(call, call).not.toContain('${refresh');
      expect(call, call).not.toContain('oauth.client');
    }
  });

  it('reads a token only through the private Vault helpers', () => {
    expect(store).toContain('calendar_oauth_read_token');
    // Never a direct select against a table, which PostgREST would expose.
    expect(store).not.toContain("from('calendar_oauth_tokens')");
    expect(store).not.toContain('vault.');
  });

  it('hands the token back on disconnect only so Google can be told', () => {
    const fn = readFileSync('supabase/functions/calendar-oauth/index.ts', 'utf8');
    const block = fn.slice(fn.indexOf('const token = await forgetRefreshToken'));
    expect(block.slice(0, 200)).toContain('revokeRefreshToken(token)');
    // And the response says whether Google was told, not what it was told.
    expect(fn).toContain('revokedAtGoogle: revoked');
    expect(fn).not.toContain('token: token');
  });
});

/**
 * 1. Consent needs a session, and 12. disconnecting deletes no event.
 */
describe('connecting and disconnecting are acts of one signed in person', () => {
  const fn = readFileSync('supabase/functions/calendar-oauth/index.ts', 'utf8');
  const callback = readFileSync('supabase/functions/calendar-oauth-callback/index.ts', 'utf8');

  it('guards the start and disconnect with requireUser, not resolveCaller', () => {
    expect(fn).toContain('requireUser(request.headers, verifyJwt)');
    // resolveCaller accepts the scheduler's shared secret, which cannot consent
    // on anybody's behalf.
    expect(fn).not.toContain('resolveCaller');
    expect(fn).not.toContain('SYNC_OWNER_ID');
  });

  it('takes the owner from the verified session and never from the body', () => {
    const body = fn.slice(fn.indexOf('let body'), fn.indexOf('let body') + 400);
    expect(body).toContain('action');
    expect(body).not.toContain('owner');
    expect(fn).not.toContain('body.ownerId');
    expect(fn).not.toContain('body.owner_id');
  });

  it('validates the state before any write and before the code exchange', () => {
    const consumeAt = callback.indexOf('consumeOAuthState');
    const exchangeAt = callback.indexOf('exchangeAuthorizationCode(oauth');
    const writeAt = callback.indexOf("from('integration_connections')");
    expect(consumeAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeLessThan(exchangeAt);
    expect(consumeAt).toBeLessThan(writeAt);
  });

  it('redirects only through the configured app, never through a parameter', () => {
    expect(callback).toContain('safeReturnUrl');
    expect(callback).toContain("env('COCKPIT_APP_URL')");
    // The destination is a literal path plus one word from a fixed set. Nothing
    // from the request chooses where a browser goes.
    expect(callback).toContain("const RETURN_PATH = '/data'");
    expect(callback).not.toContain("searchParams.get('redirect");
    expect(callback).not.toContain("searchParams.get('return");
    expect(callback).not.toContain("searchParams.get('next");
  });

  it('does not echo Google error text back into the address bar', () => {
    // It arrived in a query string that anybody can write.
    const refusal = callback.slice(callback.indexOf('if (googleError)'), callback.indexOf('if (googleError)') + 250);
    expect(refusal).toContain("finish('refused')");
    expect(refusal).not.toContain('googleError}');
  });

  it('removes no calendar event when somebody disconnects', () => {
    const block = fn.slice(fn.indexOf("if (action === 'disconnect')"));
    expect(block).not.toContain('DELETE');
    expect(block).not.toContain('calendar/v3');
    expect(block).not.toContain('external_event_id');
    // And it says so in the response rather than letting the screen imply it.
    expect(block).toContain('eventsRemoved: false');
  });

  it('keeps the service account out of the calendar path entirely', () => {
    const sync = readFileSync('supabase/functions/sync-calendar/index.ts', 'utf8');
    for (const text of [fn, callback, sync]) {
      expect(text).not.toContain('GOOGLE_SERVICE_ACCOUNT_KEY');
      expect(text).not.toContain('ServiceAccountTokenSource');
    }
  });
});

describe('the calendar sync will not write where it was not told to', () => {
  const provider = readFileSync('server/integrations/googleCalendar.ts', 'utf8');
  const fn = readFileSync('supabase/functions/sync-calendar/index.ts', 'utf8');

  it('refuses the primary calendar in code, not only in a comment', () => {
    expect(provider).toContain('FORBIDDEN_CALENDAR_IDS');
    expect(provider).toContain('PRIMARY_CALENDAR_ID');
    expect(provider).toContain('isWritableCalendarId');
    /**
     * The check is inside pushFollowUpEvent, which is the only thing that writes.
     *
     * It used to be in the Edge Function as well. Putting it one layer down is
     * stronger, not weaker: a future caller cannot reach Google without passing
     * through the guard, whereas a duplicated check in a handler is one somebody
     * can forget to copy into the next handler.
     */
    const guard = provider.slice(provider.indexOf('export async function pushFollowUpEvent'));
    expect(guard.slice(0, 400)).toContain('isWritableCalendarId(deps.calendarId, deps.mode)');
  });

  /**
   * Primary is allowed for exactly one kind of credential, and the sync says
   * which kind it is holding.
   *
   * The whole safety of writing to 'primary' rests on the mode being honest. A
   * sync that wrote primary while claiming to be the service account would be
   * putting events in a robot's diary at best and somebody's unconsented diary
   * at worst, so the pairing is asserted rather than trusted.
   */
  it('reaches the primary calendar only under a person own authorization', () => {
    const sync = readFileSync('server/integrations/calendarSync.ts', 'utf8');
    expect(sync).toContain("mode: 'user_oauth'");
    expect(sync).not.toContain("mode: 'service_account'");
    expect(sync).toContain('PRIMARY_CALENDAR_ID');
    // There is no configured calendar id in this path at all, so there is
    // nothing to fall back from.
    expect(sync).not.toContain('GOOGLE_CALENDAR_ID');
    // And neither the module nor the function holds a service account key.
    for (const text of [sync, fn]) {
      expect(text).not.toContain('GOOGLE_SERVICE_ACCOUNT_KEY');
      expect(text).not.toContain('ServiceAccountTokenSource');
    }
  });

  /**
   * The service account is still refused the primary calendar.
   *
   * Sprint B's rule has not been relaxed, it has been made conditional on
   * something real. If this ever passes for 'service_account', a credential
   * nobody consented to has been pointed at a diary.
   */
  it('still refuses primary to the service account', () => {
    const at = provider.indexOf('export function isWritableCalendarId');
    const body = provider.slice(at, provider.indexOf('/** What to show', at));
    expect(body).toContain("mode === 'user_oauth'");
  });

  it('never deletes an event', () => {
    // Not a comment: there is no request with that method anywhere in the path.
    for (const [name, text] of [
      ['the provider', provider],
      ['the function', fn],
    ] as [string, string][]) {
      expect(text, `${name} issues a DELETE`).not.toMatch(/method:\s*'DELETE'/);
      expect(text, `${name} issues a delete`).not.toMatch(/method:\s*"DELETE"/);
    }
  });

  it('pushes only open follow-up tasks', () => {
    const store = readFileSync('supabase/functions/_shared/calendarStore.ts', 'utf8');
    expect(store).toContain("eq('task_type', 'follow_up')");
    expect(store).toContain("eq('status', 'open')");
    // And always narrowed to one owner, because the service role bypasses RLS.
    expect(store).toContain("eq('owner_id', ownerId)");
  });

  it('keeps the stored event id when a write fails', () => {
    const store = readFileSync('supabase/functions/_shared/calendarStore.ts', 'utf8');
    const at = store.indexOf('export async function markTaskSyncFailed');
    expect(at).toBeGreaterThan(-1);
    const body = store.slice(at, store.indexOf('\n}', at));

    expect(body).toContain("calendar_sync_status: 'error'");
    // Clearing these would make the next successful run create a second event.
    expect(body).not.toContain('external_event_id');
    expect(body).not.toContain('external_calendar_id');
  });
});

describe('the recurring follow-up task is identified by a column, not by prose', () => {
  const sql = sqlFor('0009_follow_up_tasks.sql');
  const statements = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*/g, ' ')
    .toLowerCase();

  it('adds the column rather than matching on a title or a note', () => {
    expect(statements).toContain('add column follow_up_rule_managed boolean not null default false');
    // Nothing in the reconciliation reads the words on a task to decide what it owns.
    expect(statements).not.toContain("title like");
    expect(statements).not.toContain("notes like");
  });

  it('allows one rule-managed follow-up per lead, whatever state it is in', () => {
    const at = statements.indexOf('create unique index tasks_one_managed_follow_up_per_lead');
    expect(at, 'the index is missing').toBeGreaterThan(-1);
    const block = statements.slice(at, statements.indexOf(';', at));

    expect(block).toContain('(owner_id, lead_id)');
    expect(block).toContain('follow_up_rule_managed');
    // Status-independent on purpose: the task recurs, so scoping to open tasks
    // would let a second one appear the moment the first was marked done.
    expect(block).not.toContain('status');
  });

  it('runs the reconciliation as the caller, so row level security applies', () => {
    expect(statements).toContain('security invoker');
    expect(sql).toContain('revoke all on function reconcile_follow_up_tasks(boolean) from anon');
    expect(sql).toContain(
      'grant execute on function reconcile_follow_up_tasks(boolean) to authenticated',
    );
    expect(statements).not.toContain('security definer');
  });

  it('deletes nothing', () => {
    expect(statements).not.toContain('delete from tasks');
    expect(statements).not.toContain('drop table');
  });

  it('defaults to a dry run, so writing has to be asked for', () => {
    expect(statements).toContain('dry_run boolean default true');
  });
});
