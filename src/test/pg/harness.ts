/**
 * A real Postgres to run the migrations against.
 *
 * PGlite is PostgreSQL itself compiled to WebAssembly, not an emulation, so
 * foreign key actions, triggers, row level security and views behave as they will
 * on Supabase. That matters here: the defect these tests exist to catch is one
 * that string matching on the SQL cannot see.
 *
 * WHAT IS STUBBED, AND WHY IT IS HONEST
 *
 * Supabase supplies an `auth` schema, an `auth.uid()` function reading the JWT,
 * and the `anon` and `authenticated` roles. None of that ships with Postgres, so
 * the harness creates equivalents. The stub is deliberately thin: `auth.uid()`
 * reads a setting the test controls, exactly as the real one reads a claim. Every
 * behaviour under test (foreign keys, triggers, RLS policies, view rights) is
 * plain Postgres running the project's own SQL unmodified.
 *
 * Supabase Vault is stubbed the same way, for the same reason: it is a Supabase
 * extension and does not ship with Postgres. The stub stores the secret in a
 * table rather than encrypting it, which is exactly the part that is NOT under
 * test here. What is under test is the behaviour built on top of it: that a
 * reconnection without a new token keeps the old one, that forgetting really
 * removes the secret, and that nobody but the service role can call any of it.
 *
 * WHAT THIS STILL DOES NOT PROVE
 *
 * That the hosted Supabase project accepts these files through its own migration
 * runner, that its real JWT path populates auth.uid() as expected, or that Vault
 * encrypts what it says it encrypts. Those need the hosted project.
 */

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

export const MIGRATION_DIR = 'supabase/migrations';

/** The migrations a fresh database needs, in order. Seed data is not one of them. */
export const MIGRATION_FILES = [
  '0001_init.sql',
  '0003_activity_and_calendar.sql',
  '0004_security_hardening.sql',
  '0005_integrations.sql',
  '0007_lead_mirror.sql',
  '0008_mirror_conflict_target.sql',
  '0009_follow_up_tasks.sql',
  '0010_calendar_oauth.sql',
];

export const USER_A = '11111111-1111-1111-1111-111111111111';
export const USER_B = '22222222-2222-2222-2222-222222222222';

/**
 * Stands in for what Supabase provides before any project migration runs.
 * Kept separate from the project's own SQL so the two never blur together.
 */
const SUPABASE_PRELUDE = `
  create schema if not exists auth;

  create table auth.users (
    id         uuid primary key,
    email      text unique,
    created_at timestamptz not null default now()
  );

  -- Supabase reads the subject claim out of the request JWT. The test controls
  -- the same value through a setting, which is what lets us act as either user.
  create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create role anon nologin;
  create role authenticated nologin;
  -- Supabase's own third role. The Edge Functions hold it, it bypasses row level
  -- security, and migration 0010 grants the token functions to it alone.
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated;

  -- Supabase Vault, as much of it as the project's own SQL actually uses. The
  -- real one encrypts; this one does not, which is why nothing here claims to
  -- test encryption.
  create schema if not exists vault;

  create table vault.secrets (
    id          uuid primary key default gen_random_uuid(),
    name        text,
    description text,
    secret      text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
  );

  create view vault.decrypted_secrets as
    select id, name, description, secret as decrypted_secret, created_at, updated_at
    from vault.secrets;

  create or replace function vault.create_secret(
    new_secret text, new_name text default null, new_description text default null
  ) returns uuid
  language plpgsql
  as $vault$
  declare created uuid;
  begin
    insert into vault.secrets (name, description, secret)
    values (new_name, new_description, new_secret)
    returning id into created;
    return created;
  end;
  $vault$;

  create or replace function vault.update_secret(
    secret_id uuid, new_secret text default null,
    new_name text default null, new_description text default null
  ) returns void
  language plpgsql
  as $vault$
  begin
    update vault.secrets
       set secret      = coalesce(new_secret, secret),
           name        = coalesce(new_name, name),
           description = coalesce(new_description, description),
           updated_at  = now()
     where id = secret_id;
  end;
  $vault$;
`;

/**
 * Grants match Supabase, which hands table privileges to both roles and leans on
 * row level security to decide what is actually visible.
 *
 * These run BEFORE the migrations, as default privileges, which is the order
 * Supabase uses: a project is set up with these defaults, and project migrations
 * run afterwards. Ordering is not a detail here. Granting after the migrations
 * would silently undo the REVOKE in 0004, and the suite would report the views as
 * locked down while anonymous visitors could still read them.
 *
 * service_role is in the list for the same reason the other two are: Supabase
 * grants it table privileges by default. Leaving it out would make the token
 * store look locked down here while being open on the real project, which is the
 * wrong way round for a test to be wrong. What stops it being a hole is that
 * nothing a browser can hold is ever the service role.
 */
const DEFAULT_PRIVILEGES = `
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
`;

export interface TestDatabase {
  db: PGlite;
  /** Run as a given signed in user, with row level security applying. */
  asUser<T>(userId: string, work: () => Promise<T>): Promise<T>;
  /** Run as an anonymous visitor. */
  asAnon<T>(work: () => Promise<T>): Promise<T>;
  /** Run as the role the Edge Functions hold, which bypasses row level security. */
  asServiceRole<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A brand new database with every migration applied, in order. */
export async function freshDatabase(
  files: string[] = MIGRATION_FILES,
): Promise<TestDatabase> {
  // pgcrypto because 0001 asks for it. Everything else is stock Postgres.
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_PRELUDE);
  await db.exec(DEFAULT_PRIVILEGES);

  await db.exec(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'a@sitelaunchstudios.com'),
      ('${USER_B}', 'b@example.com');
  `);

  for (const file of files) {
    const sql = readFileSync(`${MIGRATION_DIR}/${file}`, 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(
        `${file} failed to apply: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Session level rather than transaction local, so a test can run several
  // statements as one user without wrapping each in its own transaction.
  async function withRole<T>(role: string, userId: string | null, work: () => Promise<T>) {
    await db.query('select set_config($1, $2, false)', [
      'request.jwt.claim.sub',
      userId ?? '',
    ]);
    await db.exec(`set role ${role};`);
    try {
      return await work();
    } finally {
      await db.exec('reset role;');
      await db.query('select set_config($1, $2, false)', ['request.jwt.claim.sub', '']);
    }
  }

  return {
    db,
    asUser: (userId, work) => withRole('authenticated', userId, work),
    asAnon: (work) => withRole('anon', null, work),
    /** Run as the role the Edge Functions hold. Bypasses row level security. */
    asServiceRole: (work) => withRole('service_role', null, work),
    async close() {
      await db.close();
    },
  };
}

/** Insert a row owned by the given user, returning its id. Runs as the owner. */
export async function seedRow(
  t: TestDatabase,
  userId: string,
  table: string,
  columns: Record<string, unknown>,
): Promise<string> {
  const keys = Object.keys(columns);
  const placeholders = keys.map((_, i) => `$${i + 2}`);
  const sql = `insert into ${table} (owner_id${keys.length ? ', ' + keys.join(', ') : ''})
               values ($1${placeholders.length ? ', ' + placeholders.join(', ') : ''})
               returning id`;
  const result = await t.db.query<{ id: string }>(sql, [userId, ...Object.values(columns)]);
  return result.rows[0].id;
}
