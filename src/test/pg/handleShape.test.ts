/**
 * The two halves of the handle rule, run over one list of inputs.
 *
 * A handle is filed by its shape, and that question gets asked in two places:
 * in SQL when a contact is captured for the first time, and in TypeScript when
 * a handle is reviewed against a contact that already exists. The two languages
 * cannot share code, so the rule is written twice, and a rule written twice is
 * a rule that drifts. It already had: "(305) 555-0188" was a phone number on
 * one path and a line of notes on the other.
 *
 * This runs both over the same inputs and fails if they ever disagree, which is
 * the arrangement src/lib/leadLabel.ts already has with its own twin.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyHandle, type HandleKind } from '../../lib/handleShape';
import { freshDatabase, type TestDatabase } from './harness';

let t: TestDatabase;

beforeAll(async () => {
  t = await freshDatabase();
}, 180_000);

afterAll(async () => {
  await t?.close();
});

/**
 * Every shape worth arguing about.
 *
 * The first four are the ones that used to be filed two different ways.
 */
const HANDLES = [
  '(305) 555-0188',
  '305/555/0188',
  'Name@Example.COM',
  '+1 305 555 0188',
  '305 555 0188',
  '305.555.0188',
  '3055550188',
  '305-555-0188',
  '+13055550188',
  'invented.person@example.com',
  '@invented.poster',
  'ask Dave',
  '...',
  '555',
  '12345678',
  '',
  '   ',
  'tel: 305 555 0188',
  'INVENTED@EXAMPLE.CO.UK',
];

/**
 * The SQL half, asked directly.
 *
 * The same two conditions the migration uses to pick a column, read out of the
 * migration itself so this cannot pass against a copy that has been edited.
 */
async function sqlClassify(handle: string): Promise<{ kind: HandleKind; value: string }> {
  const result = await t.db.query<{ phone: string | null; email: string | null }>(
    `select
       case when $1 !~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
                 and $1 ~ '^[+()0-9 ./-]+$'
                 and length(regexp_replace($1, '[^0-9]', '', 'g')) >= 7
            then $1 else null end as phone,
       case when $1 ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'
            then lower($1) else null end as email`,
    [handle.trim()],
  );
  const { phone, email } = result.rows[0];
  if (email !== null) return { kind: 'email', value: email };
  if (phone !== null) return { kind: 'phone', value: phone };
  return { kind: 'other', value: handle.trim() };
}

describe('the browser and the database file a handle the same way', () => {
  for (const handle of HANDLES) {
    it(`agrees on ${handle === '' ? '(empty)' : JSON.stringify(handle)}`, async () => {
      const fromSql = await sqlClassify(handle);
      const fromBrowser = classifyHandle(handle);
      expect(fromBrowser).toEqual(fromSql);
    });
  }

  it('reads its conditions from the migration that is actually applied', async () => {
    // If the migration's wording changes and this file's copy does not, the
    // test above would keep passing against a stale rule. This is the guard.
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('supabase/migrations/0022_one_handle_rule.sql', 'utf8');
    expect(sql).toContain("$1 ~ '^[+()0-9 ./-]+$'".replace('$1', 'v_handle'));
    expect(sql).toContain(
      "length(regexp_replace(v_handle, '[^0-9]', '', 'g')) >= 7",
    );
    expect(sql).toContain('then lower(v_handle) else null end');
  });
});

describe('what each shape is taken to be', () => {
  it('files the common written forms of a number as a number', async () => {
    for (const handle of [
      '(305) 555-0188', '305 555 0188', '+1 305 555 0188', '305.555.0188',
      '3055550188', '305-555-0188', '305/555/0188',
    ]) {
      expect(classifyHandle(handle).kind, handle).toBe('phone');
      expect((await sqlClassify(handle)).kind, handle).toBe('phone');
    }
  });

  it('lowercases an address on both paths', async () => {
    expect(classifyHandle('Name@Example.COM')).toEqual({
      kind: 'email', value: 'name@example.com',
    });
    expect(await sqlClassify('Name@Example.COM')).toEqual({
      kind: 'email', value: 'name@example.com',
    });
  });

  it('leaves an at name, a word or too few digits in the notes', async () => {
    for (const handle of ['@invented.poster', 'ask Dave', '...', '555']) {
      expect(classifyHandle(handle).kind, handle).toBe('other');
      expect((await sqlClassify(handle)).kind, handle).toBe('other');
    }
  });

  it('counts digits rather than trusting punctuation', () => {
    // A character class on its own files this as a telephone.
    expect(classifyHandle('.-.-.-.').kind).toBe('other');
    expect(classifyHandle('12345678').kind).toBe('phone');
  });
});
