/**
 * The browser-local to Supabase import, run against a real Postgres.
 *
 * This is the one-time move off browser-local storage, so the thing worth proving
 * is not that the code runs but that the data arrives intact: every row, owned by
 * the right account, with every link between rows still pointing where it did.
 *
 * The seed dataset is the honest input here. Its ids are readable strings like
 * "acc-instagram-0001", which browser-local mode accepts and Postgres does not,
 * so it exercises the id rewrite rather than tiptoeing around it.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildSeedDataset } from '../../data/seed';
import { buildIdMap, forImport } from '../../data/supabaseRepository';
import { IMPORT_ORDER } from '../../data/repository';
import { TABLE_TO_COLLECTION } from '../../lib/backup';
import { freshDatabase, USER_A, USER_B, type TestDatabase } from './harness';
import type { Dataset } from '../../types/domain';

let t: TestDatabase;

beforeEach(async () => {
  t = await freshDatabase();
});

afterEach(async () => {
  await t.close();
});

/** Insert one row, naming only the columns the row actually carries. */
async function insertRow(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  await t.db.query(
    `insert into ${table} (${keys.join(', ')}) values (${placeholders.join(', ')})`,
    Object.values(row),
  );
}

/**
 * What the adapter does, using the adapter's own functions: rewrite the ids once,
 * then write the tables in the declared order. Only the transport differs.
 */
async function importAs(userId: string, data: Dataset) {
  const idMap = buildIdMap(data);
  await t.asUser(userId, async () => {
    for (const table of IMPORT_ORDER) {
      const rows = (data[TABLE_TO_COLLECTION[table]] ?? []) as unknown as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        await insertRow(table, forImport(table, row, idMap));
      }
    }
  });
  return idMap;
}

async function count(table: string, userId: string): Promise<number> {
  return t.asUser(userId, async () => {
    const r = await t.db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return r.rows[0].n;
  });
}

describe('importing a browser-local dataset', () => {
  it('writes every row of every table', async () => {
    const data = buildSeedDataset();
    await importAs(USER_A, data);

    for (const table of IMPORT_ORDER) {
      const expected = (data[TABLE_TO_COLLECTION[table]] ?? []).length;
      expect(await count(table, USER_A), `${table} row count`).toBe(expected);
    }
  });

  it('stamps every row with the importing account, without being told to', async () => {
    // owner_id is never sent by the importer. If the column default and the RLS
    // policy did not agree, these rows would either be rejected or land unowned.
    await importAs(USER_A, buildSeedDataset());

    for (const table of IMPORT_ORDER) {
      const wrong = await t.asUser(USER_A, async () => {
        const r = await t.db.query<{ n: number }>(
          `select count(*)::int as n from ${table} where owner_id is distinct from $1`,
          [USER_A],
        );
        return r.rows[0].n;
      });
      expect(wrong, `${table} rows owned by someone else`).toBe(0);
    }
  });

  it('keeps the link between a snapshot and the post it measures', async () => {
    const data = buildSeedDataset();
    const idMap = await importAs(USER_A, data);

    const original = data.snapshots[0];
    const expectedContentId =
      idMap.get(original.content_item_id) ?? original.content_item_id;

    const row = await t.asUser(USER_A, async () => {
      const r = await t.db.query<{ content_item_id: string; title: string }>(
        `select ps.content_item_id, ci.title
           from performance_snapshots ps
           join content_items ci on ci.id = ps.content_item_id
          where ps.id = $1`,
        [idMap.get(original.id) ?? original.id],
      );
      return r.rows[0];
    });

    expect(row.content_item_id).toBe(expectedContentId);
    const expectedTitle = data.contentItems.find(
      (c) => c.id === original.content_item_id,
    )?.title;
    expect(row.title).toBe(expectedTitle);
  });

  it('keeps a cross-post pair in the same group', async () => {
    // Two posts sharing cross_post_group_id have to keep sharing it afterwards.
    // A rewrite that gave each row its own new group id would lose the pairing
    // silently, since both rows would still import.
    const data = buildSeedDataset();
    await importAs(USER_A, data);

    const groups = await t.asUser(USER_A, async () => {
      const r = await t.db.query<{ cross_post_group_id: string; n: number }>(
        `select cross_post_group_id, count(*)::int as n
           from content_items
          where cross_post_group_id is not null
          group by cross_post_group_id`,
      );
      return r.rows;
    });

    const expectedPairs = new Map<string, number>();
    for (const item of data.contentItems) {
      if (!item.cross_post_group_id) continue;
      expectedPairs.set(
        item.cross_post_group_id,
        (expectedPairs.get(item.cross_post_group_id) ?? 0) + 1,
      );
    }

    expect(groups.length).toBe(expectedPairs.size);
    expect(groups.map((g) => g.n).sort()).toEqual([...expectedPairs.values()].sort());
  });

  it('leaves the imported rows invisible to another account', async () => {
    await importAs(USER_A, buildSeedDataset());

    for (const table of IMPORT_ORDER) {
      expect(await count(table, USER_B), `${table} visible to another user`).toBe(0);
    }
  });

  it('leaves the imported rows unreadable without signing in', async () => {
    await importAs(USER_A, buildSeedDataset());

    for (const table of IMPORT_ORDER) {
      const visible = await t.asAnon(async () => {
        try {
          const r = await t.db.query<{ n: number }>(
            `select count(*)::int as n from ${table}`,
          );
          return r.rows[0].n;
        } catch {
          // A refusal is at least as good an answer as an empty result.
          return 0;
        }
      });
      expect(visible, `${table} readable anonymously`).toBe(0);
    }
  });
});

describe('the id rewrite', () => {
  it('rewrites the readable seed ids and nothing else', async () => {
    const data = buildSeedDataset();
    const idMap = buildIdMap(data);

    // Every seed id is a readable string, so all of them need rewriting.
    expect(idMap.size).toBeGreaterThan(0);
    for (const [oldId, newId] of idMap) {
      expect(oldId).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(newId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    }
  });

  it('leaves ids alone when they are already uuids', () => {
    const data = buildSeedDataset();
    const uuid = '3f1c9b52-2a7e-4c1d-9f0b-8d2e5a6c7b41';
    data.accounts = [{ ...data.accounts[0], id: uuid }];
    data.contentItems = [];
    data.snapshots = [];
    data.traffic = [];
    data.leads = [];
    data.tasks = [];
    data.recommendations = [];
    data.activityEvents = [];

    expect(buildIdMap(data).size).toBe(0);
  });

  it('never sends owner_id, even if the backup carries one', () => {
    const row = { id: 'acc-1', owner_id: USER_B, handle: '@x' };
    const out = forImport('accounts', row, buildIdMap(buildSeedDataset()));
    expect('owner_id' in out).toBe(false);
  });
});
