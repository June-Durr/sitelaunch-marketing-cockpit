# SiteLaunch Marketing Cockpit: Product Requirements (v1)

**Status:** MVP, internal only
**Owner:** SiteLaunch Studios
**Last updated:** 2026-09-19

---

## 1. Purpose

An internal operating tool that connects content activity to business outcomes.

The application exists to answer one question, every working day:

> **What did I publish, what business result followed, and what should I do next?**

It is not an analytics dashboard. Analytics describe the past. This tool is built to drive
the next action, and to be honest about how little is currently known.

---

## 2. Operating principles

These constrain every feature decision in v1.

1. **Observed vs. derived is always visible.** Numbers a human recorded from a platform are
   rendered differently from numbers the app calculated. Recommendations are a third,
   clearly labelled category.
2. **Unknown is not zero.** A metric that was not recorded stays `null` and renders as the
   words "Not checked". It is excluded from averages, never counted as 0.
3. **No account-wide totals on a post.** Profile-level numbers (account reach, follower
   counts) are never attributed to an individual content item.
4. **Views are never the optimisation target.** Ranking and recommendation logic weights
   leads and qualified conversations far above reach.
5. **Externally amplified content is quarantined.** Anything boosted by a third party is
   flagged and excluded from comparison baselines by default.
6. **Evidence or silence.** No recommendation appears without the sample size, the
   comparison set, and the numbers that produced it.
7. **No predictive AI, no training claims.** v1 recommendations are deterministic rules the
   user can read in the UI.

---

## 2b. The program, fixed rather than rolling

Decided 2026-09-19. Every figure on the Today screen counts against a fixed program:

| | |
|---|---|
| Name | SiteLaunch 90 Day Program (editable) |
| Start | 2026-08-27, which is Day 1 |
| Target | 2026-11-25, the review date |
| Length | 91 days, both ends counted |

19 September 2026 is Day 24.

**Counting rules**, all implemented once in `src/config/program.ts`:

| Measure | Rule |
|---|---|
| Program day | Inclusive of the start. The start date is Day 1, not Day 0. |
| Total days | Inclusive of both ends. |
| Days remaining | Exclusive of today. The target date reads 0. |
| Phase membership | Inclusive at both ends. |
| Statistics | Inclusive of both the start and target dates. |

**Phases**, fixed against the agreed plan rather than derived from the configured dates,
so editing the start does not silently move them:

| Phase | Runs | For |
|---|---|---|
| 1 | 2026-08-27 to 2026-09-26 | Productize and Retain |
| 2 | 2026-09-27 to 2026-10-26 | Acquire and Measure |
| 3 | 2026-10-27 to 2026-11-25 | Prove and Systemize |

The program replaced a trailing 90 day window. A rolling window moves every morning, so a
figure can improve or worsen with nothing having happened, which is the opposite of what
this tool is for. The name, dates and an optional goal are editable under Data and Import
and travel inside a backup.

---

## 2c. Activity, and why it is not a task

A task is an intention and can be wrong. An activity is a record that something happened
and should not be. They are separate tables so a plan can never be mistaken for a result.

- Completing a task writes exactly one linked activity record. Deduplicated in code and by
  a partial unique index on `(owner_id, task_id) where source = 'task_completion'`.
- Skipping a task writes nothing, because skipping means it did not happen.
- Nothing backfills activity from historical records. If it was not written down at the
  time, the honest answer is that we do not know.
- Every activity carries its `source`, so a record created by finishing a task, imported
  from a file, or pulled from a calendar is always distinguishable from one typed by hand.

---

## 3. Scope

### In scope for v1
- Manual data entry for all entities.
- CSV import for performance snapshots and website (GA4) traffic exports.
- Content log, performance snapshots, website outcomes, pipeline, tasks.
- Deterministic recommendation engine with confidence labelling.
- Supabase schema + RLS, with a local storage adapter for offline/solo use.
- Netlify-compatible static production build.

### Added in the pre-API foundation sprint, 2026-09-19
- Fixed program dates, phases and day counting.
- `activity_events` and the Activity screen.
- Calendar columns and a server side sync contract. Nothing connected.
- Supabase email magic link sign in, sign out, and a signed out gate.
- Row level security hardening: `security_invoker` views, cross-owner foreign keys,
  immutable `owner_id`.
- Integration tables: connections, sync runs, daily GA4 and Search Console.

### Added in the relationship follow-up sprint, 2026-10-05

- `leads` gained an external key, the mirror's own labels, a follow-up mode and a
  reported last-touch date. `activity_events` gained a channel, an evidence source
  and an external source. No new tables: a relationship is a lead and a touch is an
  activity.
- One documented configuration module for follow-up rules,
  `src/config/followUp.ts`, plus the same derivation in SQL as
  `lead_follow_up_state(as_of)` for anything server side. A database test runs both
  over the same cases and fails if they disagree.
- Last touch, days since touch, next follow-up and follow-up status in Pipeline,
  derived from the activity log rather than stored.
- Logging a contact creates or reschedules exactly one follow-up task, enforced by
  a partial unique index as well as by the code.
- A one-time Google Sheet reconciliation, as a dry run and then a gated live
  import, and a server-side sync that rewrites the Sheet from Supabase afterwards.

### Added in the follow-up execution sprint, 2026-10-06

- The recurring follow-up task. Finishing one reopens it on its next date instead
  of leaving a finished task and starting another, and a repeat completion writes
  nothing at all. Migration 0009 adds the column that says which task the rule
  owns, and a unique index allowing one per lead in any state.
- `reconcile_follow_up_tasks(dry_run)`, the SQL twin of
  `src/config/followUpTasks.ts`, so every eligible lead has exactly one open
  follow-up and re-running changes nothing.
- One follow-up queue on Today, replacing the two sections that listed the same
  people twice, and an Action queue view on Pipeline alongside Board and Table.
- `/pipeline?lead=<uuid>` opens one record, so the queue can link to a person.
- Google Calendar: open follow-ups out to the person's **own primary calendar**,
  one way, under their own OAuth authorization, with an event id derived from the
  task so a retry cannot double-book. Nothing is read back, nothing is ever
  deleted, and no calendar is ever listed or searched.
- Connecting it is one button. Nobody is asked to create a calendar, share one
  with a service account, copy a calendar id, or supply a JSON key. The refresh
  token lives in Supabase Vault behind functions only the service role can call,
  and the browser never sees one.

### Explicitly out of scope for v1
- Instagram / Facebook / LinkedIn Graph API OAuth.
- GA4 Data API and Search Console API.
- Predictive modelling, ML, or LLM-generated recommendations.
- Multi-tenant / client-facing access.
- Email or calendar integrations.

### Deferred but architecturally preserved
`content_items.external_id` and `accounts.provider_account_id` exist so an API sync can
later match remote objects to local rows. `performance_snapshots.ingest_source` records
whether a row came from `manual`, `csv`, or (future) `api`, so imported history stays
distinguishable from synced history. The repository layer is an interface with swappable
adapters, so an API-backed adapter is additive rather than a rewrite.

---

## 4. Users

Alberto now, and a person who does not know much about marketing later. That second reader
is the one the copy is written for: they should be able to sit down in front of any screen
and work out what it is telling them without anyone explaining it.

Authentication exists to protect the data, not to model roles. v1 assumes one workspace,
one user, Supabase email auth.

**Copy rules, decided 2026-09-18:**
- No em dashes anywhere. `src/test/copy.test.ts` fails the build if one appears.
- Plain words over analytics vocabulary. Say "how many separate people saw it", not "reach".
- Every metric carries a short explanation of what it is and why it matters, always visible
  on screen rather than hidden behind a tooltip or a click.
- A number nobody recorded reads "Not checked". A number the platform will never give you
  reads "Not shared". Neither is ever a dash and neither is ever a zero.

---

## 5. Domain model

| Table | Holds | Key relationships |
|---|---|---|
| `accounts` | A platform presence (e.g. Instagram @sitelaunch) | referenced by `content_items` |
| `content_items` | One published or planned unit of content | to `accounts` |
| `performance_snapshots` | A point-in-time metric reading for a content item | to `content_items` |
| `traffic_snapshots` | Website outcomes for a source/medium/campaign over a date range | to `content_items` (optional) |
| `leads` | A prospect and their pipeline position | to `content_items` (optional attribution) |
| `tasks` | A dated action: follow-up, measurement check, publish | to `content_items`, `leads` (optional) |
| `recommendations` | A generated, evidence-backed suggestion | to `content_items` via `evidence` |

A content item may have many snapshots (24h, 7d, 30d, custom). Traffic and leads attach to
content by ID where attribution is known, and remain unattached where it is not.
**Unattached is a legitimate, expected state and must never be silently attributed.**

---

## 6. Screens

### 6.1 Today
The landing screen. Five blocks, in priority order:

1. **Today's scheduled action**, tasks of type `publish` or `marketing_action` due today.
2. **Follow-ups due**, overdue first, then today.
3. **Measurement due**, content published 24h / 7d / 30d ago with no snapshot of that
   window yet. Overdue checks are called out, because a missed 24-hour reading is
   unrecoverable on most platforms.
4. **Leads requiring action**, pipeline rows with a `next_action_date` today or earlier.
5. **One recommended next step**, the single highest-priority item across the above, with
   its reason shown. Exactly one. Not a list.

Plus a **90-day progress** strip: published count, measured count, leads, qualified,
proposals, won value. Each shown against the trailing 90-day window with the window dates
stated, not implied.

### 6.2 Content Log
Table plus detail drawer. Fields: platform, account, publish date/time, format
(story / reel / carousel / post / article), title, pillar, target audience, hook, CTA,
destination URL, UTM source/medium/campaign, external amplification flag and amplifier
name, notes, screenshot URL, status (draft / scheduled / published / measured).

A UTM builder composes the tracked destination URL from the base URL and UTM fields so the
link that ships matches the link the app will later match traffic against.

Filters: platform, format, pillar, status, amplification. Amplified items are visually
marked wherever they appear.

### 6.3 Performance Snapshots
Multiple per content item, typed `24h` / `7d` / `30d` / `custom`. Metrics captured: views,
reach, watch time (seconds), three-second views, interactions, likes, comments, shares,
saves, replies, profile visits, link clicks, website sessions, form starts, leads,
qualified leads.

Every field is nullable and empty by default. The entry form uses empty text inputs, not
zero-defaulted number spinners, so that "I didn't check" and "it was zero" stay distinct.
CSV import maps columns to these fields; blank cells import as `null`.

### 6.4 Website Outcomes
GA4-shaped rows: date range, source, medium, campaign, sessions, active users, engagement
time, engaged sessions, CTA clicks, form starts, `generate_lead` events, qualified
inquiries. Optionally linked to a content item when the campaign tag makes the link
unambiguous. CSV import accepts a GA4 traffic-acquisition export.

### 6.5 Pipeline
Stages: new contact, follow-up, qualified, call scheduled, proposal, waiting, won, lost.
Board and table views. Fields: prospect, project, source, related content or campaign, next
action, follow-up date, proposed value, closed value, notes.

### 6.6 Recommendations
Generated on demand from current data. Each card shows: the statement, a confidence label,
the rule that fired, the comparison set and its size, and the numbers. Cards can be
dismissed. Nothing is generated that cannot show its evidence.

---

## 7. Recommendation rules (v1)

All rules operate on **comparison cohorts**: same platform **and** same format. Externally
amplified items are excluded from every cohort baseline. Snapshots are normalised to the
latest available window per content item so a 7-day reading is not compared against a
24-hour reading.

**Confidence labelling**

| Label | Requirement |
|---|---|
| Early Signal | 2–4 comparable items, or a single item with a recorded downstream outcome |
| Emerging Pattern | 5 or more comparable items and the effect holds |
| Reliable Pattern | 12 or more comparable items, spanning 2 or more pillars, effect holds |

A cohort below 5 items may never produce a statement that content "works", "performs
better", or "should be scaled". Below 5, permitted verbs are: *suggests*, *may*,
*not yet measurable*.

**Rules**

| # | Rule | Fires when | Output |
|---|---|---|---|
| R1 | Downstream winners | Cohort has 5+ members and the item's leads or qualified leads exceed the cohort mean | Name the item and the outcome; recommend repeating the format |
| R2 | Traffic producers | Item has website sessions or link clicks above cohort mean | Identify as traffic-generating; recommend tracked repeat |
| R3 | Engaged but inert | Shares + saves above cohort mean while sessions and link clicks are 0 or null | Flag the CTA/tracking gap, not the content |
| R4 | High views, no action | Views above cohort mean with no link clicks, sessions, or leads | Flag as attention without conversion; recommend a tracked CTA |
| R5 | Measurement gaps | Published items with no snapshot past the due window | Report as a data problem, never as a performance verdict |
| R6 | Insufficient evidence | Cohort below 5 | Explicit "not yet measurable" card stating how many more items are needed |
| R7 | Amplification notice | Amplified item present in a platform/format group | State exclusion and why, to prevent it being read as a result |

Rules R6 and R7 exist so the absence of a conclusion is itself displayed. Silence in this
tool means "we haven't measured", and the tool should say so out loud.

---

## 8. Data integrity rules

- All metric fields are `NUMERIC NULL`, never `DEFAULT 0`.
- Averages use only non-null values and report the non-null count alongside.
- `is_externally_amplified = true` excludes a row from cohort statistics; the row is still
  visible and still counted in raw totals, labelled as amplified.
- `traffic_snapshots` may not be summed into a content item's metrics automatically. A link
  is an assertion the user makes, shown as "linked by campaign tag", not as truth.
- Seed data is marked `is_seed = true` so demonstration rows can be identified and removed
  without guesswork.

---

## 9. Visual design

Editorial, print-derived, restrained.

- Warm ivory ground (`#FAF7F2`), charcoal text (`#1F1D1A`), violet accent (`#5B4B8A`) used
  only for interactive affordances and the single "next step".
- Serif display for headings, system sans for interface and data.
- Thin 1px rules (`#E3DDD3`) instead of cards, shadows, or fills. No gradients, no glass, no
  drop shadows.
- Generous vertical rhythm; tables breathe.
- Data states have distinct typographic treatment: observed values in regular weight,
  derived values in italic grey with an explicit label, recommendations in bordered blocks.
- Fully responsive down to 375px; tables collapse to stacked records rather than scroll.

---

## 10. Non-goals for v1 (stated so they are not mistaken for omissions)

- No attribution modelling. Where attribution is unknown, the tool shows "Unknown".
- No forecasting, targets, or projections.
- No scoring of content into a single composite number. Composite scores hide exactly the
  distinction (views vs. leads) this tool exists to preserve.

---

## 12. Security boundary

**The rule:** anything the browser can read, a user can read. Anything named `VITE_` is
inlined into the bundle at build time.

| Browser | Server side only |
|---|---|
| `VITE_SUPABASE_URL` | `SUPABASE_SERVICE_ROLE_KEY` |
| `VITE_SUPABASE_ANON_KEY` | Every provider client secret and token |

The anon key is public by design and grants nothing on its own. Row level security decides
what the signed in user can read.

**Database protections** (migration 0004):

1. **Views run as the caller.** Both views now set `security_invoker = true`. Without it a
   view executes as its owner and bypasses row level security on the tables it reads, so
   any authenticated user selecting from `cohort_stats` would have seen every owner's rows
   aggregated together.
2. **No cross-owner relationships.** Each parent has a unique key on `(id, owner_id)` and
   each child references that composite key. A row owned by one user cannot point at
   another user's account, content, lead or task, and this is enforced by the database
   rather than by the interface.
3. **`owner_id` is immutable.** A trigger refuses any update that changes it.
4. **Every composite `SET NULL` names the column it clears.** A bare
   `ON DELETE SET NULL` clears every column in the foreign key. Since `owner_id` is
   part of these keys and is `NOT NULL`, deleting a parent failed outright, and also
   tried to change `owner_id`, which rule 3 forbids. Deleting an account was
   impossible. Found by running the migrations against a real Postgres, not by
   reading them.

**Migration order** is 0001, 0003, 0004, 0005. There is no 0002: it was the seed
data, and it moved to `supabase/seed.sql` because it needs a user to exist and a
migration runs before anybody has signed up. See `supabase/README.md`.

**Database testing.** `npm run test:db` applies every migration to a real PostgreSQL
through PGlite and exercises the constraints, rather than matching strings in the SQL.
The `auth` schema, `auth.uid()` and the two Supabase roles are stubbed because
Postgres does not ship them; everything else is the project's own SQL unmodified.

**Integration data flow:**

```
Provider API -> server function (holds secrets) -> Supabase -> RLS -> browser reads
```

No Google or Meta adapter belongs in the browser repository. API data lands in daily
tables with unique keys so a repeated sync upserts. `traffic_snapshots` keeps its
range-based shape for manual and CSV entry, unchanged.

---

## 13. Next sprint, connecting APIs

Order, website numbers first because they are the ones tied to enquiries:

1. GA4 daily traffic
2. Google Search Console daily queries
3. Website enquiry ingestion into Pipeline
4. Google Calendar, tasks out and events back
5. Instagram and Facebook
6. Other social platforms, later and only if they earn it

**AWS is not required for this MVP.** Supabase plus Edge Functions covers the database,
authentication, row level security, secret storage and scheduled server side syncs.
Adding AWS would mean another account, another deployment path and another place for
credentials to live, for no capability this app needs.

---

## 14. Where this is going

Recorded here while the v1 Google Sheet connection is being built, because the
shape of that connection is only defensible if the destination is written down.
None of this section is built yet. It is here to be designed against, not
implemented in this sprint.

### 14.1 The Sheet is Alberto's migration, not every customer's job

The spreadsheet connected in October 2026 is a private, one-off reconciliation of
a history that was kept by hand, plus a readable mirror afterwards. It is
deliberately **not** the shape of the product.

No future customer is expected to build, maintain or import a spreadsheet. A
customer who wants one gets a mirror of their own data, as an export and a
convenience; a customer who does not want one never hears about it. Anything in
the code that assumed otherwise would be a design error, which is why the Sheet
is modelled as one optional provider in `integration_connections` rather than as a
required step in onboarding, and why nothing on any screen depends on the
spreadsheet being current.

### 14.2 The intended customer workflow

1. A customer creates an account.
2. They connect Google Calendar, and any other Google Workspace service they want,
   through their own OAuth authorization. Their tokens, not a shared service
   account.
3. They connect their own analytics and social accounts through each provider's
   OAuth.
4. The Cockpit stores the normalized, authoritative records in Supabase.
5. They tell the Cockpit AI things in plain words: "Add Taylor from Your Local
   Handyman", "I emailed him today", "Remind me to follow up next week".
6. The AI performs validated, server-side tool calls that create or update the
   lead, add the touch to the history, recalculate the next follow-up, and create
   or reschedule the matching calendar item.
7. The Google Sheet, if they want one at all, is a synchronized mirror or an
   export. It is never the AI's memory and never a source of truth.
8. There is no double entry. One sentence updates Supabase, the Cockpit screens,
   the optional Sheet and the relevant calendar item, because they are all reading
   or being written from the same record.
9. Manual forms stay as an administrative fallback, for recovery and for the
   things conversation is bad at. They are not the intended path.
10. Daily operational data arrives from APIs, OAuth, webhooks, scheduled syncs or
    conversational tool calls. After the one historical reconciliation, nothing
    routine should require typing.

### 14.3 What this sprint did to make that possible

Three things, all of them deliberate rather than incidental:

- **Recording a touch is a function, not a submit handler.** `recordContact` in
  `src/data/leadFollowUp.ts` takes a lead, a day and a repository, and does the
  whole job: schedule or reschedule the one follow-up, move the lead's date, leave
  a reason. A server-side tool call needs the same function with a different
  transport, not a reimplementation of a form.
- **The follow-up rule is configuration, in one place.** `src/config/followUp.ts`
  holds the cadence per stage, the due-soon threshold, and which activity types
  count as contact. An AI that suggests when to chase somebody will read this
  rather than invent its own arithmetic, so its suggestions and the screens cannot
  disagree.
- **Authority is in Supabase and derivable there.** `lead_follow_up_state(as_of)`
  answers "how long has this person been waiting, and what is their follow-up
  status" in the database, as at any date. Recommendations are meant to read that,
  not scrape a spreadsheet.

### 14.4 The daily home screen, eventually

Today becomes something closer to a business newspaper: one screen, read once a
day, that says what happened and what to do. The sections, in the order they
matter:

- Traffic and search movement
- Social content performance
- Leads needing attention
- Days since the last confirmed touch
- Today's follow-ups and calendar commitments
- Recommended outreach
- Recommended content, and when to post it
- The evidence behind each recommendation
- Progress against the customer's 30, 60 or 90 day program

Two rules carry over from everything above. Every recommendation reads
authoritative Supabase records, never a spreadsheet. And every recommendation
shows its evidence, because a suggestion whose reasoning cannot be inspected is a
suggestion nobody should act on.

### 14.5 What is deliberately not being attempted yet

Multi-user OAuth, per-customer token storage, the AI tool-call layer and the
newspaper screen itself. Each one is a sprint. Writing them down is not the same
as starting them, and starting them early would have meant shipping a Sheet
connection with a multi-tenant abstraction nobody had tested.

---

## 11. Acceptance criteria

1. A content item can be created, published, snapshotted at 24h and 7d, and appear on
   Today's measurement queue at the right times.
2. A metric left blank stays blank everywhere and is absent from every average.
3. The amplified seed record never influences a cohort mean, and its exclusion is stated.
4. With the two seed records only, the recommendations screen returns insufficient-evidence
   cards, not performance claims.
5. `npm run lint`, `npm run typecheck`, and `npm run build` all pass clean.
6. The app is usable at 375px width.
7. A lead's last touch comes from its activity history, and a date that was only
   reported by an import is labelled as reported rather than shown as logged.
8. Running the Google Sheet reconciliation three times creates no extra leads and
   no extra activities.
9. A sheet row that could match more than one existing person is left completely
   unchanged and reported.
10. Logging a contact leaves exactly one open follow-up task for that lead, and a
    lead on hold, archived or set to no follow-up has nothing scheduled for it.
11. No Google credential, service account address, private key, spreadsheet id,
    OAuth client or refresh token appears anywhere in the built browser bundle.
12. Every eligible lead has exactly one open follow-up task, and three identical
    reconciliations leave the count unchanged.
13. Completing a follow-up records one activity and reopens the same task on its
    next date, with the completion cleared and the calendar marked stale.
14. Three identical calendar syncs leave one event per task, and a create that
    Google completed but never reported does not become a second event.
15. A failed calendar write keeps the stored event id and records a sanitized
    reason, so the next run updates rather than duplicates.
16. Connecting a Google Calendar needs a real signed in session. The scheduler's
    shared secret is refused, because it cannot consent on anybody's behalf.
17. An authorization state is owner bound, expires in minutes, and can be spent
    exactly once. A forged, replayed or expired callback changes nothing and is
    answered identically to one that was never issued.
18. `primary` is acceptable only when the credential is the person's own. The
    service account is refused it outright.
19. The scheduled calendar sync covers every owner who holds a token, and one
    owner's expired authorization does not stop any other owner's sync.
20. Disconnecting forgets the authorization and removes no calendar event.
