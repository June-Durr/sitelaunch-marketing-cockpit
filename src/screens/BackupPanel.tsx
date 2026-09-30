import { useState } from 'react';
import { useData } from '../data/context';
import { Notice, Section, Tag } from '../components/primitives';
import { readSettings, writeSettings } from '../data/settings';
import {
  BACKUP_SCHEMA_VERSION, TABLE_NAMES, backupFilename, buildBackup,
  datasetCounts, parseAndValidate, serializeBackup, totalRows,
  type ValidationResult,
} from '../lib/backup';
import { formatDateTime } from '../lib/dates';
import type { TableName } from '../data/repository';

type Stage =
  | { kind: 'idle' }
  | { kind: 'reviewing'; filename: string; result: ValidationResult }
  | { kind: 'applying' }
  | { kind: 'done'; message: string };

const TABLE_LABELS: Record<TableName, string> = {
  accounts: 'Accounts',
  content_items: 'Content items',
  performance_snapshots: 'Performance snapshots',
  traffic_snapshots: 'Website outcomes',
  leads: 'Leads',
  tasks: 'Tasks',
  recommendations: 'Recommendations',
  activity_events: 'Activity',
};

/**
 * Export and restore for browser-local mode.
 *
 * The import is deliberately two-step. A file is read and fully validated first,
 * and only then does a button appear that can overwrite anything. Nothing the
 * importer does before that button can alter the current dataset.
 */
export function BackupPanel() {
  const { data, mode, replaceAll, importDataset } = useData();
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [lastExport, setLastExport] = useState<string | null>(null);

  const currentCounts = datasetCounts(data);
  const currentTotal = totalRows(currentCounts);
  const incomingCounts =
    stage.kind === 'reviewing' && stage.result.ok
      ? datasetCounts(stage.result.data)
      : currentCounts;

  function exportBackup() {
    const backup = buildBackup(data, readSettings(), mode);
    const blob = new Blob([serializeBackup(backup)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const name = backupFilename();

    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    setLastExport(
      `${name}, holding ${totalRows(backup.counts)} records (format version ${backup.schema_version})`,
    );
  }

  async function reviewFile(file: File) {
    const text = await file.text();
    // Reading and validating changes nothing. The dataset is still untouched here.
    setStage({ kind: 'reviewing', filename: file.name, result: parseAndValidate(text) });
  }

  async function importStaged() {
    if (stage.kind !== 'reviewing' || !stage.result.ok || !importDataset) return;
    const { data: restored, settings, backup } = stage.result;
    setStage({ kind: 'applying' });
    try {
      const report = await importDataset(restored);

      if (report.blockedBy.length > 0) {
        const held = report.blockedBy
          .map((b) => `${TABLE_LABELS[b.table]} (${b.existing})`)
          .join(', ');
        setStage({
          kind: 'done',
          message: `Nothing was imported. Your account already holds records in ${held}. The importer only writes into an empty account, so that existing data cannot be overwritten or duplicated.`,
        });
        return;
      }

      if (report.failure) {
        const undone = report.rolledBack?.ok
          ? 'Every row this import had already written was removed again, so your account is back to empty.'
          : `The rows already written could not all be removed: ${report.rolledBack?.message ?? 'unknown problem'}.`;
        setStage({
          kind: 'done',
          message: `Import stopped at ${TABLE_LABELS[report.failure.table]}: ${report.failure.message}. ${undone}`,
        });
        return;
      }

      writeSettings(settings);
      const total = Object.values(report.inserted).reduce((a, b) => a + b, 0);
      const remapped =
        report.remappedIds > 0
          ? ` ${report.remappedIds} ids were rewritten as uuids, which the database requires; every link between records was rewritten to match, so nothing came unlinked.`
          : '';
      setStage({
        kind: 'done',
        message: `Imported ${total} records from ${backup.exported_at.slice(0, 10)} into your Supabase account. Nothing was deleted, and the copy in this browser is untouched.${remapped}`,
      });
    } catch (err) {
      setStage({
        kind: 'done',
        message: `Import failed: ${err instanceof Error ? err.message : String(err)}.`,
      });
    }
  }

  async function applyStaged() {
    if (stage.kind !== 'reviewing' || !stage.result.ok || !replaceAll) return;
    const { data: restored, settings, backup } = stage.result;
    setStage({ kind: 'applying' });
    try {
      await replaceAll(restored);
      writeSettings(settings);
      setStage({
        kind: 'done',
        message: `Restored ${totalRows(backup.counts)} records from ${backup.exported_at.slice(0, 10)}. The previous contents of this browser have been replaced.`,
      });
    } catch (err) {
      setStage({
        kind: 'done',
        message: `Restore failed: ${err instanceof Error ? err.message : String(err)}. Your existing data was not changed.`,
      });
    }
  }

  return (
    <Section
      title="Backup and restore"
      note={`Schema ${BACKUP_SCHEMA_VERSION}`}
    >
      <p className="page-lede" style={{ marginTop: 0 }}>
        {mode === 'local'
          ? 'This browser holds the only copy of your data. Export a backup file before you clear site data, switch machines, or try anything you might regret.'
          : 'Data is stored in Supabase. Export takes a point-in-time snapshot. A backup can also be imported, which is how you move data off a browser, but only into an account that holds no records yet, so an import can never overwrite what is already there.'}
      </p>

      <div className="btn-row">
        <button className="btn btn-primary" onClick={exportBackup}>
          Export backup ({currentTotal} records)
        </button>
        <label className="btn" style={{ cursor: 'pointer' }}>
          Choose a backup to restore…
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void reviewFile(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {lastExport ? (
        <p className="notice notice-violet">Downloaded {lastExport}</p>
      ) : null}

      {stage.kind === 'reviewing' && !stage.result.ok ? (
        <div className="restore-review restore-review-rejected">
          <div className="next-step-kicker" style={{ color: 'var(--crimson)' }}>
            File rejected, and nothing was changed
          </div>
          <p style={{ margin: '0 0 0.75rem' }}>
            <strong>{stage.filename}</strong> was not imported. Your current data is
            exactly as it was.
          </p>
          <ul className="problem-list">
            {stage.result.errors.slice(0, 12).map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
          {stage.result.errors.length > 12 ? (
            <p className="field-hint">
              …and {stage.result.errors.length - 12} more problems.
            </p>
          ) : null}
          <div className="btn-row" style={{ marginTop: '1rem' }}>
            <button className="btn" onClick={() => setStage({ kind: 'idle' })}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {stage.kind === 'reviewing' && stage.result.ok ? (
        <div className="restore-review">
          <div className="next-step-kicker">
            {mode === 'supabase' ? 'Review before importing' : 'Review before replacing'}
          </div>
          <p style={{ margin: '0 0 1rem' }}>
            <strong>{stage.filename}</strong> is a valid backup, exported{' '}
            {formatDateTime(stage.result.backup.exported_at)}.
          </p>

          <table className="data">
            <thead>
              <tr>
                <th>Table</th>
                <th className="num">{mode === 'supabase' ? 'In your account now' : 'In this browser now'}</th>
                <th className="num">In the backup</th>
              </tr>
            </thead>
            <tbody>
              {TABLE_NAMES.map((table) => {
                const now = currentCounts[table];
                const next = incomingCounts[table];
                return (
                  <tr key={table}>
                    <td data-label="Table">{TABLE_LABELS[table]}</td>
                    <td className="num" data-label="Now">
                      {now}
                    </td>
                    <td className="num" data-label="In backup">
                      {next}
                      {next !== now ? (
                        <>
                          {' '}
                          <Tag tone={next < now ? 'crimson' : 'quiet'}>
                            {next > now ? `+${next - now}` : `${next - now}`}
                          </Tag>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {stage.result.warnings.length > 0 ? (
            <>
              <p className="field-hint" style={{ margin: '1.25rem 0 0.4rem' }}>
                Worth knowing, but you can still go ahead:
              </p>
              <ul className="problem-list problem-list-warning">
                {stage.result.warnings.slice(0, 8).map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
              {stage.result.warnings.length > 8 ? (
                <p className="field-hint">
                  …and {stage.result.warnings.length - 8} more.
                </p>
              ) : null}
            </>
          ) : null}

          {mode === 'supabase' ? (
            currentTotal > 0 ? (
              <Notice tone="crimson">
                Your account already holds {currentTotal} records, so this import will
                refuse to run. It only writes into an empty account, which is what stops
                it ever overwriting or duplicating what you already have.
              </Notice>
            ) : (
              <Notice>
                Your account holds no records yet. This adds {totalRows(incomingCounts)}{' '}
                records and deletes nothing. The copy in this browser stays exactly as it
                is, so you can run this again if anything looks wrong.
              </Notice>
            )
          ) : currentTotal > 0 ? (
            <Notice tone="crimson">
              This will replace all {currentTotal} records currently in this browser. You
              cannot get them back afterwards unless you exported them first.
            </Notice>
          ) : (
            <Notice>This browser holds no records, so nothing will be lost.</Notice>
          )}

          <div className="btn-row" style={{ marginTop: '1.1rem' }}>
            <button className="btn" onClick={() => setStage({ kind: 'idle' })}>
              Cancel
            </button>
            {replaceAll ? (
              <button className="btn btn-danger-solid" onClick={applyStaged}>
                Replace all data with this backup
              </button>
            ) : importDataset ? (
              <button
                className="btn btn-primary"
                disabled={currentTotal > 0}
                onClick={importStaged}
              >
                Import this backup into Supabase
              </button>
            ) : (
              <span className="field-hint">
                Restore is available in browser-local mode only.
              </span>
            )}
          </div>
        </div>
      ) : null}

      {stage.kind === 'applying' ? <p className="notice">Restoring…</p> : null}

      {stage.kind === 'done' ? (
        <div className="restore-review">
          <p style={{ margin: 0 }}>{stage.message}</p>
          <div className="btn-row" style={{ marginTop: '1rem' }}>
            <button className="btn" onClick={() => setStage({ kind: 'idle' })}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
