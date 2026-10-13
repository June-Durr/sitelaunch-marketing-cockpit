-- ---------------------------------------------------------------------------
-- 0011_undo_and_recovery.sql
--
-- Finishing, skipping or deleting a task is now reversible, and a reversal is
-- recorded rather than hidden.
--
-- WHY THE PREVIOUS STATE LIVES ON THE TASK
--
-- An undo needs to know what the row looked like before. The obvious shape is a
-- separate operation log table, and that was the first design. It was dropped
-- because a new table here is not a small thing: TableName, IMPORT_ORDER, the
-- in-memory Dataset, both repository adapters, the backup table map and the
-- import report all enumerate the tables by name, and every one of them would
-- have had to learn about a table that holds no business data at all. The undo
-- payload belongs to exactly one task and dies with it, so it is stored on that
-- task.
--
-- The consequence, stated plainly: only the most recent operation on a task is
-- undoable. That is the right scope for an undo offered next to a confirmation,
-- and a second correction is a deliberate edit rather than an undo.
--
-- WHY A REVERSED COMPLETION IS MARKED, NOT DELETED
--
-- "This did not happen after all" is itself a fact worth keeping. Deleting the
-- activity row would make the correction invisible and would also free the
-- partial unique index below, so re-finishing the task would write a second
-- record with a new timestamp and the original completion time would be lost.
-- The row stays, carries the time it was reversed, and every count of completed
-- work excludes it.
--
--   activity_one_per_completed_task  (0003)
--     unique (owner_id, task_id) where source = 'task_completion'
--
-- Re-finishing a task whose completion was reversed therefore clears the
-- reversal on the existing row instead of inserting a new one. That is handled
-- in src/data/taskCompletion.ts, and this comment is here because the index is
-- what makes it necessary.
--
-- WHY DELETION IS RECOVERABLE RATHER THAN REAL
--
-- A real delete takes the task's lead_id, content_item_id and external calendar
-- ids with it, and no undo can put back a relationship the database has already
-- forgotten. Setting deleted_at keeps every column exactly as it was, so
-- restoring is one update and the external event id still points at the right
-- calendar entry.
--
-- Note that a soft deleted task still occupies tasks_one_managed_follow_up_per_lead
-- (0009). That is deliberate: the slot is held for the task that can still come
-- back, rather than being handed to a new one that would collide on restore.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------

alter table tasks add column if not exists deleted_at timestamptz;

-- The payload an undo needs: what the row looked like, what else the operation
-- touched, and the updated_at values seen at the time so a newer edit made
-- afterwards can be detected instead of silently overwritten.
alter table tasks add column if not exists last_operation jsonb;

-- Partial, because almost no task is in the bin at any one time.
create index if not exists tasks_deleted_idx
  on tasks (owner_id, deleted_at desc)
  where deleted_at is not null;

-- Finding the thing to offer an undo for, without scanning every task.
create index if not exists tasks_last_operation_idx
  on tasks (owner_id)
  where last_operation is not null;

-- A stored operation has to say which operation it was, or an undo cannot know
-- how to reverse it. Anything else in the object is the operation's own business.
alter table tasks drop constraint if exists tasks_last_operation_shape;
alter table tasks add constraint tasks_last_operation_shape check (
  last_operation is null
  or (
    jsonb_typeof(last_operation) = 'object'
    and last_operation ? 'operation'
    and last_operation ->> 'operation' in ('task_done', 'task_skip', 'task_delete')
  )
);

-- ---------------------------------------------------------------------------
-- activity_events
-- ---------------------------------------------------------------------------

alter table activity_events add column if not exists reversed_at timestamptz;
alter table activity_events add column if not exists reversal_note text;

create index if not exists activity_events_reversed_idx
  on activity_events (owner_id, reversed_at desc)
  where reversed_at is not null;

-- A note explaining a reversal that did not happen is a contradiction, and a
-- reversal with no reason is an audit record that does not say anything.
alter table activity_events drop constraint if exists activity_reversal_is_explained;
alter table activity_events add constraint activity_reversal_is_explained check (
  (reversed_at is null and reversal_note is null)
  or (reversed_at is not null and length(btrim(coalesce(reversal_note, ''))) > 0)
);
