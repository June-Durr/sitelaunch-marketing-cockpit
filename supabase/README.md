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
the hosted project.

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
