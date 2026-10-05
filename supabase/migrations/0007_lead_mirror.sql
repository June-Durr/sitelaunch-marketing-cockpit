-- SiteLaunch Marketing Cockpit, migration 0007
--
-- Relationship follow-up, and the columns a Google Sheet mirror needs.
--
-- WHY THIS EXTENDS leads AND activity_events RATHER THAN ADDING TABLES
--
-- A relationship is already a lead and a touch is already an activity. A separate
-- contacts table would mean two places to look for the same person, two places to
-- keep in step, and a join that nothing else in the app needs. Everything below is
-- a column, an index, or a derivation on top of the two tables that already exist.
--
-- WHAT THE SHEET IS, AND WHAT IT IS NOT
--
-- The Google Sheet is a human-readable mirror and a recovery reference. Supabase
-- is authoritative. One reconciliation brings the Sheet's history in; after that
-- the Sheet is rewritten from Supabase and never read back as truth. The columns
-- added here are what make that one-way relationship safe: an external key so a
-- re-import updates rather than duplicates, and the Sheet's own labels stored as
-- given so the mirror can be rebuilt without guessing.
--
-- NOTHING SECRET IS WRITTEN HERE
--
-- There is no token column, no service-account field and no spreadsheet id. The
-- spreadsheet id is an Edge Function secret, and the Google credential is read
-- from the function's environment at call time. See server/README.md.

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

-- The Sheet mirror is a provider like any other, so its connection state and its
-- run history live in integration_connections and sync_runs rather than in tables
-- of their own. Postgres will not let a value added here be used in this same
-- transaction, and nothing below needs to, so this is safe as one migration.
alter type integration_provider add value 'google_sheets';

-- A conversation is a touch in its own right. Without this, an imported
-- "Discovery conversation" would land as 'other', which reads as "something else"
-- on screen and tells the operator nothing.
alter type activity_type add value 'conversation';

/**
 * Why a lead with no follow-up date needs a reason.
 *
 * A blank next_action_date is ambiguous: it can mean "deliberately not chasing
 * this person" or "nobody has set one yet". Those call for opposite behaviour, so
 * the distinction is stored rather than inferred.
 *
 *   auto      The follow-up rule may schedule and reschedule this lead.
 *   none      No follow-up on purpose. Nothing is scheduled and nothing is nagged.
 *   hold      Paused, waiting on the other person. Not chased, not forgotten.
 *   archived  Finished with, kept for history.
 */
create type follow_up_mode as enum ('auto', 'none', 'hold', 'archived');

-- ---------------------------------------------------------------------------
-- leads: the external key, the Sheet's own labels, and the follow-up mode
-- ---------------------------------------------------------------------------

alter table leads
  -- Which system external_key belongs to, for example 'google_sheets'. Stored
  -- alongside the key so two sources can never collide on the same string.
  add column external_source       text,
  -- The source system's stable identifier, for example 'taylor-handyman'. This is
  -- what makes a re-import an update. It is NOT the primary key: id stays a uuid
  -- the database generates, so a readable external id never becomes a row id.
  add column external_key           text,

  -- The Sheet's own words, kept as given so the mirror can be rebuilt exactly and
  -- so no human label is quietly replaced by an enum that does not fit it.
  add column relationship           text,
  add column current_status          text,
  add column preferred_channel       text,
  add column record_confidence       text,

  add column follow_up_mode          follow_up_mode not null default 'auto',

  /**
   * A last-touch date asserted by a source with no event record behind it.
   *
   * Several rows in the first mirror carry a last-touch date but no matching entry
   * in the touch history. Inventing an activity for them would fabricate a record
   * of something happening; dropping the date would lose a fact the operator
   * actually knows. It is stored here instead, and every derivation reports which
   * of the two it used. Confirmed activity always wins.
   */
  add column reported_last_touch_at  date;

/**
 * One lead per external key per owner.
 *
 * Partial, because almost every lead has no external key at all: a lead typed in
 * by hand, or created by a future AI tool call, belongs to nobody's spreadsheet.
 * This index is what makes the reconciliation idempotent at the database level
 * rather than only in the importer's own logic.
 */
create unique index leads_unique_external_key
  on leads (owner_id, external_source, external_key)
  where external_key is not null;

create index leads_follow_up_mode_idx on leads (owner_id, follow_up_mode, next_action_date);

-- ---------------------------------------------------------------------------
-- activity_events: how a touch was made, where the evidence is, and its key
-- ---------------------------------------------------------------------------

alter table activity_events
  -- Pairs with the existing external_id, exactly as on leads.
  add column external_source  text,
  -- How the contact happened: email, phone, in person. Part of a touch's identity,
  -- which is why the import's fingerprint includes it.
  add column channel           text,
  -- Where the proof is: a Gmail thread, a user report. Not a link and not a
  -- credential, just the name of the place somebody could go and check.
  add column evidence_source   text;

/**
 * One activity per external key per owner.
 *
 * The reconciliation builds a fingerprint from source, lead key, date, activity
 * and channel. This index is what makes running it three times leave fifteen
 * activities rather than forty-five, and it does so in the database, so a bug in
 * the importer still cannot duplicate a touch.
 *
 * The existing activity_unique_external_event index covers calendar events, which
 * are keyed differently; the two do not overlap.
 */
create unique index activity_events_unique_external_key
  on activity_events (owner_id, external_source, external_id)
  where external_id is not null and external_source is not null;

create index activity_events_lead_time_idx
  on activity_events (owner_id, lead_id, occurred_at desc)
  where lead_id is not null;

-- ---------------------------------------------------------------------------
-- tasks: one open follow-up per lead, enforced
-- ---------------------------------------------------------------------------

/**
 * A lead may have at most one open follow-up task.
 *
 * "Never create duplicate follow-up tasks" is the requirement, and a requirement
 * that lives only in application code is one edit away from being untrue. Logging
 * a second contact reschedules the open task rather than adding another, and if
 * the code ever forgets, the database refuses.
 *
 * Done and skipped tasks are outside the index on purpose: the history of what was
 * chased and when is worth keeping, and only one of them can be open.
 */
create unique index tasks_one_open_follow_up_per_lead
  on tasks (owner_id, lead_id)
  where lead_id is not null and task_type = 'follow_up' and status = 'open';

-- ---------------------------------------------------------------------------
-- sync_runs: room for a run's own counts
-- ---------------------------------------------------------------------------

/**
 * What a run actually did, beyond rows read and written.
 *
 * A reconciliation has more outcomes than two numbers can carry: leads created,
 * leads updated, leads left alone, ambiguous matches, touches already present,
 * rows rejected. The Cockpit shows those, so they are stored. Written by the
 * server through the sanitizer, same as error_summary, because anything readable
 * by the browser is readable by whoever is signed in.
 */
alter table sync_runs
  add column details jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- The follow-up derivation
--
-- WHY A FUNCTION AND NOT A VIEW
--
-- Every value here depends on what day it is. A view reading current_date cannot
-- be tested: there is no way to ask it what it would have said last Tuesday. The
-- date is a parameter instead, so the same code path serves the application, the
-- Sheet export and a test pinned to a fixed day.
--
-- WHY THIS LIVES IN SQL AT ALL
--
-- The Sheet mirror is written by a server function with no browser involved, and
-- future recommendations are meant to read authoritative Supabase data rather than
-- recompute from a spreadsheet. Both need this derivation server side. The
-- matching configuration and the client-side implementation live in
-- src/config/followUp.ts, and src/test/pg/followUp.test.ts asserts the two agree
-- case for case, so the duplication is checked rather than hoped about.
--
-- WHICH ACTIVITIES COUNT AS A TOUCH
--
-- A deny-list, not an allow-list. The types excluded below are the ones that are
-- definitionally not contact with a person: publishing, checking numbers, updating
-- a site, being paid, being unavailable, doing the work, recording a decision.
-- Everything else counts, including 'other', because an imported label this app
-- has never seen is far more likely to be a conversation than not, and treating an
-- unknown touch as no touch would quietly overstate how long someone has waited.
-- ---------------------------------------------------------------------------

create or replace function lead_follow_up_state(as_of date)
returns table (
  lead_id                 uuid,
  owner_id                uuid,
  -- The newest confirmed contact activity, or null when there is none.
  last_touch_at           timestamptz,
  -- The day of that activity, read in UTC. Date-only imports are stored at noon
  -- UTC precisely so this agrees with slicing the ISO string in TypeScript.
  last_touch_on           date,
  -- Confirmed activity if there is any, otherwise the date the source asserted.
  effective_last_touch_on date,
  -- 'activity', 'reported' or 'none'. Never guessed, always reported.
  last_touch_basis        text,
  touch_count             integer,
  days_since_touch        integer,
  next_action_date        date,
  follow_up_mode          follow_up_mode,
  follow_up_status        text
)
language sql
stable
as $$
  with touches as (
    select
      a.lead_id,
      a.owner_id,
      max(a.occurred_at) as last_touch_at,
      count(*)::integer  as touch_count
    from activity_events a
    where a.lead_id is not null
      and a.activity_type not in (
        'content_published', 'website_update', 'analytics_check',
        'revenue_received', 'unavailable', 'client_work', 'decision'
      )
    group by a.lead_id, a.owner_id
  )
  select
    l.id,
    l.owner_id,
    t.last_touch_at,
    (t.last_touch_at at time zone 'UTC')::date as last_touch_on,
    coalesce((t.last_touch_at at time zone 'UTC')::date, l.reported_last_touch_at)
      as effective_last_touch_on,
    case
      when t.last_touch_at is not null        then 'activity'
      when l.reported_last_touch_at is not null then 'reported'
      else 'none'
    end as last_touch_basis,
    coalesce(t.touch_count, 0) as touch_count,
    (as_of - coalesce((t.last_touch_at at time zone 'UTC')::date, l.reported_last_touch_at))
      as days_since_touch,
    l.next_action_date,
    l.follow_up_mode,
    case
      -- Explicit intent first. A deliberate decision outranks any arithmetic.
      when l.follow_up_mode = 'archived'            then 'archived'
      when l.stage in ('won', 'lost')               then 'closed'
      when l.follow_up_mode = 'hold'                then 'on_hold'
      when l.follow_up_mode = 'none'                then 'not_scheduled'
      when l.next_action_date is null               then 'not_scheduled'
      when l.next_action_date <  as_of              then 'overdue'
      when l.next_action_date =  as_of              then 'due_today'
      -- 3 days. Kept in step with DUE_SOON_DAYS in src/config/followUp.ts by test.
      when l.next_action_date <= as_of + 3          then 'due_soon'
      else 'scheduled'
    end as follow_up_status
  from leads l
  left join touches t on t.lead_id = l.id and t.owner_id = l.owner_id;
$$;

comment on function lead_follow_up_state(date) is
  'Last touch, days since touch and follow-up status for every visible lead, as '
  'at a given date. Security invoker, so row level security on leads and '
  'activity_events decides which rows a caller sees.';

-- Not security definer, so the function runs as whoever calls it and the existing
-- row level security on leads and activity_events still applies. A definer
-- function here would hand every caller every owner's pipeline.
revoke all on function lead_follow_up_state(date) from public;
revoke all on function lead_follow_up_state(date) from anon;
grant execute on function lead_follow_up_state(date) to authenticated;

/**
 * The same thing as at today, for callers that do not want to pass a date.
 *
 * security_invoker, for the same reason as the views in migration 0004: without
 * it a view reads its underlying tables as the view's owner and walks straight
 * past row level security.
 */
create or replace view lead_follow_up_today as
  select * from lead_follow_up_state(current_date);

alter view lead_follow_up_today set (security_invoker = true);

revoke all on lead_follow_up_today from anon;
grant select on lead_follow_up_today to authenticated;
