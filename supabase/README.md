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
| 6 | `migrations/0007_lead_mirror.sql` | Relationship follow-up columns, the three uniqueness indexes, and `lead_follow_up_state(as_of)`. Creates no table. |
| 7 | `migrations/0008_mirror_conflict_target.sql` | Makes the activity external-key index usable as an `ON CONFLICT` target. Same rule, no predicate. |
| 8 | `migrations/0009_follow_up_tasks.sql` | The recurring follow-up task: a column saying the rule owns it, one per lead, and `reconcile_follow_up_tasks(dry_run)`. Creates no table. |
| 9 | `migrations/0010_calendar_oauth.sql` | The private Google Calendar token store: the one-use authorization states, the Vault pointer per owner, and the seven service-role-only functions that are the only way in. |

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
supabase functions deploy sync-ga4 sync-search-console sync-lead-mirror sync-calendar calendar-oauth calendar-oauth-callback --use-api
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
| `GOOGLE_SHEETS_SPREADSHEET_ID` | The lead mirror spreadsheet. Not a secret either, but it is configuration and belongs in one place rather than in a bundle nobody can rotate. |
| `GOOGLE_OAUTH_CLIENT_ID` | The Google OAuth client the calendar connection uses. Public by design, and still kept here: the browser never needs it, because the server builds the authorize url. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The other half of that client. With this and the redirect uri, somebody else could run the whole consent flow as SiteLaunch. |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must match an Authorized redirect URI on the Google client, exactly. |
| `COCKPIT_APP_URL` | Where the callback sends a browser afterwards. The only acceptable destination, so there is no open redirect. |

`GOOGLE_CALENDAR_ID` is gone. The calendar is no longer a dedicated one shared
with the service account; it is each person's own primary calendar, under their
own authorization. See **The follow-up calendar** below.

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

---

## The lead mirror

One spreadsheet, two tabs, and a relationship that goes one way after a single
import. `supabase/functions/sync-lead-mirror` does all three things it can do.

### What it needs

- `GOOGLE_SERVICE_ACCOUNT_KEY`, the same secret the analytics syncs already use.
  No second credential.
- `GOOGLE_SHEETS_SPREADSHEET_ID`, set with `supabase secrets set`. Deliberately not
  in `.env.local`: the browser has no business knowing which spreadsheet this is,
  and a `VITE_` variable is readable by anyone who opens developer tools.
- The spreadsheet shared with the service account's own address as an **Editor**.
  Read-only access is not enough, because the mirror is written. The address is
  the `client_email` in the key, and it is also what the Cockpit shows as the
  connection's display name.
- The Google Sheets API enabled on the project.

This is the one Google scope in the system that is not read-only
(`auth/spreadsheets`). The analytics syncs stay read-only and should remain so.

### Migration 0007

```
supabase db push
```

`0007_lead_mirror.sql` adds columns to `leads` and `activity_events`, three unique
indexes, a `follow_up_mode` enum, a `details` column on `sync_runs`, and the
`lead_follow_up_state(as_of)` function with a `lead_follow_up_today` view over it.
It creates no table and drops nothing.

Two notes on applying it:

- It extends two existing enums (`integration_provider` gains `google_sheets`,
  `activity_type` gains `conversation`). Postgres allows that inside a transaction
  as long as the new value is not *used* in the same transaction, and nothing in
  the file uses them, so it applies as one migration.
- The three unique indexes are partial. If the database already holds two leads
  with the same `external_key`, or two open follow-up tasks for one lead, the
  index creation fails and the migration refuses. That is the correct behaviour:
  the duplicate has to be resolved by a person, not by whichever row the index
  happened to see first.

### Migration 0008, and why it was needed

0007's activity index was partial, and a partial unique index cannot arbitrate an
upsert unless the statement restates its predicate. PostgREST's `onConflict` is a
list of column names with nowhere to put one, so the first live reconciliation
inserted all twenty-one leads and then failed on every touch with *there is no
unique or exclusion constraint matching the ON CONFLICT specification*.

0008 drops the predicate. The rule is unchanged, because nulls are distinct in a
unique index anyway, so a row with no external id was never constrained by the
predicate in the first place.

The lesson is in `src/test/pg/leadMirror.test.ts`: its applier used to spell the
conflict target with the predicate written out, which Postgres accepts and the
real client cannot send. It reproduced the intent and not the mechanism, so it
passed while production failed. It now sends the bare form.

### Running the reconciliation

Three calls, and the order matters. All of them take the signed-in user's token,
or the cron secret.

```
# 1. Look. Writes nothing, reports everything.
{"action":"reconcile","mode":"dry_run"}

# 2. Import, but only if the sheet is exactly what step 1 saw.
{"action":"reconcile","mode":"live","expect":{"leadRows":21,"touchRows":15}}

# 3. From then on, this is the only one that runs.
{"action":"export"}
```

The `expect` block is required for a live run and has no default. A gate with a
built-in answer stops meaning anything the moment the data moves on, so the caller
has to state what it believes and the server refuses if the sheet disagrees. It
also refuses if any row is ambiguous or unreadable. The Cockpit's
**Bring the sheet in** button fills `expect` from the dry run it just did, which is
why the button only appears after a clean check.

A live run is nondestructive by construction: there is no delete anywhere in the
path, and an update only ever writes a field the sheet actually had a value for, so
a blank cell cannot erase what is already there.

### The daily mirror sync

Not scheduled by any migration. Turn it on only after the on-demand
**Sync lead mirror now** button has worked at least once, the same rule as the
analytics jobs:

```
select cron.schedule(
  'sitelaunch-sync-lead-mirror-daily', '30 8 * * *',
  $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets
                  where name = 'sync_functions_base_url') || '/sync-lead-mirror',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-sync-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                               where name = 'sync_cron_secret')
      ),
      body    := jsonb_build_object('action', 'export'),
      timeout_milliseconds := 120000
    );
  $job$
);
```

08:30 UTC, fifteen minutes after Search Console, so the three jobs do not contend
for outbound connections. The body says `export` explicitly: a scheduled job must
never be able to trigger a reconciliation, and omitting the action would default to
export anyway, but saying it leaves nothing to a default.

To remove it:

```
select cron.unschedule('sitelaunch-sync-lead-mirror-daily');
```

### What the sync will not do

- It never writes rows 1 to 5 of either tab, so the title, the introductory note,
  the frozen header and any filter views survive because they are never addressed.
- It never writes a row id, an owner id, a connection id, a token or the service
  account address into the sheet. The Lead ID column carries a readable key.
- It never reads the sheet back as truth. A cell somebody edits in the data region
  is replaced by the next sync.
- It never touches lead or activity data when it fails. The worst case is a
  spreadsheet that is out of date, and the Cockpit carries on.

---

## The follow-up tasks

Migration 0009 turns each lead's calculated follow-up date into a real task, and
`reconcile_follow_up_tasks(dry_run)` is what keeps them in step.

```
-- Look. Writes nothing; dry_run is the default.
select action, count(*) from reconcile_follow_up_tasks(true) group by action;

-- Do it.
select action, count(*) from reconcile_follow_up_tasks(false) group by action;
```

Four outcomes, and a lead lands in exactly one: `create`, `update`, `unchanged`,
or `close`. Running it again over unchanged data reports nothing but `unchanged`
and writes nothing, which is what makes it safe to schedule.

It is `security invoker`, so row level security decides which leads and tasks a
caller can see and change. Run through `supabase db query --linked` it executes as
an admin role, which bypasses RLS: fine on a single-owner project, and worth
knowing before this becomes multi-tenant.

### What it will not touch

- Any task that is not a follow-up belonging to a lead. Measurement checks,
  publishing, marketing actions and admin tasks are somebody else's plan.
- A follow-up task somebody made by hand for a lead the rule has stopped
  chasing. Only tasks carrying `follow_up_rule_managed` are ever closed.
- Anything, by deleting it. A lead that stops being followed up has its task
  marked `skipped`, which is reversible and keeps the history.

The rule is implemented twice, in `src/config/followUpTasks.ts` for the browser
and in SQL for the server, and `src/test/pg/followUpTasks.test.ts` runs both over
the same fixtures and fails if they disagree about a single lead.

---

## The follow-up calendar

`supabase/functions/sync-calendar` writes every open follow-up task onto the
connected person's **own primary Google Calendar**, as an all day entry. One
direction only.

### Why not the service account

Because a calendar is not SiteLaunch's property. Using the service account for it
would mean one of two things: asking every customer to create a calendar and
share it with a robot they have never heard of, or domain-wide delegation, which
hands one credential the right to read every calendar in an organisation. The
first is setup work with nothing to show for it, the second is a credential
nobody consented to. So the calendar uses the customer's own authorization, and
the service account stays limited to GA4, Search Console and the Sheet mirror.

### What somebody has to do

Press **Connect Google Calendar** once, sign in to Google, and approve one
permission. That is all. They are never asked to create a calendar, copy an id,
share anything, or supply a key.

### What the deployment has to have

- An OAuth client of type **Web application** in Google Cloud, with the callback
  as an Authorized redirect URI.
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `GOOGLE_OAUTH_REDIRECT_URI` and `COCKPIT_APP_URL` as Edge Function secrets.
  Without the first three the functions answer `not_configured` and write
  nothing.
- The Google Calendar API enabled on the project.
- Migration `0010` applied.

No service account key is involved in this path at all.

### The one scope

`auth/calendar.events.owned`. It permits creating and changing events on
calendars the person owns, and nothing else: it cannot list their calendars,
cannot read anybody else's, and cannot touch sharing or calendar settings. The
full `auth/calendar` scope is deliberately not requested, and neither is
`auth/calendar.events`, which extends to calendars somebody merely has write
access to.

### Where the token lives

In Supabase Vault, pointed at by one row per owner in `calendar_oauth_tokens`.
Both of 0010's tables have row level security on and **no policy at all**, which
denies every read and write to `anon` and `authenticated`; privileges are revoked
besides. The only way in or out is seven `security definer` functions granted to
`service_role` alone, which is held by the Edge Functions and by nothing a browser
can be. `integration_connections`, which the browser does read, has no token
column by design.

### How an authorization is proved genuine

A 32-byte random state, stored only as its SHA-256, consumed by one conditional
`UPDATE` that also checks it is unused and unexpired. That statement is the
authentication: Postgres serialises two callbacks arriving together, the first
matches and the second matches nothing. A signature could prove we issued a value
but never that it had not already been spent, which is the attack that matters.

Forged, replayed, expired and never issued all answer identically, because they
are all "no" and telling them apart would describe the table to whoever is
probing it.

### Why the callback has no platform JWT check

Google redirects a browser to it, carrying a code and a state and no Supabase
session, so `verify_jwt = true` would reject every real callback before the body
ran. It does its own check first instead: the state is consumed before any
database write and before the code is exchanged.

### Several owners, independently

The scheduled run walks every owner who holds a token, which is the token table
and not a configured id. `SYNC_OWNER_ID` is deliberately not used here: a fixed
owner would mean the nightly run wrote one person's follow-ups and silently
ignored everybody else's, while every screen still said it succeeded. One owner's
expired authorization is recorded against their own connection row and does not
stop the next owner's sync.

An on-demand sync covers the signed in person and nobody else. The owner comes
from the verified session, never from the request body.

### The source field, and why there is not one

The first real sync failed 19 times out of 19: `HTTP 400`, reason `invalid`,
message `Invalid source url: .`. The body carried
`source: { title: 'SiteLaunch Marketing Cockpit' }` and no `url`.

The reference page lists `source.url` as optional, which is why reading the docs
did not catch it. The API treats it as required the moment `source` is present
at all. The object is now not sent. It is not given a url instead, because the
only url available would be the Cockpit's own address, which `buildFollowUpEvent`
does not have and which is a localhost address at the moment. The attribution it
carried is in the event description, where somebody reading the event sees it.

Two things changed alongside the fix, both because of how hard that was to
diagnose from `INVALID` alone:

- A failure now records Google's `message`, `reason`, `domain` and `location`,
  sanitized, instead of one normalised reason word.
- A run gives up after three consecutive failures with the same reason, and says
  so in `details.stoppedEarly`. Nineteen identical 400s tell nobody anything the
  first one did not, and they are nineteen chances to be rate limited for it.

A caller may also pass `{"action":"export","limit":1}` to push a single task,
which is how a canary is run before trusting a change against all of them.

### Why a retry cannot double-book

The event id is derived from the task id: the uuid's hex digits with the hyphens
removed, prefixed `slc`, which is already inside the base32hex alphabet Google
requires. Creating an event is not atomic from this side, so Google can store it
and the response can still be lost. A random id would mean the retry created a
second entry in somebody's week and nothing would notice. With this one the retry
asks for the same id, Google answers 409, and the sync patches instead.

### What it will never do

- Delete an event. Not when a task is finished, not when a lead is archived, not
  as a tidy-up. The calendar may be shared, and removing something from somebody
  else's week is not this app's decision.
- Write to `primary` under the service account. That pairing is refused outright
  by `isWritableCalendarId`, which takes the credential's mode as a required
  argument. `primary` is acceptable only when the credential is the person's own.
- List, search, or read a calendar. Every request addresses one event id computed
  from one Cockpit task id, so an unrelated personal event is not something this
  can see, let alone change.
- Clear a task's stored event id when a write fails. The ids stay, so the next
  successful run updates the event it was always meant to.
- Read events back in as activity. An appointment is not evidence that business
  contact happened, and classifying one as outreach would invent history.

### The daily job

Not scheduled by any migration, and deliberately not scheduled until three
things are true: somebody has connected through the real button, one real
follow-up has appeared on their primary calendar, and two repeated syncs have
shown the same number of events rather than twice as many. When they are:

```
select cron.schedule(
  'sitelaunch-sync-calendar-daily', '40 8 * * *',
  $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets
                  where name = 'sync_functions_base_url') || '/sync-calendar',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-sync-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                               where name = 'sync_cron_secret')
      ),
      body    := jsonb_build_object('action', 'export'),
      timeout_milliseconds := 120000
    );
  $job$
);
```

08:40 UTC, ten minutes after the lead mirror. The order matters as much as the
spacing: the mirror settles the follow-up state, and the calendar reads it.
