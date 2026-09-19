-- SiteLaunch Marketing Cockpit — initial schema
-- v1: manual entry + CSV import. No external API sync yet, but columns exist
-- (external_id, provider_account_id, ingest_source) so sync can be added additively.
--
-- Data integrity rule enforced throughout: metric columns are NULL-able and have NO
-- DEFAULT 0. "Not recorded" and "recorded as zero" are different facts.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------

create type platform as enum (
  'instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'x', 'email', 'blog', 'other'
);

create type content_format as enum (
  'story', 'reel', 'carousel', 'post', 'article', 'video', 'other'
);

create type content_status as enum ('draft', 'scheduled', 'published', 'measured');

create type snapshot_window as enum ('24h', '7d', '30d', 'custom');

create type ingest_source as enum ('manual', 'csv', 'api');

create type lead_stage as enum (
  'new_contact', 'follow_up', 'qualified', 'call_scheduled',
  'proposal', 'waiting', 'won', 'lost'
);

create type task_type as enum (
  'marketing_action', 'publish', 'follow_up', 'measurement_check', 'admin'
);

create type task_status as enum ('open', 'done', 'skipped');

create type confidence_label as enum ('early_signal', 'emerging_pattern', 'reliable_pattern');

-- ---------------------------------------------------------------------------
-- accounts — one row per platform presence
-- ---------------------------------------------------------------------------

create table accounts (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  platform            platform not null,
  handle              text not null,
  display_name        text,
  -- Reserved for a future Graph/LinkedIn API sync. Unused in v1.
  provider_account_id text,
  is_active           boolean not null default true,
  notes               text,
  is_seed             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (owner_id, platform, handle)
);

-- ---------------------------------------------------------------------------
-- content_items — one row per published (or planned) unit of content, per account.
-- A cross-post to two platforms is TWO rows sharing a cross_post_group_id, because
-- metrics are reported per account and must not be merged.
-- ---------------------------------------------------------------------------

create table content_items (
  id                       uuid primary key default gen_random_uuid(),
  owner_id                 uuid not null default auth.uid() references auth.users (id) on delete cascade,
  account_id               uuid references accounts (id) on delete set null,
  cross_post_group_id      uuid,

  title                    text not null,
  format                   content_format not null,
  status                   content_status not null default 'draft',
  published_at             timestamptz,

  pillar                   text,
  target_audience          text,
  hook                     text,
  cta                      text,

  destination_url          text,
  utm_source               text,
  utm_medium               text,
  utm_campaign             text,

  -- Third-party amplification (a repost by a larger account, a paid boost).
  -- Amplified rows are excluded from every comparison baseline.
  is_externally_amplified  boolean not null default false,
  amplifier_name           text,
  amplification_note       text,

  notes                    text,
  screenshot_url           text,

  -- Reserved for future API sync (e.g. an Instagram media id).
  external_id              text,

  is_seed                  boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint published_needs_timestamp
    check (status in ('draft', 'scheduled') or published_at is not null),
  constraint amplifier_named_when_amplified
    check (is_externally_amplified = false or amplifier_name is not null)
);

create index content_items_owner_published_idx on content_items (owner_id, published_at desc);
create index content_items_cohort_idx          on content_items (owner_id, format, status);
create index content_items_campaign_idx        on content_items (owner_id, utm_campaign);

-- ---------------------------------------------------------------------------
-- performance_snapshots — a point-in-time metric reading for one content item.
-- Every metric is nullable with no default. Blank means "not recorded".
-- ---------------------------------------------------------------------------

create table performance_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_item_id     uuid not null references content_items (id) on delete cascade,

  window_type         snapshot_window not null,
  captured_at         timestamptz not null default now(),

  views               integer,
  reach               integer,
  watch_time_seconds  numeric,
  three_second_views  integer,
  interactions        integer,
  likes               integer,
  comments            integer,
  shares              integer,
  saves               integer,
  replies             integer,
  profile_visits      integer,
  link_clicks         integer,
  website_sessions    integer,
  form_starts         integer,
  leads               integer,
  qualified_leads     integer,

  -- Set when the platform reports nothing at the content level (e.g. Facebook
  -- Stories cross-posted from Instagram). Distinct from "not yet checked".
  metrics_unavailable boolean not null default false,
  unavailable_reason  text,

  ingest_source       ingest_source not null default 'manual',
  notes               text,
  is_seed             boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (content_item_id, window_type, captured_at)
);

create index performance_snapshots_item_idx on performance_snapshots (content_item_id, window_type);

-- ---------------------------------------------------------------------------
-- traffic_snapshots — website outcomes for a source/medium/campaign over a range.
-- Linking to a content item is an assertion the operator makes, never inferred.
-- ---------------------------------------------------------------------------

create table traffic_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_item_id       uuid references content_items (id) on delete set null,

  range_start           date not null,
  range_end             date not null,

  source                text,
  medium                text,
  campaign              text,

  sessions              integer,
  active_users          integer,
  engagement_time_secs  numeric,
  engaged_sessions      integer,
  cta_clicks            integer,
  form_starts           integer,
  generate_lead_events  integer,
  qualified_inquiries   integer,

  ingest_source         ingest_source not null default 'manual',
  notes                 text,
  is_seed               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint range_is_ordered check (range_end >= range_start)
);

create index traffic_snapshots_range_idx    on traffic_snapshots (owner_id, range_start, range_end);
create index traffic_snapshots_campaign_idx on traffic_snapshots (owner_id, source, medium, campaign);

-- ---------------------------------------------------------------------------
-- leads — the pipeline
-- ---------------------------------------------------------------------------

create table leads (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_item_id    uuid references content_items (id) on delete set null,

  prospect_name      text not null,
  organization       text,
  email              text,
  phone              text,

  project            text,
  source             text,
  related_campaign   text,

  stage              lead_stage not null default 'new_contact',
  next_action        text,
  next_action_date   date,

  proposed_value     numeric,
  closed_value       numeric,

  -- Set only when the operator can actually evidence the link. Null means unknown,
  -- and unknown is displayed as unknown.
  attribution_note   text,

  notes              text,
  is_seed            boolean not null default false,
  first_contact_at   date,
  closed_at          date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint closed_value_only_when_closed
    check (closed_value is null or stage in ('won', 'lost'))
);

create index leads_stage_idx      on leads (owner_id, stage);
create index leads_next_action_idx on leads (owner_id, next_action_date);

-- ---------------------------------------------------------------------------
-- tasks — dated actions, including automatic measurement checks
-- ---------------------------------------------------------------------------

create table tasks (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content_item_id  uuid references content_items (id) on delete cascade,
  lead_id          uuid references leads (id) on delete cascade,

  title            text not null,
  task_type        task_type not null default 'marketing_action',
  status           task_status not null default 'open',
  due_date         date not null,
  -- For measurement_check tasks: which snapshot window this check is for.
  window_type      snapshot_window,
  notes            text,
  completed_at     timestamptz,
  is_seed          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index tasks_due_idx on tasks (owner_id, status, due_date);

-- ---------------------------------------------------------------------------
-- recommendations — deterministic rule output, persisted so it can be dismissed
-- and so the evidence behind a past suggestion stays auditable.
-- ---------------------------------------------------------------------------

create table recommendations (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,

  rule_id           text not null,          -- e.g. 'R3_engaged_but_inert'
  headline          text not null,
  detail            text not null,
  suggested_action  text,
  confidence        confidence_label not null,

  -- Cohort the rule compared within, so the claim can be re-checked later.
  cohort_platform   platform,
  cohort_format     content_format,
  sample_size       integer not null,

  -- Structured evidence: the rows and numbers that produced the statement.
  -- Shape: { comparisons: [{label, value, unit}], content_item_ids: [...], excluded: [...] }
  evidence          jsonb not null default '{}'::jsonb,

  generated_at      timestamptz not null default now(),
  dismissed_at      timestamptz,
  created_at        timestamptz not null default now(),

  constraint sample_size_non_negative check (sample_size >= 0)
);

create index recommendations_active_idx on recommendations (owner_id, dismissed_at, generated_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'accounts', 'content_items', 'performance_snapshots',
    'traffic_snapshots', 'leads', 'tasks'
  ]
  loop
    execute format(
      'create trigger %I_set_updated_at before update on %I
       for each row execute function set_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security — internal tool, one operator owns their rows
-- ---------------------------------------------------------------------------

alter table accounts              enable row level security;
alter table content_items         enable row level security;
alter table performance_snapshots enable row level security;
alter table traffic_snapshots     enable row level security;
alter table leads                 enable row level security;
alter table tasks                 enable row level security;
alter table recommendations       enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'accounts', 'content_items', 'performance_snapshots',
    'traffic_snapshots', 'leads', 'tasks', 'recommendations'
  ]
  loop
    execute format(
      'create policy %I_owner_all on %I
       for all to authenticated
       using (owner_id = auth.uid())
       with check (owner_id = auth.uid())', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cohort statistics view.
-- Excludes externally amplified items from every baseline, and counts non-null
-- observations per metric so callers can report the real sample size.
-- ---------------------------------------------------------------------------

create or replace view content_latest_snapshot as
select distinct on (s.content_item_id)
  s.*
from performance_snapshots s
order by s.content_item_id,
         case s.window_type
           when '30d' then 4 when '7d' then 3 when '24h' then 2 else 1
         end desc,
         s.captured_at desc;

create or replace view cohort_stats as
select
  c.owner_id,
  a.platform          as platform,
  c.format            as format,
  count(*)                                   as cohort_size,
  count(s.views)                             as views_n,
  avg(s.views)                               as views_mean,
  count(s.shares)                            as shares_n,
  avg(s.shares)                              as shares_mean,
  count(s.saves)                             as saves_n,
  avg(s.saves)                               as saves_mean,
  count(s.link_clicks)                       as link_clicks_n,
  avg(s.link_clicks)                         as link_clicks_mean,
  count(s.website_sessions)                  as website_sessions_n,
  avg(s.website_sessions)                    as website_sessions_mean,
  count(s.leads)                             as leads_n,
  avg(s.leads)                               as leads_mean,
  count(s.qualified_leads)                   as qualified_leads_n,
  avg(s.qualified_leads)                     as qualified_leads_mean
from content_items c
join accounts a on a.id = c.account_id
left join content_latest_snapshot s on s.content_item_id = c.id
where c.is_externally_amplified = false
  and c.status in ('published', 'measured')
group by c.owner_id, a.platform, c.format;
