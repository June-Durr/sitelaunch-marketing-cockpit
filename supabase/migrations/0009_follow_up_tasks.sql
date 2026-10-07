-- SiteLaunch Marketing Cockpit, migration 0009
--
-- Makes the calculated follow-up dates into real, recurring tasks.
--
-- WHY A COLUMN AND NOT A CONVENTION
--
-- The rule needs to know which tasks it owns, so that re-running it updates its
-- own task instead of creating a second one, and so that it never edits a
-- measurement check or an admin task somebody made. The only safe way to know
-- that is to record it. Reading a title or a note to decide what a rule owns
-- means the rule changes its mind the moment somebody rewords their own task,
-- and then it either adopts a task it should not touch or abandons one it should.
--
-- WHY THE TASK RECURS RATHER THAN REPEATS
--
-- "Keep in touch with this person" has no end, so the task that represents it has
-- no end either. Finishing a follow-up reopens it on the next date rather than
-- leaving a finished task behind and starting another. The permanent record of
-- what actually happened is activity_events, which this never touches, and which
-- is why losing nothing matters: the task is the plan, the activity is the history.
--
-- WHY THE OLD INDEX IS REPLACED
--
-- 0007 had tasks_one_open_follow_up_per_lead, scoped to open tasks. That no
-- longer describes the invariant: the rule's task is singular whatever state it
-- is in, and scoping to open would let a second one be created the moment the
-- first was marked done. The new index is status-independent and scoped to the
-- rule's own tasks, so it holds right through the reopen cycle, and it also stops
-- blocking a follow-up task a person legitimately made by hand for the same lead.
--
-- NOTHING HERE DELETES ANYTHING.

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------

alter table tasks
  add column follow_up_rule_managed boolean not null default false;

comment on column tasks.follow_up_rule_managed is
  'True when the follow-up rule owns this task. A lead has at most one, it '
  'recurs, and reconciliation only ever edits tasks carrying this flag.';

drop index if exists tasks_one_open_follow_up_per_lead;

/**
 * One rule-managed follow-up per lead, in any state.
 *
 * Partial, because almost every task is not one of these. Status-independent, so
 * a task that is currently done is still the one the rule owns and still the one
 * it reopens.
 */
create unique index tasks_one_managed_follow_up_per_lead
  on tasks (owner_id, lead_id)
  where lead_id is not null and follow_up_rule_managed;

create index tasks_managed_follow_up_sync_idx
  on tasks (owner_id, calendar_sync_status)
  where follow_up_rule_managed and status = 'open';

-- ---------------------------------------------------------------------------
-- The reconciliation
--
-- The SQL twin of planFollowUpTasks in src/config/followUpTasks.ts. Both decide
-- the same four outcomes from the same inputs, and src/test/pg/followUpTasks.test.ts
-- runs them over the same fixtures and fails if they ever disagree.
--
-- WHY THIS EXISTS IN SQL AT ALL
--
-- It has to run server side, with no browser and no user session, so that the
-- plan can be reviewed against the hosted project before anything is written and
-- so a scheduled job can keep the task list honest. It is pure database work over
-- two tables: no external API, no credentials, nothing that belongs in an Edge
-- Function.
--
-- dry_run is the default. A caller that wants to write has to say so.
-- ---------------------------------------------------------------------------

/** What the notes say when there is nothing better. Mirrors NO_NEXT_ACTION_NOTE. */
create or replace function follow_up_no_next_action_note()
returns text
language sql
immutable
as $$
  select 'Kept by the follow-up rule. No next action has been recorded for this lead.'::text
$$;

create or replace function reconcile_follow_up_tasks(dry_run boolean default true)
returns table (
  action      text,
  lead_id     uuid,
  task_id     uuid,
  prospect    text,
  due_date    date,
  changed     text[],
  reason      text
)
language plpgsql
security invoker
as $$
declare
  r record;
begin
  /*
   * Eligible leads, each with the task the rule should be writing on.
   *
   * The task is the rule's own one if it has one, and otherwise an open
   * follow-up somebody made by hand for the same lead, which is adopted rather
   * than duplicated. Ordered by id so two runs over the same data produce the
   * same report in the same order.
   */
  for r in
    select
      l.id                                   as lead_id,
      l.prospect_name,
      l.next_action_date                     as due_date,
      'Follow up with ' || l.prospect_name   as want_title,
      coalesce(l.next_action, t.notes, follow_up_no_next_action_note()) as want_notes,
      t.id                                   as task_id,
      t.title                                as had_title,
      t.notes                                as had_notes,
      t.due_date                             as had_due,
      t.status                               as had_status,
      t.completed_at                         as had_completed_at,
      t.follow_up_rule_managed               as had_managed
    from leads l
    left join lateral (
      select tk.*
      from tasks tk
      where tk.lead_id = l.id
        and tk.owner_id = l.owner_id
        and tk.task_type = 'follow_up'
        and (tk.follow_up_rule_managed or tk.status = 'open')
      -- The rule's own task wins over an adoptable one.
      order by tk.follow_up_rule_managed desc, tk.created_at
      limit 1
    ) t on true
    where l.follow_up_mode = 'auto'
      and l.stage not in ('won', 'lost')
      and l.next_action_date is not null
    order by l.id
  loop
    if r.task_id is null then
      action   := 'create';
      lead_id  := r.lead_id;
      prospect := r.prospect_name;
      due_date := r.due_date;
      changed  := array[]::text[];
      reason   := 'Due ' || r.due_date || ', from this lead''s own follow-up date.';

      if not dry_run then
        insert into tasks (
          owner_id, lead_id, content_item_id, title, task_type, status, due_date,
          window_type, notes, completed_at, follow_up_rule_managed,
          external_calendar_id, external_event_id, calendar_sync_status,
          last_synced_at, sync_error, is_seed
        )
        select
          l.owner_id, r.lead_id, null, r.want_title, 'follow_up', 'open', r.due_date,
          null, r.want_notes, null, true,
          null, null, 'pending',
          null, null, false
        from leads l where l.id = r.lead_id
        returning id into task_id;
      else
        task_id := null;
      end if;

      return next;

    else
      changed := array[]::text[];
      if r.had_title is distinct from r.want_title then changed := array_append(changed, 'title'); end if;
      if r.had_notes is distinct from r.want_notes then changed := array_append(changed, 'notes'); end if;
      if r.had_due   is distinct from r.due_date   then changed := array_append(changed, 'due_date'); end if;
      if r.had_status is distinct from 'open'      then changed := array_append(changed, 'status'); end if;
      if r.had_completed_at is not null            then changed := array_append(changed, 'completed_at'); end if;
      if r.had_managed is distinct from true       then changed := array_append(changed, 'follow_up_rule_managed'); end if;

      lead_id  := r.lead_id;
      task_id  := r.task_id;
      prospect := r.prospect_name;
      due_date := r.due_date;

      if array_length(changed, 1) is null then
        action := 'unchanged';
        reason := 'Already says the right thing.';
      else
        action := 'update';
        reason := 'Moved to ' || r.due_date || ': ' || array_to_string(changed, ', ') || '.';

        if not dry_run then
          /*
           * Reopened and moved in place. calendar_sync_status goes back to
           * pending because the event the calendar is holding is now wrong, and
           * sync_error is cleared because whatever failed last time is no longer
           * what is being attempted.
           */
          update tasks
             set title                  = r.want_title,
                 notes                  = r.want_notes,
                 due_date               = r.due_date,
                 status                 = 'open',
                 completed_at           = null,
                 follow_up_rule_managed = true,
                 calendar_sync_status   = 'pending',
                 sync_error             = null
           where id = r.task_id;
        end if;
      end if;

      return next;
    end if;
  end loop;

  /*
   * Leads the rule has stopped chasing but whose task it left open.
   *
   * Marked skipped, never deleted: skipped is the status that means "decided not
   * to", which is exactly what putting a lead on hold or archiving them says. Only
   * the rule's own tasks, so a follow-up somebody made by hand for the same person
   * is left entirely alone.
   */
  for r in
    select t.id as task_id, t.lead_id, l.prospect_name, t.due_date
    from tasks t
    join leads l on l.id = t.lead_id and l.owner_id = t.owner_id
    where t.follow_up_rule_managed
      and t.status = 'open'
      and (
        l.follow_up_mode <> 'auto'
        or l.stage in ('won', 'lost')
        or l.next_action_date is null
      )
    order by t.id
  loop
    action   := 'close';
    lead_id  := r.lead_id;
    task_id  := r.task_id;
    prospect := r.prospect_name;
    due_date := r.due_date;
    changed  := array['status']::text[];
    reason   := 'This lead is no longer followed up, so the task the rule was '
             || 'keeping is marked skipped rather than deleted.';

    if not dry_run then
      update tasks set status = 'skipped' where id = r.task_id;
    end if;

    return next;
  end loop;
end;
$$;

comment on function reconcile_follow_up_tasks(boolean) is
  'Ensures every eligible lead has exactly one open rule-managed follow-up task. '
  'Dry run by default. Security invoker, so row level security decides which '
  'leads and tasks a caller can see and change. Never deletes anything.';

-- Security invoker, so it runs as whoever calls it and the existing row level
-- security on leads and tasks still applies. A definer function here would let
-- any caller reconcile every owner's pipeline.
revoke all on function reconcile_follow_up_tasks(boolean) from public;
revoke all on function reconcile_follow_up_tasks(boolean) from anon;
grant execute on function reconcile_follow_up_tasks(boolean) to authenticated;

revoke all on function follow_up_no_next_action_note() from public;
revoke all on function follow_up_no_next_action_note() from anon;
grant execute on function follow_up_no_next_action_note() to authenticated;
