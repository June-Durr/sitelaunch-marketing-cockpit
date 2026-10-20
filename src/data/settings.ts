/**
 * App settings: browser-local interface preferences.
 *
 * These are not business data, but they are part of a complete backup, restoring
 * onto a fresh machine should bring the cockpit back the way it was left.
 */

import { DEFAULT_PROGRAM, validateProgram, type ProgramConfig } from '../config/program';

/**
 * How you introduce yourself in a first message.
 *
 * Here because the alternative is a message that goes out saying "[Your Name]",
 * or worse, a name the app made up. Null until somebody says, and a draft that
 * does not know simply leaves the line out and asks.
 */
export interface Introduction {
  name: string | null;
  business: string | null;
}

export interface AppSettings {
  /** Pipeline default view. 'queue' is the one ordered by what is actually due. */
  pipelineView: 'board' | 'table' | 'queue';
  /** Whether the Tasks screen shows the completed list expanded. */
  showCompletedTasks: boolean;
  /**
   * The program every figure on the Today screen is counted against. Editable,
   * and carried in backups, so restoring brings the same program back with it.
   */
  program: ProgramConfig;
  /** Used by the assistant's first message, and by nothing else. */
  introduction: Introduction;
}

export const DEFAULT_SETTINGS: AppSettings = {
  pipelineView: 'queue',
  showCompletedTasks: false,
  program: DEFAULT_PROGRAM,
  // Not guessed from the signed in email or the app's own name. A wrong
  // introduction in a message to a stranger is worse than a missing one.
  introduction: { name: null, business: null },
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

/**
 * Everything waiting to hear that settings changed.
 *
 * localStorage fires its storage event in other tabs and never in the one that
 * did the writing, so a panel sitting open while somebody edits their profile
 * on another screen would keep composing messages from the old identity. This
 * is that missing notification, and nothing more: no state, no context, one set
 * of callbacks.
 */
const listeners = new Set<(settings: AppSettings) => void>();

/** Hear about every write. Returns the function that stops listening. */
export function subscribeToSettings(listener: (settings: AppSettings) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function writeSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked or full. Preferences are not worth failing a session over.
  }
  // After the write, so a listener that re-reads gets what was just stored.
  for (const listener of listeners) listener(settings);
}

/**
 * How the person using the Cockpit introduces themselves.
 *
 * One store, and this is it. There is no second place a sender name lives: the
 * accounts table holds the handles posts go out under, which is a different
 * thing, and the program's name is the name of a ninety day run. Anything that
 * needs to know who is writing a message reads this.
 */
export function readIdentity(): Introduction {
  return readSettings().introduction;
}

/** True when there is enough to say who a message is from. */
export function hasIdentity(identity: Introduction): boolean {
  return (identity.name ?? '').trim() !== '';
}

/** Save the identity without disturbing any other setting. */
export function writeIdentity(identity: Introduction): void {
  writeSettings({ ...readSettings(), introduction: coerceIntroduction(identity) });
}

/** Accepts anything and returns a settings object, discarding unknown keys. */
export function coerceSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
  const input = value as Partial<AppSettings>;
  return {
    pipelineView:
      input.pipelineView === 'table' || input.pipelineView === 'board'
        ? input.pipelineView
        : 'queue',
    showCompletedTasks: input.showCompletedTasks === true,
    program: coerceProgram(input.program),
    introduction: coerceIntroduction(input.introduction),
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

/** An introduction from storage or a backup. Blank strings become null. */
export function coerceIntroduction(value: unknown): Introduction {
  if (!value || typeof value !== 'object') return { name: null, business: null };
  const input = value as Partial<Introduction>;
  const text = (field: unknown): string | null =>
    typeof field === 'string' && field.trim() !== '' ? field.trim().slice(0, 80) : null;
  return { name: text(input.name), business: text(input.business) };
}
