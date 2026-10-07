/**
 * Backup and restore tests.
 *
 * The contract under test: a rejected file changes nothing, and an accepted file
 * comes back byte-for-byte equal, including every null. A backup that quietly
 * turns "not recorded" into 0 would be worse than no backup at all.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalRepository } from '../data/localRepository';
import { buildSeedDataset } from '../data/seed';
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../data/settings';
import { emptyDataset } from '../data/repository';
import type { Dataset } from '../types/domain';
import {
  BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, buildBackup, parseAndValidate,
  serializeBackup, validateBackup,
} from './backup';
import { newActivity, newLead, newTask } from '../test/fixtures';

/** A structurally valid backup object, ready to be broken in specific ways. */
function validBackupObject(): Record<string, unknown> {
  const backup = buildBackup(buildSeedDataset(), DEFAULT_SETTINGS);
  return JSON.parse(serializeBackup(backup)) as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
});

/* ------------------------------------------------------------------------ */

describe('export', () => {
  it('includes every table, a schema version and a timestamp', () => {
    const backup = buildBackup(buildSeedDataset(), DEFAULT_SETTINGS);

    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.schema_version).toBe(BACKUP_SCHEMA_VERSION);
    expect(Number.isNaN(Date.parse(backup.exported_at))).toBe(false);

    expect(Object.keys(backup.tables).sort()).toEqual([
      'accounts', 'activity_events', 'content_items', 'leads',
      'performance_snapshots', 'recommendations', 'tasks', 'traffic_snapshots',
    ]);
    expect(backup.counts.content_items).toBe(3);
    expect(backup.counts.performance_snapshots).toBe(3);
  });

  it('carries app settings', () => {
    const backup = buildBackup(buildSeedDataset(), {
      ...DEFAULT_SETTINGS,
      pipelineView: 'table',
      showCompletedTasks: true,
    });
    expect(backup.settings.pipelineView).toBe('table');
    expect(backup.settings.showCompletedTasks).toBe(true);
    // The program travels with the backup, so a restore brings the same dates.
    expect(backup.settings.program.startDate).toBe('2026-08-27');
    expect(backup.settings.program.targetDate).toBe('2026-11-25');
  });

  it('writes absent metrics as explicit nulls rather than dropping the keys', () => {
    const json = serializeBackup(buildBackup(buildSeedDataset(), DEFAULT_SETTINGS));
    const parsed = JSON.parse(json) as Record<string, never>;
    const snapshot = (parsed.tables as never as Record<string, Record<string, unknown>[]>)
      .performance_snapshots.find((s) => s.id === 'ps-bts-ig-24h');

    expect(snapshot).toBeDefined();
    expect(snapshot).toHaveProperty('likes');
    expect(snapshot?.likes).toBeNull();
    expect(snapshot?.views).toBe(31);
    expect(json).toContain('"likes": null');
  });
});

/* ------------------------------------------------------------------------ */

describe('export -> clear -> import recovers the dataset exactly', () => {
  it('round-trips through the repository with nothing lost or invented', async () => {
    const repo = createLocalRepository();

    // A disposable dataset: the seed plus rows covering every table.
    const before = await repo.loadAll();
    const lead = await repo.insert('leads', newLead({
      content_item_id: before.contentItems[0].id,
      prospect_name: 'Rivera Roofing', organization: 'Rivera',
      project: 'Site rebuild', source: 'Instagram story',
      stage: 'proposal', next_action: 'Send revised proposal',
      next_action_date: '2026-09-18', proposed_value: 6000,
      attribution_note: 'Mentioned the story on the first call',
      first_contact_at: '2026-09-14',
    }));
    await repo.insert('recommendations', {
      rule_id: 'R6_insufficient_evidence', headline: 'Not yet measurable',
      detail: 'Two items only.', suggested_action: null, confidence: 'early_signal',
      cohort_platform: 'instagram', cohort_format: 'story', sample_size: 1,
      evidence: { lines: [], content_item_ids: [], excluded: [] },
      generated_at: '2026-09-14T00:00:00.000Z', dismissed_at: null,
    });
    await repo.insert('activity_events', newActivity({
      occurred_at: '2026-09-18T15:00:00.000Z',
      activity_type: 'networking_event',
      title: 'Wynwood meetup',
      details: 'Three conversations worth following up',
      lead_id: lead.id,
    }));
    await repo.insert('tasks', newTask({
      content_item_id: null, lead_id: lead.id, title: 'Call Rivera',
      task_type: 'follow_up', status: 'open', due_date: '2026-09-18',
      window_type: null, notes: null, completed_at: null,
      external_calendar_id: null, external_event_id: null,
      calendar_sync_status: 'not_synced', last_synced_at: null, sync_error: null,
      is_seed: false,
    }));

    const original = await repo.loadAll();
    writeSettings({ ...DEFAULT_SETTINGS, pipelineView: 'table', showCompletedTasks: true });

    // Export.
    const json = serializeBackup(buildBackup(original, readSettings()));

    // Clear everything, the way clearing site data would.
    await repo.replaceAll?.(emptyDataset());
    localStorage.removeItem('slmc.settings.v1');
    const emptied = await repo.loadAll();
    expect(emptied.contentItems).toHaveLength(0);
    expect(emptied.leads).toHaveLength(0);

    // Import.
    const result = parseAndValidate(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await repo.replaceAll?.(result.data);
    writeSettings(result.settings);
    const restored = await repo.loadAll();

    expect(restored).toEqual(original);
    expect(readSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      pipelineView: 'table',
      showCompletedTasks: true,
    });
  });

  it('brings null metrics back as null, not as zero', async () => {
    const repo = createLocalRepository();
    const original = await repo.loadAll();
    const json = serializeBackup(buildBackup(original, DEFAULT_SETTINGS));

    await repo.replaceAll?.(emptyDataset());

    const result = parseAndValidate(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await repo.replaceAll?.(result.data);

    const snapshot = (await repo.loadAll()).snapshots.find((s) => s.id === 'ps-bts-ig-24h');
    expect(snapshot?.views).toBe(31);
    expect(snapshot?.likes).toBeNull();
    expect(snapshot?.link_clicks).toBeNull();
    expect(snapshot?.leads).toBeNull();
    expect(snapshot?.likes).not.toBe(0);
  });
});

/* ------------------------------------------------------------------------ */

describe('malformed and incompatible files are rejected', () => {
  it('rejects text that is not JSON', () => {
    const result = parseAndValidate('this is not json {');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/not valid JSON/);
  });

  it('rejects JSON that is not an object', () => {
    for (const text of ['[]', '"a string"', '42', 'null']) {
      const result = parseAndValidate(text);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a file that is not a cockpit backup', () => {
    const result = validateBackup({ format: 'some-other-app', schema_version: 1, tables: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/not a Marketing Cockpit backup/);
  });

  it('rejects a backup written by a newer schema', () => {
    const file = validBackupObject();
    file.schema_version = BACKUP_SCHEMA_VERSION + 1;
    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/newer version/);
  });

  it('accepts an older schema but warns that new fields will be empty', () => {
    const file = validBackupObject();
    file.schema_version = 1;
    const result = validateBackup(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(' ')).toMatch(/schema 1/);
  });

  it('restores a version 1 backup that has no activity table at all', () => {
    const file = validBackupObject();
    file.schema_version = 1;
    delete (file.tables as Record<string, unknown>).activity_events;

    const result = validateBackup(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.activityEvents).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/predates the "activity_events" table/);
    // The rest of the backup still comes through untouched.
    expect(result.data.contentItems).toHaveLength(3);
  });

  it('still rejects a current-version backup that is missing the activity table', () => {
    const file = validBackupObject();
    delete (file.tables as Record<string, unknown>).activity_events;

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/missing the "activity_events" table/);
  });

  it('rejects a file with no tables section', () => {
    const result = validateBackup({
      format: BACKUP_FORMAT, schema_version: 1, exported_at: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/no "tables" section/);
  });
});

describe('missing tables', () => {
  it('names every table that is absent', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, unknown>;
    delete tables.leads;
    delete tables.tasks;

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/missing the "leads" table/);
    expect(result.errors.join(' ')).toMatch(/missing the "tasks" table/);
  });

  it('rejects a table that is not a list', () => {
    const file = validBackupObject();
    (file.tables as Record<string, unknown>).accounts = { not: 'a list' };
    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/"accounts" is not a list of records/);
  });
});

describe('duplicate ids', () => {
  it('rejects a table containing the same id twice', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.content_items.push(structuredClone(tables.content_items[0]));

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/repeats the id "ci-bts-story-instagram"/);
  });

  it('rejects a row with no id at all', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    delete tables.accounts[0].id;

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/accounts\[0\] has no id/);
  });

  it('allows the same id in two different tables', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.tasks[0].id = tables.accounts[0].id;
    expect(validateBackup(file).ok).toBe(true);
  });
});

describe('null metrics', () => {
  it('accepts null for every metric field', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    for (const key of ['views', 'likes', 'shares', 'leads', 'qualified_leads']) {
      tables.performance_snapshots[0][key] = null;
    }
    expect(validateBackup(file).ok).toBe(true);
  });

  it('rejects a metric that arrived as a string', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.performance_snapshots[0].views = '31';

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/non-numeric "views"/);
    expect(result.errors.join(' ')).toMatch(/corrupt every average/);
  });

  it('rejects a metric key that has been dropped entirely', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    delete tables.performance_snapshots[0].saves;

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/is missing "saves" entirely/);
  });

  it('rejects NaN and Infinity', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.performance_snapshots[0].views = Number.POSITIVE_INFINITY;
    expect(validateBackup(file).ok).toBe(false);
  });

  it('keeps a recorded zero as a zero', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.performance_snapshots[0].link_clicks = 0;

    const result = validateBackup(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.snapshots[0].link_clicks).toBe(0);
  });
});

describe('field and reference checks', () => {
  it('rejects an unrecognised enum value', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.content_items[0].status = 'half-published';

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/unrecognised "status"/);
  });

  it('rejects a non-boolean amplification flag', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.content_items[0].is_externally_amplified = 'yes';
    expect(validateBackup(file).ok).toBe(false);
  });

  it('warns, but does not block, on a reference to a missing row', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.content_items[0].account_id = 'acc-that-does-not-exist';

    const result = validateBackup(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(' ')).toMatch(/acc-that-does-not-exist/);
  });
});

/* ------------------------------------------------------------------------ */

describe('a rejected import never touches existing data', () => {
  const badFiles: [string, string][] = [
    ['unparseable text', 'not json at all'],
    ['an array', '[]'],
    ['a foreign format', JSON.stringify({ format: 'other', schema_version: 1 })],
    ['a newer schema', JSON.stringify({ ...validBackupObject(), schema_version: 99 })],
  ];

  for (const [label, text] of badFiles) {
    it(`leaves the dataset intact when given ${label}`, async () => {
      const repo = createLocalRepository();
      const before = await repo.loadAll();
      const fingerprint = JSON.stringify(before);

      const result = parseAndValidate(text);
      expect(result.ok).toBe(false);
      // The panel only calls replaceAll on result.ok, so nothing is written here.

      const after = await repo.loadAll();
      expect(JSON.stringify(after)).toBe(fingerprint);
      expect(after.contentItems).toHaveLength(3);
    });
  }

  it('leaves the dataset intact when a structurally valid file has bad rows', async () => {
    const repo = createLocalRepository();
    const fingerprint = JSON.stringify(await repo.loadAll());

    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.performance_snapshots[0].views = 'thirty-one';
    tables.content_items.push(structuredClone(tables.content_items[0]));

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(2);

    expect(JSON.stringify(await repo.loadAll())).toBe(fingerprint);
  });
});

/* ------------------------------------------------------------------------ */

describe('an empty dataset is a legitimate backup', () => {
  it('exports and restores zero records without complaint', () => {
    const empty: Dataset = emptyDataset();
    const json = serializeBackup(buildBackup(empty, DEFAULT_SETTINGS));
    const result = parseAndValidate(json);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(empty);
    expect(result.warnings).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ */

describe('activity survives backup and restore', () => {
  it('comes back with every field intact, including its links', async () => {
    const repo = createLocalRepository();
    const content = (await repo.loadAll()).contentItems[0];

    const logged = await repo.insert('activity_events', newActivity({
      occurred_at: '2026-09-18T15:00:00.000Z',
      activity_type: 'proposal_sent',
      title: 'Sent the Rivera proposal',
      details: 'Two options, mid and high',
      content_item_id: content.id,
    }));

    const original = await repo.loadAll();
    const json = serializeBackup(buildBackup(original, DEFAULT_SETTINGS));

    await repo.replaceAll?.(emptyDataset());
    expect((await repo.loadAll()).activityEvents).toHaveLength(0);

    const result = parseAndValidate(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await repo.replaceAll?.(result.data);

    const restored = (await repo.loadAll()).activityEvents;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(logged);
    expect(restored[0].content_item_id).toBe(content.id);
    expect(restored[0].activity_type).toBe('proposal_sent');
  });

  it('rejects a backup whose activity has an unknown type', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.activity_events = [
      {
        id: 'a1', occurred_at: '2026-09-18T15:00:00.000Z',
        activity_type: 'went_for_a_walk', title: 'Hmm', details: null,
        source: 'manual', external_id: null,
        content_item_id: null, lead_id: null, task_id: null,
        external_calendar_id: null, external_event_id: null,
        calendar_sync_status: 'not_synced', last_synced_at: null, sync_error: null,
        is_seed: false, created_at: '2026-09-18T15:00:00.000Z',
        updated_at: '2026-09-18T15:00:00.000Z',
      },
    ];

    const result = validateBackup(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toMatch(/unrecognised "activity_type"/);
  });

  it('warns when an activity points at a task the backup does not contain', () => {
    const file = validBackupObject();
    const tables = file.tables as Record<string, Record<string, unknown>[]>;
    tables.activity_events = [
      {
        id: 'a1', occurred_at: '2026-09-18T15:00:00.000Z',
        activity_type: 'other', title: 'Orphan', details: null,
        source: 'manual', external_id: null,
        content_item_id: null, lead_id: null, task_id: 'tk-missing',
        external_calendar_id: null, external_event_id: null,
        calendar_sync_status: 'not_synced', last_synced_at: null, sync_error: null,
        is_seed: false, created_at: '2026-09-18T15:00:00.000Z',
        updated_at: '2026-09-18T15:00:00.000Z',
      },
    ];

    const result = validateBackup(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(' ')).toMatch(/tk-missing/);
  });
});
