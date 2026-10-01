# Database setup

## Migration order

Apply these in order. There is no 0002: it used to be the seed data, and it has moved
to `../supabase/seed.sql` because it cannot run on an empty project. The number is
left as a gap on purpose. Renumbering would make the files disagree with anything
already applied elsewhere, and a gap that is explained is safer than a rename that
is not.

| Order | File | What it does |
|---|---|---|
| 1 | `migrations/0001_init.sql` | Enums, the seven core tables, RLS policies, both views |
| 2 | `migrations/0003_activity_and_calendar.sql` | Activity log, calendar columns on tasks and activity, the deduplication indexes |
| 3 | `migrations/0004_security_hardening.sql` | `security_invoker` on both views, composite owner keys, the `owner_id` trigger |
| 4 | `migrations/0005_integrations.sql` | Connections, sync runs, daily GA4 and Search Console tables |
| 5 | `migrations/0006_analytics_schedule.sql` | pg_cron and pg_net, plus the helper the daily sync schedule calls. Creates no cron job. |

Migration 0006 starts nothing. It installs what a schedule needs and leaves the two
`cron.schedule` statements commented at the bottom of the file, to be run by hand once
the Edge Functions are deployed and tested. Applying it calls no Google property and
changes no behaviour.

It is also the one migration the PGlite test harness does not apply, because `pg_cron`
and `pg_net` are Supabase extensions that do not exist in plain Postgres. Everything
0006 contains is therefore unverified by the test suite and has to be checked against
the hosted project. That check has been done, and what it found is recorded under
"The hosted project, as it stands" below.

Requires **PostgreSQL 15 or newer**, for two reasons: `security_invoker` on views, and
`ON DELETE SET NULL (column)` naming which column to clear. Supabase is well past both.

## Fresh project, start to finish

```
1. Create the Supabase project.
2. Apply migrations 0001, 0003, 0004, 0005 in that order.
      Dashboard: SQL editor, paste each file, run.
      CLI:       supabase db push
3. Create a user.
      Either sign in through the app once with a magic link,
      or Authentication > Users > Add user in the dashboard.
4. OPTIONAL. Demonstration data only:
      sign in as that user, then run supabase/seed.sql in the SQL editor.
      A real project does not need this, and should probably skip it.
5. Point the app at the project:
      VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env
6. Sign in. The app shows a signed out screen until you do, and loads
   nothing before then.
```

**Step 3 cannot be skipped or reordered.** Every table hangs off `auth.users`, and
`owner_id` defaults to `auth.uid()`. With no user there is nobody to own a row.

## Why the seed is not a migration

It was one, and that was wrong. A migration runs against an empty database before
anybody has signed up. `supabase/seed.sql` inserts rows that need an owner, so in its
old position it would either fail outright or attach the records to whichever user
happened to exist first.

It now runs by hand, after a user exists, and only when demonstration data is wanted.
A test covers both halves of this: the seed applies cleanly when signed in, and
refuses with "No user found" on a project with no users.

## Testing

`src/test/pg/` runs every migration against a real PostgreSQL through PGlite, which
is Postgres compiled to WebAssembly rather than an emulation.

```
npm run test:db
```

It proves, by executing the SQL rather than reading it:

- The migrations apply from empty, in order.
- Deleting a parent clears only the nullable relationship column and leaves
  `owner_id` untouched.
- Cascade relationships still cascade.
- A row cannot point at another owner, on insert or on update.
- `owner_id` cannot be changed once a row exists.
- Each user sees only their own rows, including through both views.
- An anonymous visitor sees nothing and cannot read either view.
- Repeated daily imports upsert instead of duplicating.
- The seed works after the migrations and fails without a user.

### What it still does not prove

That the hosted Supabase project accepts these files through its own migration
runner, and that a real JWT populates `auth.uid()` as expected. The harness stubs the
`auth` schema, `auth.uid()` and the `anon` and `authenticated` roles, because
Postgres does not ship them. Everything under test is the project's own SQL running
unmodified, but the hosted project is still the final word.

## The hosted project, as it stands

Linked project ref: `megfxrktnmhzhnnnsnub`. The CLI reaches its database through the
Management API, so no database password is needed for `supabase db query --linked`,
`supabase migration list --linked` or `supabase migration repair`.

Migrations 0001 through 0005 were applied by hand through the SQL editor, so the
project had no migration history at all and the CLI reported every migration as
missing from the remote. 0006 was applied the same way, with
`supabase db query --linked -f supabase/migrations/0006_analytics_schedule.sql`.

The history has since been written with
`supabase migration repair --status applied 0001 0003 0004 0005 0006`, which inserts
bookkeeping rows and runs none of the SQL. `supabase migration list --linked` now
reports local and remote in step for all five. Row counts, table count and the cron
jobs were all re-checked afterwards and were unchanged, which is the evidence that the
repair touched bookkeeping only.

That repair was only run after confirming the hosted schema already matched the files,
object by object rather than by assuming it. Every enum and its values, every table,
view, function, policy, trigger, index and named constraint the five files create was
compared against the hosted catalogue, along with all 217 columns across the 12 tables.
Everything matched, no table had row level security off, and both views carried
`security_invoker`. Worth knowing if you repeat it: these files are CRLF, and a naive
comment-stripping regex ending in `$` silently fails on `
`, which produces
differences that are not real.

### Verified on the hosted project after 0006

- `pg_cron` installed, in `pg_catalog`, because its control file fixes that and the
  `with schema extensions` clause is quietly ignored rather than rejected. `pg_net`
  installed, in `extensions`, with its functions in `net`.
- `public.trigger_analytics_sync` exists, `security definer`, `search_path` pinned,
  owned by `postgres` rather than by a role the CLI creates and throws away. That
  ownership matters: the cron jobs run as `postgres`.
- Neither `anon` nor `authenticated` can execute it.
- Called by hand, it read Vault, posted through `pg_net` and came back with the
  function's own reply, which is the whole chain working.

### The schedule is now on

Both jobs were created from the statements at the bottom of 0006 and are active:

| Job | Schedule |
|---|---|
| `sitelaunch-sync-ga4-daily` | `0 8 * * *` |
| `sitelaunch-sync-search-console-daily` | `15 8 * * *` |

Both run as `postgres` in the `postgres` database. To check on them:

```
select jobname, schedule, active from cron.job where jobname like 'sitelaunch-%';
select * from cron.job_run_details order by start_time desc limit 10;
```

0006 itself still creates no job. The file is the instructions, not the switch.

### Proven against the real Google properties

A manual window of 2026-08-27 to 2026-09-29 was run three times against the live GA4
property and Search Console site.

- GA4 wrote 44 rows over 23 days. Search Console wrote 92 rows over 30 days.
- Search Console stops at 2026-09-28 rather than 09-29. That is `dataState: 'final'`
  doing its job: Google will not call the newest day settled, and the sync would
  rather show one day less than show a figure that moves later.
- Run twice more over the same window, the row counts did not budge and an md5 over
  the full contents of both tables was identical each time, while `synced_at`
  advanced. So the repeat really did write, and the upsert collapsed onto the same
  keys instead of duplicating. `sync_runs` stayed at two rows, one per provider,
  because the idempotency key updates the existing run in place.
- Both `integration_connections` rows read `connected` with no error, and the granted
  scopes are `analytics.readonly` and `webmasters.readonly`. The sync cannot write
  anything back to Google even if it tried.
## Deploying the sync functions

```
supabase functions deploy sync-ga4 sync-search-console --use-api
```

Both functions must be deployed with JWT verification off. That now comes from
`verify_jwt = false` in `config.toml` rather than from a `--no-verify-jwt` flag
somebody has to remember, which is the whole reason that file exists.

JWT verification being off is not a relaxation, it is a requirement. The scheduler presents
`x-sync-cron-secret` and no `Authorization` header at all, so platform JWT checking
would reject every scheduled run with a 401 before the function body ran. The
functions do their own authorisation in `resolveCaller`, which accepts either that
shared secret or a real user session and refuses everything else with one identical
401. Leaving platform verification on would break the schedule without making
anything safer.

`--use-api` bundles on Supabase's side, so Docker is not needed locally. It also
picks up the `server/integrations/` files the functions import from outside
`supabase/functions/`.

### Function secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by
the platform. These have to be set with `supabase secrets set`:

| Secret | What it is |
|---|---|
| `SYNC_CRON_SECRET` | Shared secret the scheduler presents. Must equal the `sync_cron_secret` Vault entry. |
| `SYNC_OWNER_ID` | The user id scheduled runs write rows for. Never read from a request. |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The service account JSON, whole. Stored base64 encoded. |
| `GA4_PROPERTY_ID` | GA4 property id. Not a secret, but it lives here with the rest. |
| `SEARCH_CONSOLE_SITE_URL` | The Search Console property, exactly as Google writes it. |

And these two in Vault, read by `trigger_analytics_sync` at call time:

```
select vault.create_secret('<value>', 'sync_functions_base_url', '<description>');
select vault.create_secret('<value>', 'sync_cron_secret', '<description>');
```

Set `SYNC_CRON_SECRET` and the `sync_cron_secret` Vault entry from the same value. If
they drift, every scheduled run becomes a 401 that looks like a broken sync. To check
they still agree without printing either one, compare `md5(decrypted_secret)` from
`vault.decrypted_secrets` against an md5 of the value you believe you set.

`parseServiceAccountKey` takes either raw JSON or base64 JSON, and base64 is the better
choice here: it is one line with no braces, quotes or newlines, so nothing mangles it on
the way through an env file. Set every secret from a file with
`supabase secrets set --env-file`, never as `NAME=value` on a command line, where it
would survive in shell history.
