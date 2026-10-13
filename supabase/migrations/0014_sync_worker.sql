-- ---------------------------------------------------------------------------
-- 0014_sync_worker.sql
--
-- What the worker needs that 0012 did not provide: a way to claim jobs for one
-- owner only.
--
-- WHY A SECOND CLAIM FUNCTION
--
-- claim_sync_jobs takes whatever is runnable, which is right for the scheduled
-- sweep and wrong for the other caller. After somebody saves a completion the
-- browser asks the worker to run now, and that request must drain that person's
-- queue and nobody else's. Handing the unscoped function a session would let one
-- person's click do another person's outbound work, which is both a privacy
-- problem and an unfair way to spend somebody else's rate limit.
--
-- The two are deliberately separate rather than one function with an optional
-- argument, because a null owner silently meaning "everyone" is exactly the
-- kind of default that becomes a leak.
-- ---------------------------------------------------------------------------

/**
 * Claim up to p_limit runnable jobs belonging to one owner.
 *
 * for update skip locked keeps two workers from taking the same row: each takes
 * what the other has not, rather than both doing it twice.
 */
create or replace function claim_sync_jobs_for_owner(
  p_owner uuid,
  p_limit integer default 5
)
returns setof sync_jobs
language sql
security definer
set search_path = public, pg_temp
as $$
  update sync_jobs
     set locked_at = now(), attempts = attempts + 1
   where id in (
     select id from sync_jobs
      where owner_id = p_owner
        and completed_at is null
        and run_after <= now()
        -- A worker that died mid-run must not strand the request forever.
        and (locked_at is null or locked_at < now() - interval '5 minutes')
      order by run_after
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

revoke all on function claim_sync_jobs_for_owner(uuid, integer) from public, anon, authenticated;
grant execute on function claim_sync_jobs_for_owner(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Finding the history entries a calendar sync still owes
--
-- The browser reads this through its own row level security; the worker reads it
-- as the service role. Either way it answers the same question: which completed
-- contacts have been asked for on the calendar and have not got there yet.
-- ---------------------------------------------------------------------------

create index if not exists activity_events_history_due
  on activity_events (owner_id, occurred_at)
  where calendar_history_wanted and calendar_sync_status in ('pending', 'error');

-- A reversed completion still needs a visit, to correct what is already on the
-- calendar. It is found by the external id it was given rather than by the flag,
-- which by then says false.
create index if not exists activity_events_history_reversed
  on activity_events (owner_id)
  where reversed_at is not null and external_event_id is not null;

comment on function claim_sync_jobs_for_owner(uuid, integer) is
  'Claims runnable sync jobs for one owner. Used when a signed in person asks '
  'for their own queue to be drained immediately after saving something.';
