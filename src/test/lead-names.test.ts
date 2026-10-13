/**
 * The browser's name rule and the server's, held to the same answers.
 *
 * They are separate implementations on purpose: src is not allowed to import
 * from server/integrations, and a test asserting they agree is the arrangement
 * this project already uses for reconcile_follow_up_tasks and
 * src/config/followUpTasks.ts.
 *
 * What this catches is the failure that matters: a lead reading as
 * "DJ 4THE WIN" in the app and "Name pending" on the calendar, because somebody
 * edited one copy.
 */

import { describe, expect, it } from 'vitest';

import { isPlaceholderName as browserRule, leadLabel, leadShortLabel } from '../lib/leadLabel';
import {
  displayName, isPlaceholderName as serverRule,
} from '../../server/integrations/leadNames';

/** Every shape the real data and the imports have produced, plus the edges. */
const CASES: (string | null)[] = [
  'Name pending',
  'name pending',
  '  Name Pending  ',
  'Chef \u2014 name pending',
  'Chef - name pending',
  'Carlos Flores Iselo',
  'Janeth',
  'Taylor',
  '',
  '   ',
  null,
  'Pending',
  'No name pending yet',
];

describe('the two copies of the name rule agree', () => {
  it('answers identically for every case', () => {
    for (const name of CASES) {
      expect(browserRule(name), `disagreement on ${JSON.stringify(name)}`)
        .toBe(serverRule(name));
    }
  });

  it('treats the real placeholders as absent', () => {
    for (const name of ['Name pending', 'name pending', 'Chef \u2014 name pending', '', null]) {
      expect(browserRule(name), JSON.stringify(name)).toBe(true);
    }
  });

  it('treats real names as present', () => {
    for (const name of ['Carlos Flores Iselo', 'Janeth', 'Taylor', 'Eddie Claus']) {
      expect(browserRule(name), name).toBe(false);
    }
  });
});

describe('what gets shown when the name is unknown', () => {
  it('uses the organisation rather than the placeholder', () => {
    expect(leadLabel({ prospect_name: 'Name pending', organization: 'DJ 4THE WIN' }))
      .toBe('DJ 4THE WIN');
    expect(displayName('Name pending', 'DJ 4THE WIN')).toBe('DJ 4THE WIN');
  });

  it('shows the person and the organisation when both are real', () => {
    expect(leadLabel({ prospect_name: 'Carlos Flores Iselo', organization: 'Sweet Stax' }))
      .toBe('Carlos Flores Iselo, Sweet Stax');
  });

  it('does not repeat the organisation when it is the label', () => {
    expect(leadLabel({ prospect_name: 'Name pending', organization: 'FaKafe' })).toBe('FaKafe');
  });

  it('says so when neither is known, rather than inventing either', () => {
    expect(leadLabel({ prospect_name: 'Name pending', organization: 'Unknown' }))
      .toBe('Contact not yet identified');
    expect(displayName('Name pending', 'Unknown')).toBeNull();
  });

  it('addresses a message to the organisation when there is no person', () => {
    expect(leadShortLabel({ prospect_name: 'Name pending', organization: 'FaKafe' }))
      .toBe('FaKafe');
  });
});
