/**
 * The OAuth state and the token store, against a real Postgres.
 *
 * These are the rules that only a database can prove. Whether a state can be
 * spent twice is a property of one SQL statement, and a mock written to agree
 * with the statement would pass whether the statement was right or not. So the
 * migration is applied to PGlite, which is PostgreSQL itself, and the functions
 * are called the way the Edge Functions call them.
 *
 * WHAT IS NOT PROVED HERE
 *
 * That Vault encrypts what it says it encrypts. The harness stubs Vault with a
 * plain table, because Vault is a Supabase extension. What is under test is the
 * behaviour built on top of it, which is where the mistakes would be.
 *
 * Every owner, token and address below is invented.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';

import { freshDatabase, USER_A, USER_B, type TestDatabase } from './harness';

let t: TestDatabase;

beforeAll(async () => {
  t = await freshDatabase();
}, 120_000);

afterAll(async () => {
  await t?.close();
});

/** The same hash the Edge Function computes, so the stored shape is the real one. */
function hashOf(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function newState(): { state: string; hash: string } {
  const state = randomBytes(32).toString('base64url');
  return { state, hash: hashOf(state) };
}

async function rows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await t.db.query<T>(sql, params);
  return result.rows;
}

/** Call a function the way the Edge Functions do: as the service role. */
function callAsService<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return t.asServiceRole(() => rows<T>(sql, params));
}

/* ====================================== 2. the state is owner bound and one use === */

describe('an authorization state is owner bound, expiring and single use', () => {
  it('comes back with the owner it was issued to', async () => {
    const { hash } = newState();
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, hash]);

    const spent = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)',
      [hash],
    );
    expect(spent[0].calendar_oauth_consume_state).toBe(USER_A);
  });

  it('does not hand one owner state to another owner', async () => {
    const mine = newState();
    const theirs = newState();
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, mine.hash]);
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_B, theirs.hash]);

    const a = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)', [mine.hash],
    );
    const b = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)', [theirs.hash],
    );
    expect(a[0].calendar_oauth_consume_state).toBe(USER_A);
    expect(b[0].calendar_oauth_consume_state).toBe(USER_B);
  });

  /**
   * The one that matters most.
   *
   * A replayed callback is the attack this table exists to stop, and it is
   * stopped by the statement rather than by the caller: the second attempt finds
   * no row whose used_at is still null.
   */
  it('refuses the second attempt with the same state', async () => {
    const { hash } = newState();
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, hash]);

    const first = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)', [hash],
    );
    const second = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)', [hash],
    );
    const third = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)', [hash],
    );

    expect(first[0].calendar_oauth_consume_state).toBe(USER_A);
    expect(second[0].calendar_oauth_consume_state).toBeNull();
    expect(third[0].calendar_oauth_consume_state).toBeNull();
  });

  it('refuses a state that has expired', async () => {
    const { hash } = newState();
    // Issued honestly, then aged past its lifetime. Rewriting the row rather
    // than waiting ten minutes, and rewriting only the clock.
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, hash]);
    await callAsService(
      `update calendar_oauth_states
          set created_at = now() - interval '2 hours',
              expires_at = now() - interval '1 hour'
        where state_hash = $1`,
      [hash],
    );

    const spent = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)', [hash],
    );
    expect(spent[0].calendar_oauth_consume_state).toBeNull();
  });

  it('refuses a lifetime long enough to be a useful replay window', async () => {
    const { hash } = newState();
    await expect(
      callAsService('select calendar_oauth_issue_state($1, $2, 86400)', [USER_A, hash]),
    ).rejects.toThrow(/between one minute and one hour/i);
  });

  it('stores the hash and never the state itself', async () => {
    const { state, hash } = newState();
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, hash]);

    const stored = await callAsService<{ state_hash: string }>(
      'select state_hash from calendar_oauth_states where state_hash = $1', [hash],
    );
    expect(stored[0].state_hash).toBe(hash);
    expect(stored[0].state_hash).not.toBe(state);

    // And a hash is the only thing the column will accept.
    await expect(
      callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, state]),
    ).rejects.toThrow(/state_hash_is_a_sha256/i);
  });

  it('drops the states of an owner whose account is deleted', async () => {
    const { hash } = newState();
    const gone = '33333333-3333-3333-3333-333333333333';
    await t.db.query('insert into auth.users (id, email) values ($1, $2)', [
      gone, 'gone@example.test',
    ]);
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [gone, hash]);
    await t.db.query('delete from auth.users where id = $1', [gone]);

    const left = await callAsService(
      'select state_hash from calendar_oauth_states where state_hash = $1', [hash],
    );
    expect(left).toEqual([]);
  });
});

/* ============================================ 3. a forged callback is refused === */

describe('a forged or replayed callback gets nowhere', () => {
  it('refuses a state nobody ever issued', async () => {
    const forged = hashOf('a value an attacker made up');
    const spent = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)', [forged],
    );
    expect(spent[0].calendar_oauth_consume_state).toBeNull();
  });

  /**
   * Forged, replayed, expired and never issued all answer identically.
   *
   * Not laziness. Distinguishing them would tell whoever is probing which of
   * their guesses was once a real authorization, and the only honest answer to
   * all four is "no".
   */
  it('answers forged, spent and expired the same way', async () => {
    const spentState = newState();
    await callAsService(
      'select calendar_oauth_issue_state($1, $2, 600)', [USER_A, spentState.hash],
    );
    await callAsService('select calendar_oauth_consume_state($1)', [spentState.hash]);

    const expiredState = newState();
    await callAsService(
      'select calendar_oauth_issue_state($1, $2, 600)', [USER_A, expiredState.hash],
    );
    await callAsService(
      `update calendar_oauth_states
          set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        where state_hash = $1`,
      [expiredState.hash],
    );

    const answers: (string | null)[] = [];
    for (const hash of [hashOf('forged'), spentState.hash, expiredState.hash]) {
      const result = await callAsService<{ calendar_oauth_consume_state: string | null }>(
        'select calendar_oauth_consume_state($1)', [hash],
      );
      answers.push(result[0].calendar_oauth_consume_state);
    }
    expect(answers).toEqual([null, null, null]);
  });

  it('is not callable at all by a signed in person, let alone an anonymous one', async () => {
    const { hash } = newState();
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, hash]);

    // Even the owner of the state cannot spend it from a browser session. The
    // callback runs server side as the service role, and that is the only way in.
    await expect(
      t.asUser(USER_A, () => rows('select calendar_oauth_consume_state($1)', [hash])),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      t.asAnon(() => rows('select calendar_oauth_consume_state($1)', [hash])),
    ).rejects.toThrow(/permission denied/i);

    // And the state is still unspent, so a real callback can still complete.
    const spent = await callAsService<{ calendar_oauth_consume_state: string | null }>(
      'select calendar_oauth_consume_state($1)', [hash],
    );
    expect(spent[0].calendar_oauth_consume_state).toBe(USER_A);
  });

  it('keeps the states table unreadable by every browser role', async () => {
    for (const as of [
      () => t.asUser(USER_A, () => rows('select * from calendar_oauth_states')),
      () => t.asUser(USER_B, () => rows('select * from calendar_oauth_states')),
      () => t.asAnon(() => rows('select * from calendar_oauth_states')),
    ]) {
      await expect(as()).rejects.toThrow(/permission denied/i);
    }
  });
});

/* ================================= 4. tokens never reach a readable place === */

describe('a refresh token is reachable by nothing a browser can be', () => {
  it('stores one, and reads it back only as the service role', async () => {
    const outcome = await callAsService<{ calendar_oauth_store_token: string }>(
      'select calendar_oauth_store_token($1, $2)', [USER_A, 'not-a-real-refresh-token'],
    );
    expect(outcome[0].calendar_oauth_store_token).toBe('stored');

    const read = await callAsService<{ calendar_oauth_read_token: string | null }>(
      'select calendar_oauth_read_token($1)', [USER_A],
    );
    expect(read[0].calendar_oauth_read_token).toBe('not-a-real-refresh-token');
  });

  it('refuses to let a signed in person read their own token, or anybody else', async () => {
    await expect(
      t.asUser(USER_A, () => rows('select calendar_oauth_read_token($1)', [USER_A])),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      t.asUser(USER_B, () => rows('select calendar_oauth_read_token($1)', [USER_A])),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      t.asAnon(() => rows('select calendar_oauth_read_token($1)', [USER_A])),
    ).rejects.toThrow(/permission denied/i);
  });

  it('keeps no token on the table a browser might one day be granted', async () => {
    const columns = await rows<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'calendar_oauth_tokens'
        order by column_name`,
    );
    expect(columns.map((c) => c.column_name))
      .toEqual(['created_at', 'owner_id', 'updated_at', 'vault_secret_id']);
  });

  it('puts nothing on integration_connections, which the browser does read', async () => {
    const columns = await rows<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'integration_connections'`,
    );
    const names = columns.map((c) => c.column_name).join(' ');
    for (const forbidden of ['token', 'secret', 'password', 'key']) {
      expect(names, `integration_connections has a ${forbidden} column`)
        .not.toContain(forbidden);
    }
  });

  /**
   * Reconnecting without a new token must not break a working connection.
   *
   * Google often returns an access token and no refresh token on a
   * reauthorization. Writing that null through would leave a connection that can
   * never refresh again, and the failure would not show up until the next
   * scheduled sync.
   */
  it('keeps the stored token when Google sends none', async () => {
    await callAsService('select calendar_oauth_store_token($1, $2)', [USER_B, 'first-token']);

    const again = await callAsService<{ calendar_oauth_store_token: string }>(
      'select calendar_oauth_store_token($1, $2)', [USER_B, null],
    );
    expect(again[0].calendar_oauth_store_token).toBe('kept_existing');

    const read = await callAsService<{ calendar_oauth_read_token: string | null }>(
      'select calendar_oauth_read_token($1)', [USER_B],
    );
    expect(read[0].calendar_oauth_read_token).toBe('first-token');
  });

  it('says no_token when there is nothing on either side', async () => {
    const fresh = '44444444-4444-4444-4444-444444444444';
    await t.db.query('insert into auth.users (id, email) values ($1, $2)', [
      fresh, 'fresh@example.test',
    ]);
    const outcome = await callAsService<{ calendar_oauth_store_token: string }>(
      'select calendar_oauth_store_token($1, $2)', [fresh, null],
    );
    expect(outcome[0].calendar_oauth_store_token).toBe('no_token');
  });

  it('replaces rather than accumulating when somebody reconnects', async () => {
    await callAsService('select calendar_oauth_store_token($1, $2)', [USER_B, 'second-token']);
    const outcome = await callAsService<{ calendar_oauth_store_token: string }>(
      'select calendar_oauth_store_token($1, $2)', [USER_B, 'third-token'],
    );
    expect(outcome[0].calendar_oauth_store_token).toBe('replaced');

    const held = await callAsService<{ count: string }>(
      'select count(*)::text as count from calendar_oauth_tokens where owner_id = $1',
      [USER_B],
    );
    expect(held[0].count).toBe('1');

    const read = await callAsService<{ calendar_oauth_read_token: string | null }>(
      'select calendar_oauth_read_token($1)', [USER_B],
    );
    expect(read[0].calendar_oauth_read_token).toBe('third-token');
  });

  /* ----------------------------- 12. disconnecting removes the token only --- */

  it('hands the token back once on disconnect, then has nothing left', async () => {
    const owner = '55555555-5555-5555-5555-555555555555';
    await t.db.query('insert into auth.users (id, email) values ($1, $2)', [
      owner, 'leaving@example.test',
    ]);
    await callAsService('select calendar_oauth_store_token($1, $2)', [owner, 'going-token']);

    const forgotten = await callAsService<{ calendar_oauth_forget_token: string | null }>(
      'select calendar_oauth_forget_token($1)', [owner],
    );
    // Returned exactly once, and the only legitimate use is telling Google.
    expect(forgotten[0].calendar_oauth_forget_token).toBe('going-token');

    const again = await callAsService<{ calendar_oauth_forget_token: string | null }>(
      'select calendar_oauth_forget_token($1)', [owner],
    );
    expect(again[0].calendar_oauth_forget_token).toBeNull();

    const read = await callAsService<{ calendar_oauth_read_token: string | null }>(
      'select calendar_oauth_read_token($1)', [owner],
    );
    expect(read[0].calendar_oauth_read_token).toBeNull();
  });

  it('removes the Vault secret as well, not just the row pointing at it', async () => {
    const owner = '66666666-6666-6666-6666-666666666666';
    await t.db.query('insert into auth.users (id, email) values ($1, $2)', [
      owner, 'tidy@example.test',
    ]);
    await callAsService('select calendar_oauth_store_token($1, $2)', [owner, 'tidy-token']);

    const before = await rows<{ count: string }>(
      "select count(*)::text as count from vault.secrets where secret = 'tidy-token'",
    );
    expect(before[0].count).toBe('1');

    await callAsService('select calendar_oauth_forget_token($1)', [owner]);

    const after = await rows<{ count: string }>(
      "select count(*)::text as count from vault.secrets where secret = 'tidy-token'",
    );
    expect(after[0].count).toBe('0');
  });

  it('leaves every task and its event ids exactly where they were', async () => {
    /**
     * Disconnecting is not a deletion.
     *
     * There is no statement anywhere in this migration that touches tasks, so
     * the external event ids survive a disconnect. Somebody may have planned
     * their week around those entries, and removing them because a connection
     * ended is not this app's decision.
     */
    const sql = await rows<{ prosrc: string }>(
      `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'calendar_oauth%'`,
    );
    const everything = sql.map((r) => r.prosrc).join('\n').toLowerCase();
    expect(everything).not.toContain('tasks');
    expect(everything).not.toContain('external_event_id');
  });
});

/* ======================================= which owners the sweep will walk === */

describe('the scheduled sweep is driven by who actually holds a token', () => {
  it('lists every connected owner and nobody else', async () => {
    const owner = '77777777-7777-7777-7777-777777777777';
    await t.db.query('insert into auth.users (id, email) values ($1, $2)', [
      owner, 'sweep@example.test',
    ]);
    await callAsService('select calendar_oauth_store_token($1, $2)', [owner, 'sweep-token']);

    const listed = await callAsService<{ owner_id: string }>(
      'select owner_id from calendar_oauth_owners()',
    );
    const ids = listed.map((r) => r.owner_id);
    expect(ids).toContain(owner);
    // No fixed owner id anywhere: the list is the token table.
    const held = await rows<{ owner_id: string }>(
      'select owner_id from calendar_oauth_tokens',
    );
    expect(ids.sort()).toEqual(held.map((r) => r.owner_id).sort());
  });

  it('is not something a browser can ask for', async () => {
    await expect(
      t.asUser(USER_A, () => rows('select owner_id from calendar_oauth_owners()')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('forgets an owner once they disconnect', async () => {
    const owner = '88888888-8888-8888-8888-888888888888';
    await t.db.query('insert into auth.users (id, email) values ($1, $2)', [
      owner, 'bye@example.test',
    ]);
    await callAsService('select calendar_oauth_store_token($1, $2)', [owner, 'bye-token']);
    await callAsService('select calendar_oauth_forget_token($1)', [owner]);

    const listed = await callAsService<{ owner_id: string }>(
      'select owner_id from calendar_oauth_owners()',
    );
    expect(listed.map((r) => r.owner_id)).not.toContain(owner);
  });
});

/* ------------------------------------------------------------ housekeeping --- */

describe('spent and expired states do not pile up forever', () => {
  it('prunes the ones that are past use and leaves the live ones', async () => {
    const live = newState();
    const stale = newState();
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, live.hash]);
    await callAsService('select calendar_oauth_issue_state($1, $2, 600)', [USER_A, stale.hash]);
    await callAsService(
      `update calendar_oauth_states
          set created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours'
        where state_hash = $1`,
      [stale.hash],
    );

    await callAsService('select calendar_oauth_prune_states(600)');

    const left = await callAsService<{ state_hash: string }>(
      'select state_hash from calendar_oauth_states',
    );
    const hashes = left.map((r) => r.state_hash);
    expect(hashes).toContain(live.hash);
    expect(hashes).not.toContain(stale.hash);
  });
});
