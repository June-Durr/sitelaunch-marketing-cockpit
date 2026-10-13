-- ---------------------------------------------------------------------------
-- 0012_durable_completion.sql
--
-- Three things that have to be true at once for a completion to be trustworthy:
-- it writes once however many times the button is pressed, it survives the tab
-- being closed, and the history it leaves behind does not move when the next
-- follow-up is rescheduled.
--
-- WHY THE WRITE MOVED INTO ONE FUNCTION
--
-- Finishing a task used to be four separate statements from the browser: insert
-- the activity, move the lead, reopen or close the task, and mark the calendar
-- stale. Each one could succeed while the next failed, and a second click could
-- interleave with the first. The failure that produces is not an error message,
-- it is a lead whose follow-up date moved with no activity to explain why.
--
-- All four now happen inside complete_task_operation, in one transaction. Either
-- the whole completion is recorded or none of it is.
--
-- WHY THE RULE IS STILL NOT IN SQL
--
-- The cadence rule lives in src/config/followUp.ts and is argued about there. The
-- function below does not decide what the next date should be; it is told, and it
-- applies that decision atomically. Duplicating the rule here would mean two
-- implementations to keep in agreement, which is a cost 0009 already pays once
-- for reconcile_follow_up_tasks and does not need to pay twice.
--
-- WHY IDEMPOTENCY IS A TOKEN AND NOT A LOCK
--
-- A double click is two requests in flight at once, so "check then write" cannot
-- help: both checks pass before either write lands. The client sends a token it
-- generated for that one press, the token is a unique index, and the second
-- insert loses. The loser returns what the winner wrote rather than an error,
-- because from the person's point of view the click worked.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- What an activity now carries
-- ---------------------------------------------------------------------------

-- The exact wording that was approved and sent, when there was one. Kept apart
-- from `details`, which is a human summary: a summary that drifts from what was
-- actually sent is a different kind of record, and conflating them would make it
-- impossible to tell which you were looking at.
alter table activity_events add column if not exists approved_message text;

-- What the contact achieved, in the sender's own words. Null stays null: "no
-- outcome recorded" is not the same as "no outcome".
alter table activity_events add column if not exists outcome text;

-- The token that wrote this row, so a retry can find its own work.
alter table activity_events add column if not exists idempotency_token text;

-- One row per token. This is the whole duplicate-write defence: two presses of
-- the same button carry the same token, and the second insert cannot land.
create unique index if not exists activity_events_idempotency_token
  on activity_events (owner_id, idempotency_token)
  where idempotency_token is not null;

-- ---------------------------------------------------------------------------
-- The pending sync queue
--
-- A completion should bring the calendar and the sheet up to date without
-- anybody pressing Sync now. Firing that request from the browser is not good
-- enough: closing the tab loses it, and a failed request leaves a saved activity
-- that never reaches the calendar with nothing to retry it.
--
-- So the request is a row, written in the same transaction as the completion. If
-- the completion committed, the sync request committed with it. A worker drains
-- the queue, and the daily cron stays as the recovery path it always was.
-- ---------------------------------------------------------------------------

create table if not exists sync_jobs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,

  -- Which sync to run. Deliberately not free text.
  kind          text not null check (kind in ('calendar', 'lead_mirror')),

  -- What makes two requests the same request. For the calendar this is the
  -- owner, so a burst of completions collapses into one sync rather than one
  -- per task: the sync is a full export and running it five times does the same
  -- work as running it once.
  dedupe_key    text not null,

  payload       jsonb not null default '{}'::jsonb,

  attempts      integer not null default 0,
  max_attempts  integer not null default 8,

  -- When this becomes eligible. Pushed forward on each failure, so a provider
  -- that is down is not hammered.
  run_after     timestamptz not null default now(),

  -- Held by a worker. A row locked longer than the timeout is considered
  -- abandoned and is picked up again, because a worker that died mid-run must
  -- not strand the request forever.
  locked_at     timestamptz,

  completed_at  timestamptz,
  last_error    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint sync_job_attempts_are_sane check (attempts >= 0 and max_attempts > 0)
);

-- One outstanding job per owner per kind per key. A second completion while the
-- first sync is still pending does not queue a second sync; it leaves the one
-- that is already there, which will pick up both changes when it runs.
create unique index if not exists sync_jobs_one_pending
  on sync_jobs (owner_id, kind, dedupe_key)
  where completed_at is null;

-- What the worker asks for: the oldest eligible, unlocked, unfinished job.
create index if not exists sync_jobs_runnable
  on sync_jobs (run_after)
  where completed_at is null;

create trigger sync_jobs_set_updated_at
  before update on sync_jobs
  for each row execute function set_updated_at();

-- Owner scoped like everything else. The browser may see that its own sync is
-- pending, which is what "Saved; calendar syncing" is read from. It may not
-- write one: queueing work is something the completion function does.
alter table sync_jobs enable row level security;

drop policy if exists sync_jobs_owner_read on sync_jobs;
create policy sync_jobs_owner_read on sync_jobs
  for select using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Calendar identity for a completed contact
--
-- The future follow-up keeps its task-derived event id, which is what makes
-- rescheduling move the entry rather than add one. A completed contact is a
-- different thing: it happened on a particular day and must stay on that day
-- even though the next follow-up has moved to another one.
--
-- activity_events already carries external_event_id, external_calendar_id and
-- calendar_sync_status from 0003, so the column work is done. What this adds is
-- the flag saying this activity is one the Cockpit should put on a calendar at
-- all, because most of them are not.
-- ---------------------------------------------------------------------------

alter table activity_events add column if not exists calendar_history_wanted boolean not null default false;

create index if not exists activity_events_calendar_pending
  on activity_events (owner_id, calendar_sync_status)
  where calendar_history_wanted and calendar_sync_status <> 'synced';

-- ---------------------------------------------------------------------------
-- The one durable operation
-- ---------------------------------------------------------------------------

/**
 * Record a completion, move the follow-up, and queue the syncs. Once.
 *
 * Returns the activity id and what actually happened, so the caller can say
 * "Carlos contacted by text, next follow-up October 19" using the values that
 * were really written rather than the ones it hoped to write.
 *
 * Every p_next_* argument is the caller's already-decided plan. Passing nulls
 * means "the rule says nothing is scheduled", which is a real answer for a lead
 * on hold or archived, and is not the same as forgetting to pass them.
 */
create or replace function complete_task_operation(
  p_task_id           uuid,
  p_token             text,
  p_occurred_at       timestamptz default now(),
  p_channel           text default null,
  p_approved_message  text default null,
  p_outcome           text default null,
  p_activity_type     activity_type default 'follow_up_sent',
  p_title             text default null,
  p_next_due_date     date default null,
  p_next_title        text default null,
  p_next_notes        text default null,
  p_reopen_task       boolean default false,
  p_calendar_history  boolean default true
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_task      tasks%rowtype;
  v_owner     uuid;
  v_activity  activity_events%rowtype;
  v_existing  activity_events%rowtype;
  v_reused    boolean := false;
  v_lead_moved boolean := false;
begin
  -- security invoker, so row level security decides whose task this is. A task
  -- belonging to somebody else simply is not found.
  select * into v_task from tasks where id = p_task_id and deleted_at is null;
  if not found then
    raise exception 'task % is not available', p_task_id using errcode = 'no_data_found';
  end if;
  v_owner := v_task.owner_id;

  -- --------------------------------------------------------------- the token --
  -- A retry of the same press finds its own row and changes nothing.
  select * into v_existing from activity_events
   where owner_id = v_owner and idempotency_token = p_token;
  if found then
    return jsonb_build_object(
      'activity_id', v_existing.id,
      'reused', true,
      'reason', 'this completion was already recorded'
    );
  end if;

  -- 0003's partial unique index allows one task_completion activity per task.
  -- A task finished, reversed, and finished again reuses that row rather than
  -- colliding with the index.
  select * into v_existing from activity_events
   where owner_id = v_owner and task_id = p_task_id and source = 'task_completion';

  if found then
    update activity_events
       set reversed_at = null,
           reversal_note = null,
           idempotency_token = p_token,
           channel = coalesce(p_channel, channel),
           approved_message = coalesce(p_approved_message, approved_message),
           outcome = coalesce(p_outcome, outcome),
           calendar_history_wanted = p_calendar_history,
           calendar_sync_status = case
             when p_calendar_history then 'pending'::calendar_sync_status
             else calendar_sync_status end
     where id = v_existing.id
     returning * into v_activity;
    v_reused := true;
  else
    insert into activity_events (
      owner_id, occurred_at, activity_type, title, source, task_id, lead_id,
      content_item_id, channel, approved_message, outcome, idempotency_token,
      calendar_history_wanted, calendar_sync_status, is_seed
    ) values (
      v_owner, p_occurred_at, p_activity_type,
      coalesce(p_title, v_task.title), 'task_completion', p_task_id, v_task.lead_id,
      v_task.content_item_id, p_channel, p_approved_message, p_outcome, p_token,
      p_calendar_history,
      case when p_calendar_history then 'pending'::calendar_sync_status
           else 'not_synced'::calendar_sync_status end,
      false
    )
    returning * into v_activity;
  end if;

  -- ------------------------------------------------------------- the task ----
  -- What the row looked like before, so an undo can put it back, and the
  -- updated_at values seen now, so a newer edit can be detected rather than
  -- silently overwritten.
  update tasks
     set last_operation = jsonb_build_object(
           'operation', 'task_done',
           'at', now(),
           'activity_id', v_activity.id,
           'activity_reused', v_reused,
           'task_before', jsonb_build_object(
             'status', v_task.status,
             'due_date', v_task.due_date,
             'completed_at', v_task.completed_at,
             'title', v_task.title,
             'notes', v_task.notes,
             'calendar_sync_status', v_task.calendar_sync_status,
             'updated_at', v_task.updated_at
           ),
           'lead_before', (
             select jsonb_build_object(
               'next_action_date', l.next_action_date,
               'next_action', l.next_action,
               'updated_at', l.updated_at)
             from leads l where l.id = v_task.lead_id
           )
         ),
         status = case when p_reopen_task then 'open'::task_status else 'done'::task_status end,
         completed_at = case when p_reopen_task then null else p_occurred_at end,
         due_date = coalesce(p_next_due_date, due_date),
         title = coalesce(p_next_title, title),
         notes = coalesce(p_next_notes, notes),
         -- The entry it holds now says the wrong day, and whatever failed last
         -- time is not what is being attempted now.
         calendar_sync_status = 'pending',
         sync_error = null
   where id = p_task_id;

  -- ------------------------------------------------------------- the lead ----
  if v_task.lead_id is not null and p_next_due_date is not null then
    update leads
       set next_action_date = p_next_due_date,
           -- Only when there is nothing there. Somebody's own words beat a
           -- generated line.
           next_action = coalesce(next_action, p_next_title)
     where id = v_task.lead_id;
    v_lead_moved := true;
  end if;

  -- ------------------------------------------------------------ the syncs ----
  -- In the same transaction as everything above: if the completion committed,
  -- the request to sync it committed too.
  perform enqueue_sync_job(v_owner, 'calendar', v_owner::text);
  perform enqueue_sync_job(v_owner, 'lead_mirror', v_owner::text);

  return jsonb_build_object(
    'activity_id', v_activity.id,
    'reused', false,
    'activity_reused_row', v_reused,
    'task_reopened', p_reopen_task,
    'next_due_date', p_next_due_date,
    'lead_moved', v_lead_moved,
    'occurred_at', p_occurred_at
  );
end;
$$;

/**
 * Ask for a sync, without asking twice.
 *
 * A pending job for the same owner and kind is left exactly as it is. The sync
 * is a full export, so the job already queued will carry this change too, and
 * queueing a second would do the same work again for nothing.
 */
create or replace function enqueue_sync_job(
  p_owner uuid,
  p_kind  text,
  p_key   text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  insert into sync_jobs (owner_id, kind, dedupe_key)
  values (p_owner, p_kind, p_key)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from sync_jobs
     where owner_id = p_owner and kind = p_kind and dedupe_key = p_key
       and completed_at is null
     limit 1;
  end if;

  return v_id;
end;
$$;

revoke all on function enqueue_sync_job(uuid, text, text) from public;
revoke all on function enqueue_sync_job(uuid, text, text) from anon;
grant execute on function enqueue_sync_job(uuid, text, text) to authenticated, service_role;
grant execute on function complete_task_operation(
  uuid, text, timestamptz, text, text, text, activity_type, text, date, text, text, boolean, boolean
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Draining the queue
-- ---------------------------------------------------------------------------

/**
 * Claim up to p_limit runnable jobs, marking them locked in the same statement.
 *
 * for update skip locked is what makes two workers safe: each takes rows the
 * other has not, rather than both taking the same row and doing it twice.
 */
create or replace function claim_sync_jobs(p_limit integer default 10)
returns setof sync_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  update sync_jobs
     set locked_at = now(), attempts = attempts + 1
   where id in (
     select id from sync_jobs
      where completed_at is null
        and run_after <= now()
        -- A worker that died mid-run must not strand the request forever.
        and (locked_at is null or locked_at < now() - interval '5 minutes')
      order by run_after
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

/** Mark a claimed job finished, or push it back with a reason and a delay. */
create or replace function finish_sync_job(
  p_id    uuid,
  p_ok    boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ok then
    update sync_jobs
       set completed_at = now(), locked_at = null, last_error = null
     where id = p_id;
  else
    update sync_jobs
       set locked_at = null,
           last_error = left(coalesce(p_error, 'unknown'), 500),
           -- Backoff in minutes, doubling, so a provider that is down is not
           -- hammered. A job out of attempts is completed with its error kept:
           -- the daily cron is the recovery path from there.
           run_after = now() + (interval '1 minute' * power(2, least(attempts, 6))),
           completed_at = case when attempts >= max_attempts then now() else null end
     where id = p_id;
  end if;
end;
$$;

revoke all on function claim_sync_jobs(integer) from public, anon, authenticated;
revoke all on function finish_sync_job(uuid, boolean, text) from public, anon, authenticated;
grant execute on function claim_sync_jobs(integer) to service_role;
grant execute on function finish_sync_job(uuid, boolean, text) to service_role;

comment on table sync_jobs is
  'Durable requests to sync, written in the same transaction as the change that '
  'needs syncing. Readable by its owner so the UI can say "calendar syncing"; '
  'written only by the completion function and drained only by the service role.';
