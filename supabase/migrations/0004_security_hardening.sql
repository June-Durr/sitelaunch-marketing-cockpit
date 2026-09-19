-- SiteLaunch Marketing Cockpit, migration 0004
--
-- Two security problems in the original schema, both fixed here.
--
-- PROBLEM 1: VIEWS BYPASSED ROW LEVEL SECURITY
--
-- In Postgres a view runs with the permissions of the role that owns it, not the
-- role querying it. Both views in 0001 read tables that have RLS enabled, so any
-- authenticated user selecting from cohort_stats would have seen every owner's
-- rows aggregated together. RLS on the underlying tables did not save us, because
-- the view owner is the one doing the reading.
--
-- security_invoker = true makes the view run as the caller instead, so the
-- caller's RLS policies apply. Requires Postgres 15 or newer, which Supabase is.
--
-- PROBLEM 2: A ROW COULD POINT AT ANOTHER OWNER'S ROW
--
-- The RLS policies check that owner_id = auth.uid() on the row being written.
-- They said nothing about what that row pointed at. A user could therefore insert
-- their own content_item with an account_id belonging to somebody else, and read
-- back that other owner's platform through the join.
--
-- The fix is structural rather than another policy: give every parent a unique
-- key on (id, owner_id), then make every child reference that composite key. A
-- cross-owner link then fails a foreign key check inside the database, whatever
-- the application layer does or forgets to do.

-- ---------------------------------------------------------------------------
-- Problem 1: views run as the caller
-- ---------------------------------------------------------------------------

alter view content_latest_snapshot set (security_invoker = true);
alter view cohort_stats            set (security_invoker = true);

-- Neither view needs to be reachable by anonymous visitors.
revoke all on content_latest_snapshot from anon;
revoke all on cohort_stats            from anon;

grant select on content_latest_snapshot to authenticated;
grant select on cohort_stats            to authenticated;

-- ---------------------------------------------------------------------------
-- Problem 2: composite keys that make cross-owner links impossible
-- ---------------------------------------------------------------------------

alter table accounts       add constraint accounts_id_owner_key       unique (id, owner_id);
alter table content_items  add constraint content_items_id_owner_key  unique (id, owner_id);
alter table leads          add constraint leads_id_owner_key          unique (id, owner_id);
alter table tasks          add constraint tasks_id_owner_key          unique (id, owner_id);

-- content_items -> accounts
alter table content_items drop constraint content_items_account_id_fkey;
alter table content_items
  add constraint content_items_account_same_owner
  foreign key (account_id, owner_id)
  references accounts (id, owner_id)
  on delete set null;

-- performance_snapshots -> content_items
alter table performance_snapshots drop constraint performance_snapshots_content_item_id_fkey;
alter table performance_snapshots
  add constraint performance_snapshots_content_same_owner
  foreign key (content_item_id, owner_id)
  references content_items (id, owner_id)
  on delete cascade;

-- traffic_snapshots -> content_items
alter table traffic_snapshots drop constraint traffic_snapshots_content_item_id_fkey;
alter table traffic_snapshots
  add constraint traffic_snapshots_content_same_owner
  foreign key (content_item_id, owner_id)
  references content_items (id, owner_id)
  on delete set null;

-- leads -> content_items
alter table leads drop constraint leads_content_item_id_fkey;
alter table leads
  add constraint leads_content_same_owner
  foreign key (content_item_id, owner_id)
  references content_items (id, owner_id)
  on delete set null;

-- tasks -> content_items, leads
alter table tasks drop constraint tasks_content_item_id_fkey;
alter table tasks
  add constraint tasks_content_same_owner
  foreign key (content_item_id, owner_id)
  references content_items (id, owner_id)
  on delete cascade;

alter table tasks drop constraint tasks_lead_id_fkey;
alter table tasks
  add constraint tasks_lead_same_owner
  foreign key (lead_id, owner_id)
  references leads (id, owner_id)
  on delete cascade;

-- activity_events -> content_items, leads, tasks
alter table activity_events drop constraint activity_events_content_item_id_fkey;
alter table activity_events
  add constraint activity_events_content_same_owner
  foreign key (content_item_id, owner_id)
  references content_items (id, owner_id)
  on delete set null;

alter table activity_events drop constraint activity_events_lead_id_fkey;
alter table activity_events
  add constraint activity_events_lead_same_owner
  foreign key (lead_id, owner_id)
  references leads (id, owner_id)
  on delete set null;

alter table activity_events drop constraint activity_events_task_id_fkey;
alter table activity_events
  add constraint activity_events_task_same_owner
  foreign key (task_id, owner_id)
  references tasks (id, owner_id)
  on delete set null;

-- ---------------------------------------------------------------------------
-- owner_id must not be reassigned after the fact
--
-- Without this, a user could insert a row as themselves and then update owner_id
-- to somebody else, handing over a row that still points at their own parents.
-- The RLS policy's WITH CHECK would allow the insert and the USING clause would
-- allow the update, because both are evaluated against a row the user does own.
-- ---------------------------------------------------------------------------

create or replace function refuse_owner_change() returns trigger
language plpgsql
as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id cannot be changed once a row exists';
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'accounts', 'content_items', 'performance_snapshots', 'traffic_snapshots',
    'leads', 'tasks', 'recommendations', 'activity_events'
  ]
  loop
    execute format(
      'create trigger %I_refuse_owner_change before update on %I
       for each row execute function refuse_owner_change()', t, t);
  end loop;
end;
$$;
