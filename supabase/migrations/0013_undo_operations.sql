-- ---------------------------------------------------------------------------
-- 0013_undo_operations.sql
--
-- Reversing the last thing that happened to a task, and refusing to when
-- reversing it would throw away somebody's newer work.
--
-- WHY A CONFLICT IS AN ANSWER AND NOT AN ERROR
--
-- Undo restores the values a row had before. If the row has been edited since,
-- restoring them deletes that edit, and the person who made it is not the person
-- pressing Undo. So the stored payload carries the updated_at each row had at
-- the time, and a mismatch stops the undo and says which record moved on. That is
-- information, not a failure: the honest response is to tell somebody their undo
-- is out of date, not to quietly win.
--
-- WHY A REVERSED COMPLETION IS MARKED RATHER THAN DELETED
--
-- Set out at length in 0011. In short: "this did not happen after all" is itself
-- a fact worth keeping, and deleting the row would free the partial unique index
-- from 0003 so that re-finishing the task wrote a second record and lost the
-- original time.
--
-- WHAT UNDO WILL NOT TOUCH
--
-- A calendar event the Cockpit did not create. Undo corrects Cockpit-managed
-- entries by queueing a sync, and the sync's own rules decide what that means.
-- Nothing here reaches a calendar directly.
--
-- WHY THESE THREE ARE security definer AND complete_task_operation IS NOT
--
-- Found by running it rather than by reading the manual. Once the tasks policy
-- hides deleted rows, an owner can no longer set deleted_at on their own task:
-- the update is refused with "new row violates row-level security policy", even
-- though the WITH CHECK clause tests nothing but owner_id. Restoring is worse
-- still, because a binned row is not visible to select at all, so an invoker
-- function cannot even read the row it is being asked to bring back.
--
-- So the three functions that move a task into or out of the bin run as definer
-- and check ownership themselves, in the one line each where it matters. The
-- check is not a formality: with definer and no check, any signed in person
-- could pass any task id. complete_task_operation stays invoker precisely
-- because it never touches deleted_at, and leaving row level security to do the
-- scoping is a stronger guarantee than a line of SQL I have to remember to
-- write.
-- ---------------------------------------------------------------------------

/**
 * Reverse the last operation recorded against a task.
 *
 * Returns an object saying what it did, or what it refused to do and why. The
 * refusals are the interesting part: nothing to undo, somebody edited the record
 * since, or the stored operation is one this function does not know how to
 * reverse. All three are answers a screen can show a person.
 */
create or replace function undo_task_operation(p_task_id uuid)
returns jsonb
language plpgsql
-- definer, so it can see and restore a task the policy hides. See the note at
-- the top of this file; the ownership check below is what replaces the policy.
security definer
set search_path = public, pg_temp
as $$
declare
  v_task      tasks%rowtype;
  v_op        jsonb;
  v_kind      text;
  v_before    jsonb;
  v_lead      jsonb;
  v_lead_row  leads%rowtype;
  v_activity  activity_events%rowtype;
  v_conflicts text[] := array[]::text[];
begin
  -- The ownership check this function exists to make for itself. A task that
  -- belongs to somebody else answers exactly as one that does not exist,
  -- because the difference is not this caller's business.
  select * into v_task from tasks where id = p_task_id and owner_id = auth.uid();
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_op := v_task.last_operation;
  if v_op is null then
    return jsonb_build_object('status', 'nothing_to_undo');
  end if;

  v_kind := v_op ->> 'operation';
  v_before := v_op -> 'task_before';
  v_lead := v_op -> 'lead_before';

  -- ------------------------------------------------------------- conflicts --
  -- The row is compared against the timestamp it carried when the operation
  -- ran. A later edit means undoing would discard it.
  if v_before ? 'updated_at'
     and v_task.updated_at is distinct from (v_before ->> 'updated_at')::timestamptz
     -- The operation itself bumped updated_at, so the comparison is against the
     -- value recorded before it, and one later write is the operation's own.
     and v_task.updated_at > (v_op ->> 'at')::timestamptz
  then
    v_conflicts := array_append(v_conflicts, 'the task was edited after this action');
  end if;

  if v_task.lead_id is not null and v_lead is not null and v_lead ? 'updated_at' then
    select * into v_lead_row from leads where id = v_task.lead_id;
    if found
       and v_lead_row.updated_at is distinct from (v_lead ->> 'updated_at')::timestamptz
       and v_lead_row.updated_at > (v_op ->> 'at')::timestamptz
    then
      v_conflicts := array_append(v_conflicts, 'the lead was edited after this action');
    end if;
  end if;

  if array_length(v_conflicts, 1) > 0 then
    return jsonb_build_object(
      'status', 'conflict',
      'operation', v_kind,
      'reasons', to_jsonb(v_conflicts)
    );
  end if;

  -- ---------------------------------------------------------------- reverse --
  if v_kind = 'task_done' then
    update tasks
       set status = (v_before ->> 'status')::task_status,
           due_date = (v_before ->> 'due_date')::date,
           completed_at = nullif(v_before ->> 'completed_at', '')::timestamptz,
           title = coalesce(v_before ->> 'title', title),
           notes = v_before ->> 'notes',
           -- The entry on the calendar now says the date this undo has just
           -- taken back, so it needs writing again.
           calendar_sync_status = 'pending',
           sync_error = null,
           last_operation = null
     where id = p_task_id;

    if v_task.lead_id is not null and v_lead is not null then
      update leads
         set next_action_date = nullif(v_lead ->> 'next_action_date', '')::date,
             next_action = v_lead ->> 'next_action'
       where id = v_task.lead_id;
    end if;

    -- The activity stays, carrying the time it was reversed. Every count of
    -- completed work excludes a reversed row.
    if v_op ? 'activity_id' then
      update activity_events
         set reversed_at = now(),
             reversal_note = 'Undone from the Cockpit: the completion was reversed by the person who recorded it.',
             calendar_history_wanted = false,
             calendar_sync_status = case
               when external_event_id is not null then 'pending'::calendar_sync_status
               else calendar_sync_status end
       where id = (v_op ->> 'activity_id')::uuid
       returning * into v_activity;
    end if;

  elsif v_kind = 'task_skip' then
    update tasks
       set status = (v_before ->> 'status')::task_status,
           completed_at = nullif(v_before ->> 'completed_at', '')::timestamptz,
           last_operation = null
     where id = p_task_id;

  elsif v_kind = 'task_delete' then
    update tasks
       set deleted_at = null,
           -- Every other column was left exactly as it was, which is the whole
           -- reason deletion is recoverable rather than real: the lead_id and
           -- the external event id still point where they did.
           last_operation = null
     where id = p_task_id;

  else
    return jsonb_build_object('status', 'unknown_operation', 'operation', v_kind);
  end if;

  -- The calendar and the sheet now disagree with the database, so ask for both.
  perform enqueue_sync_job(v_task.owner_id, 'calendar', v_task.owner_id::text);
  perform enqueue_sync_job(v_task.owner_id, 'lead_mirror', v_task.owner_id::text);

  return jsonb_build_object(
    'status', 'undone',
    'operation', v_kind,
    'activity_reversed', v_activity.id
  );
end;
$$;

/**
 * Put a task in the bin, recoverably, remembering what it looked like.
 *
 * Nothing is removed. A real delete takes the lead_id and the external event id
 * with it, and no undo can restore a relationship the database has forgotten.
 */
create or replace function soft_delete_task(p_task_id uuid)
returns jsonb
language plpgsql
-- definer: setting deleted_at is refused by the policy that hides deleted rows.
security definer
set search_path = public, pg_temp
as $$
declare v_task tasks%rowtype;
begin
  select * into v_task
    from tasks
   where id = p_task_id and owner_id = auth.uid() and deleted_at is null;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  update tasks
     set deleted_at = now(),
         last_operation = jsonb_build_object(
           'operation', 'task_delete',
           'at', now(),
           'task_before', jsonb_build_object(
             'status', v_task.status,
             'due_date', v_task.due_date,
             'completed_at', v_task.completed_at,
             'title', v_task.title,
             'notes', v_task.notes,
             'updated_at', v_task.updated_at
           )
         )
   where id = p_task_id;

  perform enqueue_sync_job(v_task.owner_id, 'calendar', v_task.owner_id::text);

  return jsonb_build_object('status', 'deleted', 'task_id', p_task_id);
end;
$$;

/** Record a skip reversibly. Nothing happened, so nothing is logged. */
create or replace function skip_task_operation(p_task_id uuid)
returns jsonb
language plpgsql
-- definer for the same reason as its neighbours, so all three paths that write
-- last_operation behave identically rather than one of them being special.
security definer
set search_path = public, pg_temp
as $$
declare v_task tasks%rowtype;
begin
  select * into v_task
    from tasks
   where id = p_task_id and owner_id = auth.uid() and deleted_at is null;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  update tasks
     set status = 'skipped',
         completed_at = now(),
         last_operation = jsonb_build_object(
           'operation', 'task_skip',
           'at', now(),
           'task_before', jsonb_build_object(
             'status', v_task.status,
             'completed_at', v_task.completed_at,
             'updated_at', v_task.updated_at
           )
         )
   where id = p_task_id;

  return jsonb_build_object('status', 'skipped', 'task_id', p_task_id);
end;
$$;

grant execute on function undo_task_operation(uuid) to authenticated, service_role;
grant execute on function soft_delete_task(uuid)    to authenticated, service_role;
grant execute on function skip_task_operation(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Keeping deleted tasks out of everything that reads tasks
--
-- Every existing query says `from tasks`, and none of them knows about
-- deleted_at. Rather than edit each one and rely on nobody forgetting, the RLS
-- policy itself hides binned rows from normal reads, and a separate view exposes
-- the bin to the one screen that wants it.
-- ---------------------------------------------------------------------------

drop policy if exists tasks_owner_all on tasks;
create policy tasks_owner_all on tasks
  -- `to authenticated` matches what 0001 created. Dropping it would widen the
  -- policy to every role, which is the opposite of the intent here.
  for all to authenticated
  using (owner_id = auth.uid() and deleted_at is null)
  with check (owner_id = auth.uid());

/**
 * The bin.
 *
 * security_invoker, so it is the reader's own row level security that applies,
 * which is what keeps one person's deleted tasks out of another's list. The
 * policy above hides deleted rows, so this view reads them through a function
 * that is allowed to.
 */
create or replace function recently_deleted_tasks()
returns setof tasks
language sql
security definer
set search_path = public, pg_temp
as $$
  select * from tasks
   where owner_id = auth.uid()
     and deleted_at is not null
     and deleted_at > now() - interval '30 days'
   order by deleted_at desc
   limit 50;
$$;

grant execute on function recently_deleted_tasks() to authenticated, service_role;

comment on function undo_task_operation(uuid) is
  'Reverses the last operation on a task, or refuses with a reason. Never '
  'overwrites an edit made after the operation it is reversing.';
