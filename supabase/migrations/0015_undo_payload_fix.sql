-- ---------------------------------------------------------------------------
-- 0015_undo_payload_fix.sql
--
-- A second completion of the same task was overwriting the thing Undo needs.
--
-- WHAT WENT WRONG
--
-- complete_task_operation returns early when it sees its own token, so a retry
-- of one click is harmless. A *different* token for a task that is already
-- completed is not a retry: it runs the whole body again. The activity is
-- correctly reused, because 0003's partial index allows only one completion
-- row per task, but the task update ran a second time and rewrote
-- last_operation with the row as it stood *after* the first completion.
--
-- So Undo restored the state the task had between the two calls rather than
-- the state it had before either. Found by the end to end run against the
-- hosted database on 2026-10-13: complete, complete again with a new token,
-- undo, and the due date came back as the already-moved one.
--
-- THE RULE
--
-- An undo payload describes the last thing that genuinely changed the task. A
-- completion that finds a usable payload already there leaves it alone. Undo
-- clears the payload when it runs, so the next real completion writes a fresh
-- one and a second undo is still possible; what cannot happen any more is a
-- repeat call quietly replacing "before" with "after".
-- ---------------------------------------------------------------------------

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
  select * into v_task from tasks where id = p_task_id and deleted_at is null;
  if not found then
    raise exception 'task % is not available', p_task_id using errcode = 'no_data_found';
  end if;
  v_owner := v_task.owner_id;

  select * into v_existing from activity_events
   where owner_id = v_owner and idempotency_token = p_token;
  if found then
    return jsonb_build_object(
      'activity_id', v_existing.id,
      'reused', true,
      'reason', 'this completion was already recorded'
    );
  end if;

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

  update tasks
     set last_operation = case
           -- The one change from 0012. A usable payload is already here, which
           -- means this task was completed and not undone since, so this call
           -- is a repeat rather than a change. Overwriting would replace
           -- "before" with "after" and send Undo to the wrong date.
           when last_operation is not null
                and last_operation ->> 'operation' = 'task_done'
             -- task_before is kept, because that is the state to restore.
             -- Only 'at' moves, because the conflict check compares the row's
             -- updated_at against it, and this call has just bumped updated_at
             -- itself. Without this a duplicate click would look like somebody
             -- else edit and block the undo entirely. A genuine later edit
             -- still lands after this timestamp and is still caught.
             then jsonb_set(last_operation, '{at}', to_jsonb(now()))
           else jsonb_build_object(
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
           )
         end,
         status = case when p_reopen_task then 'open'::task_status else 'done'::task_status end,
         completed_at = case when p_reopen_task then null else p_occurred_at end,
         due_date = coalesce(p_next_due_date, due_date),
         title = coalesce(p_next_title, title),
         notes = coalesce(p_next_notes, notes),
         calendar_sync_status = 'pending',
         sync_error = null
   where id = p_task_id;

  if v_task.lead_id is not null and p_next_due_date is not null then
    update leads
       set next_action_date = p_next_due_date,
           next_action = coalesce(next_action, p_next_title)
     where id = v_task.lead_id;
    v_lead_moved := true;
  end if;

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

grant execute on function complete_task_operation(
  uuid, text, timestamptz, text, text, text, activity_type, text, date, text, text, boolean, boolean
) to authenticated, service_role;
