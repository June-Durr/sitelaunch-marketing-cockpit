/**
 * App settings: browser-local interface preferences.
 *
 * These are not business data, but they are part of a complete backup, restoring
 * onto a fresh machine should bring the cockpit back the way it was left.
 */

import { DEFAULT_PROGRAM, validateProgram, type ProgramConfig } from '../config/program';

export interface AppSettings {
  /** Pipeline default view. */
  pipelineView: 'board' | 'table';
  /** Whether the Tasks screen shows the completed list expanded. */
  showCompletedTasks: boolean;
  /**
   * The program every figure on the Today screen is counted against. Editable,
   * and carried in backups, so restoring brings the same program back with it.
   */
  program: ProgramConfig;
}

export const DEFAULT_SETTINGS: AppSettings = {
  pipelineView: 'board',
  showCompletedTasks: false,
  program: DEFAULT_PROGRAM,
};

const SETTINGS_KEY = 'slmc.settings.v1';

export function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked or full. Preferences are not worth failing a session over.
  }
}

/** Accepts anything and returns a settings object, discarding unknown keys. */
export function coerceSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
  const input = value as Partial<AppSettings>;
  return {
    pipelineView: input.pipelineView === 'table' ? 'table' : 'board',
    showCompletedTasks: input.showCompletedTasks === true,
    program: coerceProgram(input.program),
  };
}

/**
 * A program from storage or a backup. Anything unreadable falls back to the
 * agreed dates rather than to something invented, so a corrupt settings blob
 * cannot quietly move the target date.
 */
export function coerceProgram(value: unknown): ProgramConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PROGRAM };
  const input = value as Partial<ProgramConfig>;
  const candidate: ProgramConfig = {
    name: typeof input.name === 'string' && input.name.trim() ? input.name : DEFAULT_PROGRAM.name,
    startDate: typeof input.startDate === 'string' ? input.startDate : DEFAULT_PROGRAM.startDate,
    targetDate:
      typeof input.targetDate === 'string' ? input.targetDate : DEFAULT_PROGRAM.targetDate,
    goal: typeof input.goal === 'string' && input.goal.trim() ? input.goal : null,
  };
  return validateProgram(candidate) === null ? candidate : { ...DEFAULT_PROGRAM };
}
