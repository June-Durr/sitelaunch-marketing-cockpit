-- SiteLaunch Marketing Cockpit, migration 0003
--
-- Adds the activity log, and the calendar columns a future sync will need.
--
-- Tasks and activity answer different questions. A task is an intention and can be
-- wrong. An activity is a record that something happened and should not be. The two
-- stay separate tables so a plan can never be mistaken for a result.
--
-- Nothing here connects to a calendar. The columns exist so that adding a sync later
-- is an insert of code rather than a migration of live data.

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

create type activity_type as enum (
  'content_published', 'networking_event', 'contact_added', 'follow_up_sent',
  'reply_received', 'client_work', 'website_update', 'analytics_check',
  'lead_created', 'proposal_sent', 'revenue_received', 'unavailable',
  'decision', 'other'
);

-- Where a record came from. Never inferred: a row is labelled by whatever wrote it.
create type activity_source as enum ('manual', 'task_completion', 'calendar', 'import', 'api');

create type calendar_sync_status as enum ('not_synced', 'pending', 'synced', 'error');

-- ---------------------------------------------------------------------------
-- Calendar columns on tasks
--
-- A Cockpit task may later be pushed out as a calendar event. The external ids
-- are what make that push idempotent: a second sync updates the same event
-- rather than creating a duplicate.
-- ---------------------------------------------------------------------------

alter table tasks
  add column external_calendar_id text,
  add column external_event_id    text,
  add column calendar_sync_status calendar_sync_status not null default 'not_synced',
  add column last_synced_at       timestamptz,
  add column sync_error           text;

-- ---------------------------------------------------------------------------
-- activity_events
-- ---------------------------------------------------------------------------

create table activity_events (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,

  -- When it happened, which is not the same as when it was typed in.
  occurred_at          timestamptz not null,
  activity_type        activity_type not null,
  title                text not null,
  details              text,
  source               activity_source not null default 'manual',
  -- An id belonging to whatever system this came from, for future syncs.
  external_id          text,

  content_item_id      uuid references content_items (id) on delete set null,
  lead_id              uuid references leads (id) on delete set null,
  task_id              uuid references tasks (id) on delete set null,

  external_calendar_id text,
  external_event_id    text,
  calendar_sync_status calendar_sync_status not null default 'not_synced',
  last_synced_at       timestamptz,
  sync_error           text,

  is_seed              boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint activity_title_not_blank check (length(btrim(title)) > 0)
);

create index activity_events_owner_time_idx on activity_events (owner_id, occurred_at desc);
create index activity_events_type_idx       on activity_events (owner_id, activity_type);
create index activity_events_task_idx       on activity_events (task_id);
create index activity_events_lead_idx       on activity_events (lead_id);
create index activity_events_content_idx    on activity_events (content_item_id);

-- ---------------------------------------------------------------------------
-- Deduplication
--
-- Finishing a task leaves exactly one automatic record, enforced in the database
-- rather than only in the UI. A hand written note that happens to mention the
-- same task is not covered by this, deliberately: deleting the automatic record
-- should never take somebody's own note with it.
-- ---------------------------------------------------------------------------

create unique index activity_one_per_completed_task
  on activity_events (owner_id, task_id)
  where task_id is not null and source = 'task_completion';

-- A synced calendar event must not be able to land twice. Partial, because almost
-- every row has no external event id at all.
create unique index activity_unique_external_event
  on activity_events (owner_id, external_calendar_id, external_event_id)
  where external_event_id is not null;

create unique index tasks_unique_external_event
  on tasks (owner_id, external_calendar_id, external_event_id)
  where external_event_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at and row level security
-- ---------------------------------------------------------------------------

create trigger activity_events_set_updated_at
  before update on activity_events
  for each row execute function set_updated_at();

alter table activity_events enable row level security;

create policy activity_events_owner_all on activity_events
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
