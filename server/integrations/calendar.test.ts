/**
 * Calendar contract rules.
 *
 * Nothing is connected, so there is nothing to integration test. What can be
 * pinned down now is the decisions, which are written as functions precisely so a
 * later edit cannot quietly reverse them without a test going red.
 */

import { describe, expect, it } from 'vitest';
import {
  externalEventOnLocalDelete, needsUserConfirmation, plannedCalendarAction,
  type CalendarEventDraft,
} from './calendar.ts';

const draft = (over: Partial<CalendarEventDraft> = {}): CalendarEventDraft => ({
  taskId: 'tk1',
  title: 'Record 7 day numbers',
  date: '2026-09-20',
  description: null,
  existingEventId: null,
  ...over,
});

describe('pushing a task to a calendar is idempotent', () => {
  it('creates when the task has never been pushed', () => {
    expect(plannedCalendarAction(draft())).toBe('create');
  });

  it('updates the same event once an id is stored, rather than making a second', () => {
    expect(plannedCalendarAction(draft({ existingEventId: 'evt_123' }))).toBe('update');
  });

  it('keeps updating on every later push', () => {
    const pushed = draft({ existingEventId: 'evt_123' });
    for (let i = 0; i < 5; i += 1) {
      expect(plannedCalendarAction(pushed)).toBe('update');
    }
  });
});

describe('deleting locally never deletes somebody else calendar entry', () => {
  it('keeps the external event', () => {
    expect(externalEventOnLocalDelete()).toBe('keep');
  });
});

describe('destructive external actions need a yes first', () => {
  it('asks before updating or deleting', () => {
    expect(needsUserConfirmation('delete')).toBe(true);
    expect(needsUserConfirmation('update')).toBe(true);
  });

  it('does not ask to read, or to create something new', () => {
    expect(needsUserConfirmation('read')).toBe(false);
    expect(needsUserConfirmation('create')).toBe(false);
  });
});

describe('the contract ships no credentials and no fake behaviour', () => {
  it('exports types and pure decisions only', async () => {
    const calendar = await import('./calendar.ts');
    const runtimeExports = Object.keys(calendar);
    expect(runtimeExports.sort()).toEqual([
      'externalEventOnLocalDelete', 'needsUserConfirmation', 'plannedCalendarAction',
    ]);
  });
});
