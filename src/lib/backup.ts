/**
 * JSON export and import for browser-local mode.
 *
 * The governing rule: **validation completes before anything is written.** A file is
 * parsed, structurally checked, type-checked field by field, and cross-referenced
 * before a single existing row is touched. A rejected import leaves the current
 * dataset exactly as it was.
 *
 * The second rule follows from the rest of this app: a metric that was exported as
 * null comes back as null. The validator rejects a file that has turned nulls into
 * zeroes or into strings, because such a file would silently corrupt every average.
 */

import type { Dataset } from '../types/domain';
import {
  ACTIVITY_SOURCE_LABELS, ACTIVITY_TYPE_LABELS, CONFIDENCE_LABELS, FORMAT_LABELS,
  PLATFORM_LABELS, STAGE_LABELS, STATUS_LABELS, TASK_TYPE_LABELS, WINDOW_LABELS,
} from '../types/domain';
import { FOLLOW_UP_MODE_LABELS } from '../config/followUp';
import type { TableName } from '../data/repository';
import { EMPTY_DATASET } from '../data/repository';
import { coerceSettings, DEFAULT_SETTINGS, type AppSettings } from '../data/settings';

export const BACKUP_FORMAT = 'sitelaunch-marketing-cockpit-backup';
/**
 * 3 added the relationship follow-up columns.
 *
 * leads gained an external key, the mirror's own labels, a follow-up mode and a
 * reported last-touch date; activity_events gained a channel, an evidence source
 * and an external source. See supabase/migrations/0007_lead_mirror.sql.
 */
export const BACKUP_SCHEMA_VERSION = 3;

/**
 * Which schema version each table first appeared in.
 *
 * A backup written before a table existed is not corrupt, it is just older. Those
 * tables restore as empty with a warning, rather than the whole file being
 * rejected for missing something that could not have been there.
 */
export const TABLE_ADDED_IN: Record<TableName, number> = {
  accounts: 1,
  content_items: 1,
  performance_snapshots: 1,
  traffic_snapshots: 1,
  leads: 1,
  tasks: 1,
  recommendations: 1,
  activity_events: 2,
};

/**
 * Which schema version each field first appeared in, and what it should be when
 * restoring a backup written before it existed.
 *
 * WHY THIS IS NOT JUST A WARNING
 *
 * A backup exported by an older build of this app genuinely does not have these
 * keys, and that is not corruption. Rejecting the file would make the app refuse
 * its own exports, and restoring the row untouched would be worse: a field that is
 * `undefined` rather than `null` reads as "present but broken" to every check in
 * the app that distinguishes a recorded blank from a missing one. So the field is
 * filled with the value it would have had, and the restore says it did.
 *
 * The default for every added field is null, meaning not recorded, except
 * follow_up_mode, which is 'auto': a lead imported from a backup that predates the
 * idea of a follow-up mode was never deliberately held or archived.
 */
export const FIELD_ADDED_IN: Partial<Record<TableName, Record<string, number>>> = {
  leads: {
    external_source: 3,
    external_key: 3,
    relationship: 3,
    current_status: 3,
    preferred_channel: 3,
    record_confidence: 3,
    follow_up_mode: 3,
    reported_last_touch_at: 3,
  },
  activity_events: {
    external_source: 3,
    channel: 3,
    evidence_source: 3,
  },
};

export const FIELD_DEFAULTS: Partial<Record<TableName, Record<string, unknown>>> = {
  leads: {
    external_source: null,
    external_key: null,
    relationship: null,
    current_status: null,
    preferred_channel: null,
    record_confidence: null,
    follow_up_mode: 'auto',
    reported_last_touch_at: null,
  },
  activity_events: {
    external_source: null,
    channel: null,
    evidence_source: null,
  },
};

/** Database table name -> its array in the in-memory Dataset. */
export const TABLE_TO_COLLECTION: Record<TableName, keyof Dataset> = {
  accounts: 'accounts',
  content_items: 'contentItems',
  performance_snapshots: 'snapshots',
  traffic_snapshots: 'traffic',
  leads: 'leads',
  tasks: 'tasks',
  recommendations: 'recommendations',
  activity_events: 'activityEvents',
};

export const TABLE_NAMES = Object.keys(TABLE_TO_COLLECTION) as TableName[];

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schema_version: number;
  exported_at: string;
  app: { name: string; storage_mode: string };
  counts: Record<TableName, number>;
  tables: Record<TableName, Record<string, unknown>[]>;
  settings: AppSettings;
}

export type ValidationResult =
  | { ok: true; backup: BackupFile; data: Dataset; settings: AppSettings; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/* ------------------------------------------------------------------ export -- */

export function buildBackup(
  data: Dataset,
  settings: AppSettings,
  storageMode = 'local',
): BackupFile {
  const tables = {} as Record<TableName, Record<string, unknown>[]>;
  const counts = {} as Record<TableName, number>;

  for (const table of TABLE_NAMES) {
    const rows = (data[TABLE_TO_COLLECTION[table]] ?? []) as unknown as Record<string, unknown>[];
    tables[table] = rows;
    counts[table] = rows.length;
  }

  return {
    format: BACKUP_FORMAT,
    schema_version: BACKUP_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    app: { name: 'SiteLaunch Marketing Cockpit', storage_mode: storageMode },
    counts,
    tables,
    settings,
  };
}

/**
 * Serialised with an explicit null replacer-free JSON.stringify: absent metrics are
 * written as `null`, never dropped. A dropped key would re-import as undefined and
 * read as "not recorded" by accident rather than by record.
 */
export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

export function backupFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `sitelaunch-cockpit-backup-${stamp}.json`;
}

/* -------------------------------------------------------------- validation -- */

interface TableSpec {
  /** Fields that must be a non-empty string. */
  requiredStrings: string[];
  /** Fields that must be `number | null`, never a string, never undefined. */
  numerics: string[];
  /** Fields that must be a boolean. */
  booleans: string[];
  /** Fields constrained to a fixed set of values. */
  enums: Record<string, string[]>;
  /** Fields holding an id in another table; missing targets are warnings. */
  refs: Record<string, TableName>;
}

const keysOf = (map: Record<string, unknown>) => Object.keys(map);

const SPECS: Record<TableName, TableSpec> = {
  accounts: {
    requiredStrings: ['handle'],
    numerics: [],
    booleans: ['is_active', 'is_seed'],
    enums: { platform: keysOf(PLATFORM_LABELS) },
    refs: {},
  },
  content_items: {
    requiredStrings: ['title'],
    numerics: [],
    booleans: ['is_externally_amplified', 'is_seed'],
    enums: { format: keysOf(FORMAT_LABELS), status: keysOf(STATUS_LABELS) },
    refs: { account_id: 'accounts' },
  },
  performance_snapshots: {
    requiredStrings: ['content_item_id', 'captured_at'],
    numerics: [
      'views', 'reach', 'watch_time_seconds', 'three_second_views', 'interactions',
      'likes', 'comments', 'shares', 'saves', 'replies', 'profile_visits',
      'link_clicks', 'website_sessions', 'form_starts', 'leads', 'qualified_leads',
    ],
    booleans: ['metrics_unavailable', 'is_seed'],
    enums: { window_type: keysOf(WINDOW_LABELS) },
    refs: { content_item_id: 'content_items' },
  },
  traffic_snapshots: {
    requiredStrings: ['range_start', 'range_end'],
    numerics: [
      'sessions', 'active_users', 'engagement_time_secs', 'engaged_sessions',
      'cta_clicks', 'form_starts', 'generate_lead_events', 'qualified_inquiries',
    ],
    booleans: ['is_seed'],
    enums: {},
    refs: { content_item_id: 'content_items' },
  },
  leads: {
    requiredStrings: ['prospect_name'],
    numerics: ['proposed_value', 'closed_value'],
    booleans: ['is_seed'],
    enums: {
      stage: keysOf(STAGE_LABELS),
      follow_up_mode: keysOf(FOLLOW_UP_MODE_LABELS),
    },
    refs: { content_item_id: 'content_items' },
  },
  tasks: {
    requiredStrings: ['title', 'due_date'],
    numerics: [],
    booleans: ['is_seed'],
    enums: {
      task_type: keysOf(TASK_TYPE_LABELS),
      status: ['open', 'done', 'skipped'],
      calendar_sync_status: ['not_synced', 'pending', 'synced', 'error'],
    },
    refs: { content_item_id: 'content_items', lead_id: 'leads' },
  },
  recommendations: {
    requiredStrings: ['rule_id', 'headline', 'detail'],
    numerics: ['sample_size'],
    booleans: [],
    enums: { confidence: keysOf(CONFIDENCE_LABELS) },
    refs: {},
  },
  activity_events: {
    requiredStrings: ['occurred_at', 'title'],
    numerics: [],
    booleans: ['is_seed'],
    enums: {
      activity_type: keysOf(ACTIVITY_TYPE_LABELS),
      source: keysOf(ACTIVITY_SOURCE_LABELS),
      calendar_sync_status: ['not_synced', 'pending', 'synced', 'error'],
    },
    refs: {
      content_item_id: 'content_items',
      lead_id: 'leads',
      task_id: 'tasks',
    },
  },
};

/** Parse text into a validated backup. Never throws; a parse failure is an error. */
export function parseAndValidate(text: string): ValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      errors: [
        `The file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  return validateBackup(raw);
}

export function validateBackup(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      warnings,
      errors: ['The file does not contain a backup object.'],
    };
  }

  const file = raw as Record<string, unknown>;

  if (file.format !== BACKUP_FORMAT) {
    errors.push(
      `This is not a Marketing Cockpit backup. Expected format "${BACKUP_FORMAT}", found ${
        typeof file.format === 'string' ? `"${file.format}"` : 'nothing'
      }.`,
    );
  }

  const version = file.schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    errors.push('The backup has no readable schema version.');
  } else if (version > BACKUP_SCHEMA_VERSION) {
    errors.push(
      `The backup was written by a newer version of this app (schema ${version}, this app reads ${BACKUP_SCHEMA_VERSION}). Importing it could lose fields this version does not understand.`,
    );
  } else if (version < BACKUP_SCHEMA_VERSION) {
    warnings.push(
      `Backup uses schema ${version}; this app is at ${BACKUP_SCHEMA_VERSION}. Older backups import, but any field added since will be empty.`,
    );
  }

  if (typeof file.exported_at !== 'string' || Number.isNaN(Date.parse(file.exported_at))) {
    warnings.push('The backup has no readable export timestamp.');
  }

  // Structural check on every table before any field is examined.
  const tablesValue = file.tables;
  if (tablesValue === null || typeof tablesValue !== 'object' || Array.isArray(tablesValue)) {
    errors.push('The backup has no "tables" section.');
    return { ok: false, errors, warnings };
  }
  const tables = tablesValue as Record<string, unknown>;

  const fileVersion = typeof version === 'number' ? version : BACKUP_SCHEMA_VERSION;
  for (const table of TABLE_NAMES) {
    if (!(table in tables)) {
      if (TABLE_ADDED_IN[table] > fileVersion) {
        // Older backup, written before this table existed. Restore it empty.
        tables[table] = [];
        warnings.push(
          `This backup predates the "${table}" table, so it will restore with none. Nothing is lost that the backup ever held.`,
        );
      } else {
        errors.push(`The backup is missing the "${table}" table.`);
      }
    } else if (!Array.isArray(tables[table])) {
      errors.push(`"${table}" is not a list of records.`);
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  // Field-level checks, plus an id index for cross-table references.
  const idsByTable = new Map<TableName, Set<string>>();
  for (const table of TABLE_NAMES) {
    const rows = tables[table] as unknown[];
    const seen = new Set<string>();
    const backfilled = new Set<string>();

    rows.forEach((row, index) => {
      const where = `${table}[${index}]`;
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        errors.push(`${where} is not a record.`);
        return;
      }
      const record = row as Record<string, unknown>;

      /**
       * Fill in fields this backup predates, before anything is checked.
       *
       * Done per row rather than per table because a dataset can mix rows written
       * by different builds, for instance after restoring an old backup and then
       * adding a lead. A field that is present is never touched, whatever its
       * value, so this can only ever add and never overwrite.
       */
      for (const [field, addedIn] of Object.entries(FIELD_ADDED_IN[table] ?? {})) {
        if (field in record) continue;
        if (addedIn <= fileVersion) continue;
        record[field] = FIELD_DEFAULTS[table]?.[field] ?? null;
        backfilled.add(field);
      }

      const id = record.id;
      if (typeof id !== 'string' || id.trim() === '') {
        errors.push(`${where} has no id.`);
      } else if (seen.has(id)) {
        errors.push(`${where} repeats the id "${id}", which already appears in ${table}.`);
      } else {
        seen.add(id);
      }

      const spec = SPECS[table];

      for (const field of spec.requiredStrings) {
        const value = record[field];
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push(`${where} is missing "${field}".`);
        }
      }

      for (const field of spec.numerics) {
        const value = record[field];
        if (value === null) continue; // absent is a legitimate, meaningful value
        if (value === undefined) {
          errors.push(
            `${where} is missing "${field}" entirely. Every metric has to be there as a number or as null, because a missing field cannot be told apart from one that got lost on the way.`,
          );
        } else if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push(
            `${where} has a non-numeric "${field}" (${JSON.stringify(value)}). Importing it would corrupt every average this metric feeds.`,
          );
        }
      }

      for (const field of spec.booleans) {
        if (typeof record[field] !== 'boolean') {
          errors.push(`${where} has a non-boolean "${field}".`);
        }
      }

      for (const [field, allowed] of Object.entries(spec.enums)) {
        const value = record[field];
        if (typeof value !== 'string' || !allowed.includes(value)) {
          errors.push(
            `${where} has an unrecognised "${field}" (${JSON.stringify(value)}).`,
          );
        }
      }
    });

    if (backfilled.size > 0) {
      warnings.push(
        `This backup predates ${[...backfilled].sort().join(', ')} on "${table}", so ${
          backfilled.size === 1 ? 'that field' : 'those fields'
        } will restore blank. Nothing is lost that the backup ever held.`,
      );
    }

    idsByTable.set(table, seen);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  // Cross-table references. A dangling reference is recoverable, the row still
  // holds its own data, so it warns rather than blocking the restore.
  for (const table of TABLE_NAMES) {
    const rows = tables[table] as Record<string, unknown>[];
    for (const [field, targetTable] of Object.entries(SPECS[table].refs)) {
      const targets = idsByTable.get(targetTable) ?? new Set<string>();
      rows.forEach((row, index) => {
        const value = row[field];
        if (typeof value === 'string' && value !== '' && !targets.has(value)) {
          warnings.push(
            `${table}[${index}] points at ${targetTable} "${value}", which is not in this backup. The link will be empty after import.`,
          );
        }
      });
    }
  }

  const data: Dataset = { ...EMPTY_DATASET };
  for (const table of TABLE_NAMES) {
    // Cloned so the caller cannot mutate the parsed file, and vice versa.
    (data as unknown as Record<string, unknown>)[TABLE_TO_COLLECTION[table]] =
      structuredClone(tables[table]);
  }

  const settings = 'settings' in file ? coerceSettings(file.settings) : { ...DEFAULT_SETTINGS };
  if (!('settings' in file)) {
    warnings.push('The backup has no settings section. Defaults will be used.');
  }

  return {
    ok: true,
    backup: { ...(file as unknown as BackupFile), settings },
    data,
    settings,
    warnings,
  };
}

/** Row counts of the dataset about to be replaced, for the confirmation step. */
export function datasetCounts(data: Dataset): Record<TableName, number> {
  const counts = {} as Record<TableName, number>;
  for (const table of TABLE_NAMES) {
    counts[table] = (data[TABLE_TO_COLLECTION[table]] ?? []).length;
  }
  return counts;
}

export function totalRows(counts: Record<TableName, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}
