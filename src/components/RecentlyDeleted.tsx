/**
 * The bin, and the way back out of it.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CONFIRMATION
 *
 * The toast offers Undo for about five seconds. That is the right length for a
 * confirmation and the wrong length for recovery: somebody who deletes the wrong
 * task, looks away, and realises a minute later has no way back from a message
 * that has already gone. This is that way back, and it does not expire for
 * thirty days.
 *
 * Nothing in here was ever really deleted. Restoring is one update, and the
 * task comes back with its lead, its notes and its calendar event id exactly as
 * they were, because a real delete would have taken all three with it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useData } from '../data/context';
import { useTaskActions } from '../data/taskActions';
import { Details } from './DataGroups';
import { formatDateTime } from '../lib/dates';
import type { Task } from '../types/domain';

export function RecentlyDeleted() {
  const { loadRecentlyDeleted } = useData();
  const { restore, busyId } = useTaskActions();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!loadRecentlyDeleted) return;
    try {
      setTasks(await loadRecentlyDeleted());
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  }, [loadRecentlyDeleted]);

  useEffect(() => {
    // Reading stored state is exactly the external synchronisation an effect is
    // for, and the state writes happen after the await.
    // oxlint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  // Browser-only mode deletes for real, so there is no bin to show and saying
  // there is one would be a promise the adapter cannot keep.
  if (!loadRecentlyDeleted) return null;

  const count = tasks?.length ?? 0;

  return (
    <Details summary={count === 0 ? 'Recently deleted' : `Recently deleted (${count})`}>
      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      {count === 0 ? (
        <p>
          Nothing has been deleted in the last thirty days. Anything deleted from
          here is kept that long, with every link and calendar entry intact, so
          bringing it back is one press rather than a rebuild.
        </p>
      ) : (
        <ul className="bin-list">
          {(tasks ?? []).map((task) => (
            <li key={task.id} className="bin-row">
              <div className="bin-row-body">
                <span className="bin-row-title">{task.title}</span>
                <span className="bin-row-meta">
                  Deleted {task.deleted_at ? formatDateTime(task.deleted_at) : 'recently'}
                  {task.due_date ? ` · was due ${task.due_date}` : ''}
                </span>
              </div>
              <button
                className="btn btn-quiet"
                disabled={busyId !== null}
                onClick={async () => {
                  await restore(task);
                  await load();
                }}
              >
                {busyId === task.id ? 'Restoring…' : 'Restore'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Details>
  );
}
