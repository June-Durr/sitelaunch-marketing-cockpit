-- SiteLaunch Marketing Cockpit, migration 0005
--
-- The tables a server-side sync will write into. Nothing calls an external API in
-- this sprint; this is the shape the data has to land in when something does.
--
-- WHY DAILY TABLES RATHER THAN THE EXISTING traffic_snapshots
--
-- traffic_snapshots holds a date RANGE, because a person reading a GA4 report by
-- hand thinks in ranges. Ranges overlap, and overlapping rows cannot be re-synced
-- safely: running a sync twice over 1 to 30 September and 15 September to 15
-- October would double count the overlap with no way to tell which row was right.
--
-- An API sync needs the opposite: one row per day per dimension, with a unique key
-- the sync can upsert against. Re-running then updates in place and is harmless.
-- The two models coexist. traffic_snapshots keeps working for manual and CSV entry
-- and nothing about it changes.
--
-- NO TOKENS LIVE HERE
--
-- integration_connections records that a connection exists and what it can do. It
-- deliberately has no column for an access or refresh token. Tokens belong in
-- Supabase Vault or the secret store of whatever server function performs the
-- sync, reachable by the service role and never by the browser. Anything the
-- browser can read, a user can read.

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

create type integration_provider as enum (
  'ga4', 'search_console', 'google_calendar', 'instagram', 'facebook',
  'linkedin', 'tiktok', 'website_forms'
);

create type integration_status as enum (
  'not_configured',   -- nothing set up at all
  'ready',            -- credentials exist server side, waiting to be connected
  'connected',        -- connected and healthy
  'syncing',          -- a run is in flight
  'error'             -- last attempt failed, see error_message
);

create type sync_status as enum ('running', 'succeeded', 'failed', 'skipped');

-- ---------------------------------------------------------------------------
-- integration_connections
-- ---------------------------------------------------------------------------

create table integration_connections (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,

  provider            integration_provider not null,
  -- The provider's own identifier for the account, such as a GA4 property id.
  provider_account_id text,
  display_name        text,

  status              integration_status not null default 'not_configured',
  -- What the connection is actually permitted to do, as granted by the provider.
  granted_scopes      text[] not null default '{}',

  connected_at        timestamptz,
  last_synced_at      timestamptz,
  error_message       text,
  error_at            timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One connection per provider per owner. Re-connecting updates in place.
  unique (owner_id, provider),

  constraint connected_needs_timestamp
    check (status <> 'connected' or connected_at is not null),
  constraint error_needs_message
    check (status <> 'error' or error_message is not null)
);

create index integration_connections_owner_idx on integration_connections (owner_id, provider);

-- ---------------------------------------------------------------------------
-- sync_runs
--
-- An audit trail of every attempt, successful or not. idempotency_key is what
-- stops the same logical run being executed twice, for instance when a scheduler
-- retries after a timeout that actually succeeded.
-- ---------------------------------------------------------------------------

create table sync_runs (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  connection_id   uuid references integration_connections (id) on delete set null,

  provider        integration_provider not null,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  status          sync_status not null default 'running',

  rows_read       integer,
  rows_written    integer,
  error_summary   text,

  -- Usually provider + window, for example 'ga4:2026-09-01:2026-09-19'.
  idempotency_key text not null,

  created_at      timestamptz not null default now(),

  unique (owner_id, idempotency_key),

  constraint finished_runs_have_an_end
    check (status = 'running' or completed_at is not null),
  constraint failed_runs_explain_themselves
    check (status <> 'failed' or error_summary is not null),
  constraint counts_are_not_negative
    check (coalesce(rows_read, 0) >= 0 and coalesce(rows_written, 0) >= 0)
);

create index sync_runs_owner_started_idx on sync_runs (owner_id, provider, started_at desc);

-- ---------------------------------------------------------------------------
-- ga4_daily_traffic
--
-- One row per day per source/medium/campaign. The unique key is what makes a
-- re-sync an update rather than a duplicate.
--
-- The dimension columns are NOT NULL with a '(none)' default rather than nullable,
-- because NULL never equals NULL in a unique index, so nullable dimensions would
-- let duplicate rows through exactly where GA4 reports no campaign. Metrics stay
-- nullable, because a metric that was not returned is still unknown, not zero.
-- ---------------------------------------------------------------------------

create table ga4_daily_traffic (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  connection_id        uuid references integration_connections (id) on delete set null,

  date                 date not null,
  source               text not null default '(none)',
  medium               text not null default '(none)',
  campaign             text not null default '(none)',

  sessions             integer,
  active_users         integer,
  new_users            integer,
  engaged_sessions     integer,
  engagement_time_secs numeric,
  bounce_rate          numeric,
  conversions          integer,
  generate_lead_events integer,

  synced_at            timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- The upsert target. Re-running a sync over the same window updates these rows.
  constraint ga4_daily_traffic_unique_day_dimension
    unique (owner_id, date, source, medium, campaign)
);

create index ga4_daily_traffic_date_idx on ga4_daily_traffic (owner_id, date desc);

-- ---------------------------------------------------------------------------
-- search_console_daily
--
-- Same shape of problem, more dimensions. position is nullable because Search
-- Console withholds it for low volume queries, and a withheld figure is unknown
-- rather than zero.
-- ---------------------------------------------------------------------------

create table search_console_daily (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  connection_id    uuid references integration_connections (id) on delete set null,

  date             date not null,
  query            text not null default '(none)',
  page             text not null default '(none)',
  country          text not null default '(none)',
  device           text not null default '(none)',

  clicks           integer,
  impressions      integer,
  ctr              numeric,
  average_position numeric,

  synced_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint search_console_daily_unique_day_dimension
    unique (owner_id, date, query, page, country, device)
);

create index search_console_daily_date_idx  on search_console_daily (owner_id, date desc);
create index search_console_daily_query_idx on search_console_daily (owner_id, query);

-- ---------------------------------------------------------------------------
-- updated_at, ownership and row level security
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'integration_connections', 'ga4_daily_traffic', 'search_console_daily'
  ]
  loop
    execute format(
      'create trigger %I_set_updated_at before update on %I
       for each row execute function set_updated_at()', t, t);
  end loop;

  foreach t in array array[
    'integration_connections', 'sync_runs', 'ga4_daily_traffic', 'search_console_daily'
  ]
  loop
    execute format(
      'create trigger %I_refuse_owner_change before update on %I
       for each row execute function refuse_owner_change()', t, t);
    execute format('alter table %I enable row level security', t);
  end loop;
end;
$$;

-- Same owner rule as everywhere else: a connection's children belong to the
-- same person as the connection.
alter table integration_connections
  add constraint integration_connections_id_owner_key unique (id, owner_id);

alter table sync_runs drop constraint sync_runs_connection_id_fkey;
alter table sync_runs
  add constraint sync_runs_connection_same_owner
  foreign key (connection_id, owner_id)
  references integration_connections (id, owner_id)
  on delete set null;

alter table ga4_daily_traffic drop constraint ga4_daily_traffic_connection_id_fkey;
alter table ga4_daily_traffic
  add constraint ga4_daily_traffic_connection_same_owner
  foreign key (connection_id, owner_id)
  references integration_connections (id, owner_id)
  on delete set null;

alter table search_console_daily drop constraint search_console_daily_connection_id_fkey;
alter table search_console_daily
  add constraint search_console_daily_connection_same_owner
  foreign key (connection_id, owner_id)
  references integration_connections (id, owner_id)
  on delete set null;

-- Readable by the owner. Writes are expected to come from a server function using
-- the service role, which bypasses RLS, so the browser gets read access only on
-- the synced data tables.
create policy integration_connections_owner_read on integration_connections
  for select to authenticated using (owner_id = auth.uid());

create policy sync_runs_owner_read on sync_runs
  for select to authenticated using (owner_id = auth.uid());

create policy ga4_daily_traffic_owner_read on ga4_daily_traffic
  for select to authenticated using (owner_id = auth.uid());

create policy search_console_daily_owner_read on search_console_daily
  for select to authenticated using (owner_id = auth.uid());
