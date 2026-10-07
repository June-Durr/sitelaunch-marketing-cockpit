# SiteLaunch Marketing Cockpit

Internal operating tool for SiteLaunch Studios. It connects content activity to website
traffic, inquiries, qualified leads, proposals and revenue, and answers one question:

> What did I publish, what business result followed, and what should I do next?

Product requirements, including the full recommendation rule table, are in [PRD.md](PRD.md).

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

It runs with no configuration. With no Supabase credentials present the app uses a
browser-local storage adapter, seeded with the verified starting records.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server on port 5173 |
| `npm run build` | Type-check, then produce `dist/` for Netlify |
| `npm run preview` | Serve the production build locally |
| `npm run test` | Vitest, engine rules, backup validation, screen render tests |
| `npm run screenshots` | Capture every screen at 1440x900 and 390x844, flagging overflow |
| `npm run test:backup-e2e` | Real-browser export, mutate, restore check (dev server must be running) |
| `npm run test:activity-e2e` | Real-browser check that finishing a task logs one activity and no more |
| `npm run test:db` | Runs every migration against a real Postgres and exercises the constraints |
| `npm run lint` | oxlint |
| `npm run typecheck` | `tsc -b --noEmit` |

## The program

The cockpit counts against a fixed program, not a rolling window.

| | |
|---|---|
| Starts | 27 August 2026, which is **Day 1** |
| Target | 25 November 2026, the review date |
| Length | 91 days, counting both ends |

19 September 2026 is Day 24.

Counting rules, all decided in one place in `src/config/program.ts`:

- **Program day is inclusive of the start.** The start date is Day 1, not Day 0.
- **Days remaining is exclusive of today.** The target date itself reads 0 remaining.
- **Phase boundaries are inclusive.** A date on a phase end date belongs to that phase.
- **Statistics include both the start and target dates.**

| Phase | Runs | For |
|---|---|---|
| 1 | 27 Aug to 26 Sep | Productize and Retain |
| 2 | 27 Sep to 26 Oct | Acquire and Measure |
| 3 | 27 Oct to 25 Nov | Prove and Systemize |

The dates are editable under Data and Import, and travel inside a backup. Phases stay
fixed against the agreed plan rather than being recalculated, so moving the start does
not silently shift them.

Why fixed rather than trailing: a rolling 90 day window moves every morning, so a figure
can improve or worsen with nothing having happened. A fixed program cannot do that.

## Tasks and activity are different things

| | Tasks | Activity |
|---|---|---|
| Answers | What do I intend to do | What actually happened |
| Can be wrong | Yes, plans change | No, it is a record |
| Created by | You | You, or finishing a task |
| Invented by the app | Never | Never |

Marking a task done also writes one activity record, linked back to the task. Doing it
again writes nothing at all: the pairing is deduplicated in code and by a partial unique
index in migration 0003. Skipping a task writes nothing, because skipping means it did
not happen.

One task is special. The follow-up the rule keeps for a lead **recurs**: finishing it
reopens it on the next date rather than leaving a finished task behind and starting
another, because "keep in touch with this person" has no end. There is at most one per
lead, enforced by a unique index in migration 0009, and the record of what was actually
done is the activity log, which that lifecycle never touches.

Nothing backfills activity from historical data. If nobody wrote it down at the time,
the honest answer is that we do not know.

## Local mode and Supabase mode

| | Local | Supabase |
|---|---|---|
| Triggered by | No credentials set | `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` |
| Data lives in | This browser only | Your Supabase project |
| Sign in | None | Email magic link |
| Backup and restore | Yes | Export only |

Local mode is the default and needs no account. In Supabase mode the app shows a signed
out screen and **never loads protected data first**. `AuthGate` does not render the data
layer at all until a session exists, so there is no request to cancel, because there is
no component alive to make one.

## The security boundary

The rule is short: anything the browser can read, a user can read. Anything named `VITE_`
is inlined into the JavaScript at build time.

| Lives in the browser | Lives server side only |
|---|---|
| Supabase URL | Supabase service role key |
| Supabase anon key | Every provider client secret |
| | Every access and refresh token |

The anon key is designed to be public and grants nothing on its own; row level security
decides what the signed in user sees. See `server/README.md`.

Database protections, in migration 0004:

- **Views run as the caller.** `security_invoker = true` on both views. Without it a view
  runs as its owner and bypasses row level security on the tables underneath, which would
  have let any authenticated user read every owner's rows through `cohort_stats`.
- **A row cannot point at another owner's row.** Every parent has a unique key on
  `(id, owner_id)` and every child references that composite key, so a cross-owner link
  fails a foreign key check inside the database whatever the app does.
- **`owner_id` cannot be changed** after a row exists.
- **Every composite `SET NULL` names the column it clears.** This is not cosmetic. A
  bare `ON DELETE SET NULL` clears every column in the foreign key, and `owner_id` is
  part of these keys and is `NOT NULL`, so deleting a parent failed outright. It also
  tried to change `owner_id`, which the trigger above forbids. Deleting an account was
  impossible until this was fixed, and no amount of reading the SQL revealed it. It
  took running the migrations against a real Postgres, which `npm run test:db` now
  does on every run.

## How integration data will flow

```
Provider API  ->  server function (holds the secrets)  ->  Supabase table
                                                              |
                                                       row level security
                                                              |
                                                          browser reads
```

The browser never talks to a provider. No Google or Meta adapter belongs in
`src/data/`. A sync runs server side, writes into Supabase, and the browser reads the
result through the same row level security as everything else.

API data goes into **daily** tables (`ga4_daily_traffic`, `search_console_daily`), one row
per day per dimension with a unique key an upsert targets. The existing
`traffic_snapshots` table keeps working unchanged for manual and CSV entry. The two models
coexist on purpose: ranges suit a person reading a report once, but they overlap, and
overlapping rows cannot be re-synced without double counting.

## The next sprint: connecting APIs

Recommended order, website numbers first because they are the ones tied to enquiries:

1. **GA4** daily traffic
2. **Google Search Console** daily queries
3. **Website enquiry ingestion** into Pipeline
4. **Google Calendar**, tasks out and events back
5. **Instagram and Facebook**
6. Other social platforms, only if they earn it

**AWS is not required.** Supabase plus its Edge Functions covers the database, auth, row
level security, secret storage and scheduled server side syncs for an internal tool of
this size. Adding AWS would mean another account, another deployment path and another
place for credentials to live, for no capability this app needs.

## Backup and restore

In browser-local mode the browser is the only copy of the data. **Data & Import ->
Backup and restore** exports every table plus app settings as JSON, stamped with a
schema version and an export timestamp.

Restoring is deliberately two-step. Choosing a file only reads and validates it; the
dataset is untouched until you press the confirm button, and the review panel first
shows a per-table before/after count and how many records will be lost.

A file is rejected outright, with nothing written, when it is not valid JSON, is not
a cockpit backup, was written by a newer schema, is missing a table, repeats an id
within a table, or carries a metric that is not a number or null. That last rule
matters most: a backup that had turned nulls into zeroes or strings would silently
corrupt every average, so it is refused rather than imported.

Dangling references (a content item pointing at an account not in the file) warn but
do not block, since the row still holds its own data.

## Connecting Supabase

Full instructions, including why the order matters, are in
[supabase/README.md](supabase/README.md). The short version:

```
1. Create the project.
2. Apply migrations 0001, 0003, 0004, 0005 in that order.
3. Create a user: sign in through the app once, or add one in the dashboard.
4. Optional, demonstration data only: signed in as that user, run supabase/seed.sql.
5. Copy .env.example to .env and fill in the two values below.
```

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

There is no 0002. It was the seed, and it moved to `supabase/seed.sql` because it
needs a user to exist and a migration runs before anybody has signed up. The number is
left as a documented gap rather than renumbered.

Requires PostgreSQL 15 or newer, for `security_invoker` views and for
`ON DELETE SET NULL (column)`. Supabase is well past both.

The adapter swaps underneath the app, no screen changes. Row level security scopes
every table to `auth.uid()`.

## Deploying

`netlify.toml` is configured (`npm run build` → `dist`, SPA redirect, `noindex` headers).
**Not deployed yet.**

---

## The rules this codebase enforces

These are not stylistic preferences. Each one, if broken, would make the tool quietly
mislead its only user.

1. **Unknown is never zero.** Metric fields are `null` by default, render as `,`, and are
   excluded from every average. A recorded `0` is a different value and stays visible as
   one. Enforced in `lib/metrics.ts`, `lib/format.ts`, and tested.
2. **Comparison happens within a cohort only**, same platform, same format, same
   measurement window. See `engine/cohorts.ts`.
3. **Externally amplified content is excluded from every baseline**, stays visible,
   and its exclusion is stated on screen.
4. **Nothing is claimed below 5 comparable items.** Below that the engine emits an
   explicit "not yet measurable" card instead of a conclusion.
5. **Views are never the optimisation target.** Rule ordering puts leads and qualified
   conversations first; high views with no downstream action is a flag, not a win.
6. **Account-wide totals are never attributed to a post.** A cross-post is two records,
   one per account, never merged.
7. **The screens talk like a person.** No em dashes anywhere, no analytics jargon, and
   every metric carries a plain explanation of what it is and why it matters, always
   visible rather than hidden behind a tooltip. A missing number reads "Not checked",
   never a dash and never a zero. `src/test/copy.test.ts` enforces this.
8. **Observed, calculated and recommended are visually distinct**, upright, italic grey,
   and bordered blocks respectively.

## Layout

```
src/
  auth/          Supabase session, the signed out screen, the gate
  components/    App shell, drawer, display primitives, the one chart
  config/        The program dates and all the day counting
  data/          Repository interface, local and Supabase adapters, seed, settings
  engine/        Cohort construction and the deterministic recommendation rules
  lib/           Dates, formatting, metric arithmetic, CSV, backup, activity, upsert
  screens/       One file per screen, plus their forms and panels
  styles/        The whole design system, one file
  types/         Domain and integration types mirroring the SQL schema
server/          Server side contracts. Never imported by src, never bundled.
  integrations/  Calendar and analytics sync contracts, no credentials
supabase/
  README.md                      Migration order and the fresh project sequence
  seed.sql                       Demonstration records. Run by hand, needs a user.
  migrations/
    0001_init.sql                Tables, enums, RLS, cohort view
    0003_activity_and_calendar.sql Activity log, calendar columns, dedup indexes
    0004_security_hardening.sql  security_invoker views, cross-owner protection
    0005_integrations.sql        Connections, sync runs, daily GA4 and Search Console
    0006_analytics_schedule.sql  pg_cron and pg_net, and the helper a schedule calls
    0007_lead_mirror.sql         Relationship follow-up columns and lead_follow_up_state
    0008_mirror_conflict_target.sql  Makes the activity key usable as an upsert target
    0009_follow_up_tasks.sql     The recurring follow-up task, and its reconciliation
```

## Not in this version

No Instagram, Facebook, LinkedIn or TikTok. No predictive modelling, no ML, no
LLM-generated recommendations, and no claim that the app is trained on anything.

GA4 and Search Console sync daily through a service account held server side, the
Google Sheet lead mirror is written from the database, and open follow-ups go out to a
dedicated Google Calendar. Nothing is read back from that calendar: an appointment is
not evidence that business contact happened, and classifying one as outreach would
invent history. Everything else still arrives by manual entry or CSV import.

The schema keeps `accounts.provider_account_id`, `content_items.external_id` and
`performance_snapshots.ingest_source` so an API sync can be added later without a
migration, and the repository interface makes an API-backed adapter additive.
