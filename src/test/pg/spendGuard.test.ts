/**
 * The ceiling, against a real Postgres.
 *
 * WHAT THIS CAN AND CANNOT PROVE
 *
 * PGlite is one connection, so two callers cannot literally arrive at once
 * here. What is tested instead is the property that makes simultaneous callers
 * safe: a reservation counts against the limit from the moment it is made,
 * before the request it belongs to has finished. If an in-flight reservation
 * counts, then two requests in flight together cannot both fit under a ceiling
 * that only one of them fits under, whatever order they arrive in. The
 * serialisation itself is an advisory lock in the function, asserted on in
 * src/test/security.test.ts because its effect cannot be observed from a single
 * connection.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { freshDatabase, USER_A, USER_B, type TestDatabase } from './harness';

let t: TestDatabase;

beforeAll(async () => {
  t = await freshDatabase();
}, 180_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.db.exec('delete from ai_usage;');
});

const LIMIT = 1_000_000;
const RATE = 10;

async function rows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await t.db.query<T>(sql, params)).rows;
}

async function reserve(options: {
  owner?: string;
  reserveMicros?: number;
  limit?: number;
  perMinute?: number;
  token?: string | null;
  hold?: number;
} = {}): Promise<Record<string, unknown>> {
  const result = await t.db.query<{ reserve_ai_spend: Record<string, unknown> }>(
    `select reserve_ai_spend($1, 'capture', 'gpt-6.1-sol', $2, $3, $4, $5, $6)
            as reserve_ai_spend`,
    [
      options.owner ?? USER_A,
      options.reserveMicros ?? 21_000,
      options.limit ?? LIMIT,
      options.perMinute ?? RATE,
      options.token ?? null,
      options.hold ?? 120,
    ],
  );
  return result.rows[0].reserve_ai_spend;
}

async function settle(
  usageId: string,
  over: { input?: number | null; output?: number | null; cost?: number | null; error?: string | null; note?: string | null } = {},
): Promise<Record<string, unknown>> {
  const result = await t.db.query<{ settle_ai_spend: Record<string, unknown> }>(
    'select settle_ai_spend($1, $2, $3, $4, $5, $6) as settle_ai_spend',
    [
      usageId,
      over.input ?? 1461,
      over.output ?? 960,
      over.cost === undefined ? 12_522 : over.cost,
      over.error ?? null,
      over.note ?? null,
    ],
  );
  return result.rows[0].settle_ai_spend;
}

async function spend(owner = USER_A): Promise<number> {
  const [row] = await rows<{ ai_spend_recent: string }>(
    'select ai_spend_recent($1)::text as ai_spend_recent', [owner],
  );
  return Number(row.ai_spend_recent);
}

/* ================================================ the ordinary journey === */

describe('one request, reserved and settled', () => {
  it('books the worst case, then replaces it with what it really cost', async () => {
    const booked = await t.asServiceRole(() => reserve({ reserveMicros: 21_000 }));
    expect(booked.status).toBe('ok');
    expect(booked.spent).toBe(0);

    // In flight, the worst case is what counts.
    expect(await t.asServiceRole(() => spend())).toBe(21_000);

    const done = await t.asServiceRole(() => settle(booked.usage_id as string));
    expect(done.status).toBe('settled');
    expect(done.counted_micros).toBe(12_522);

    // Settled, the real figure is what counts, and the difference is given back.
    expect(await t.asServiceRole(() => spend())).toBe(12_522);

    const [row] = await rows<Record<string, unknown>>(
      `select state, input_tokens::text, output_tokens::text, cost_micros::text,
              reserved_micros::text, reserved_until
         from ai_usage`,
    );
    expect(row.state).toBe('settled');
    expect(row.cost_micros).toBe('12522');
    // The reservation figure stays, because an unknown cost falls back to it.
    expect(row.reserved_micros).toBe('21000');
    expect(row.reserved_until).toBeNull();
  });

  it('will not settle the same reservation twice', async () => {
    const booked = await t.asServiceRole(() => reserve());
    await t.asServiceRole(() => settle(booked.usage_id as string));
    const again = await t.asServiceRole(() => settle(booked.usage_id as string));
    expect(again.status).toBe('not_reserved');
  });
});

/* ========================================================== the ceiling === */

describe('the spending ceiling', () => {
  it('refuses a reservation that would cross it, and writes nothing', async () => {
    // Fill the budget with settled spend.
    const first = await t.asServiceRole(() => reserve({ reserveMicros: 990_000 }));
    await t.asServiceRole(() => settle(first.usage_id as string, { cost: 990_000 }));

    const refused = await t.asServiceRole(() => reserve({ reserveMicros: 21_000 }));
    expect(refused.status).toBe('over_cap');
    expect(refused.spent).toBe(990_000);
    expect(refused.limit).toBe(LIMIT);
    expect(refused.usage_id).toBeUndefined();

    // One row, the settled one. A refusal is not a request.
    expect(await rows('select id from ai_usage')).toHaveLength(1);
  });

  it('counts an in-flight reservation, so two together cannot both fit', async () => {
    // This is the concurrency property. The first request has not finished,
    // and the second is judged as though its worst case had already happened.
    const first = await t.asServiceRole(() => reserve({ reserveMicros: 600_000 }));
    expect(first.status).toBe('ok');

    const second = await t.asServiceRole(() => reserve({ reserveMicros: 600_000 }));
    expect(second.status).toBe('over_cap');
    expect(second.spent).toBe(600_000);
  });

  it('lets the second one through once the first settles for less', async () => {
    const first = await t.asServiceRole(() => reserve({ reserveMicros: 600_000 }));
    await t.asServiceRole(() => settle(first.usage_id as string, { cost: 12_522 }));

    const second = await t.asServiceRole(() => reserve({ reserveMicros: 600_000 }));
    expect(second.status).toBe('ok');
  });

  it('counts a settled request whose cost is unknown at its worst case', async () => {
    // The hole this closes: a request that failed on the way back was billed
    // and reported nothing. Counted as zero, unknown costs would walk straight
    // through the ceiling.
    const booked = await t.asServiceRole(() => reserve({ reserveMicros: 900_000 }));
    await t.asServiceRole(() =>
      settle(booked.usage_id as string, {
        input: null, output: null, cost: null, error: 'the model did not answer in time',
      }));

    expect(await t.asServiceRole(() => spend())).toBe(900_000);
    const refused = await t.asServiceRole(() => reserve({ reserveMicros: 200_000 }));
    expect(refused.status).toBe('over_cap');
  });

  it('allows a reservation that exactly reaches the limit', async () => {
    const booked = await t.asServiceRole(() => reserve({ reserveMicros: LIMIT }));
    expect(booked.status).toBe('ok');
    const next = await t.asServiceRole(() => reserve({ reserveMicros: 1 }));
    expect(next.status).toBe('over_cap');
  });

  it('keeps one person spend away from another', async () => {
    const mine = await t.asServiceRole(() => reserve({ reserveMicros: 990_000 }));
    await t.asServiceRole(() => settle(mine.usage_id as string, { cost: 990_000 }));

    const theirs = await t.asServiceRole(() =>
      reserve({ owner: USER_B, reserveMicros: 500_000 }));
    expect(theirs.status).toBe('ok');
    expect(theirs.spent).toBe(0);
  });

  it('frees budget as spend passes twenty four hours old', async () => {
    const booked = await t.asServiceRole(() => reserve({ reserveMicros: 990_000 }));
    await t.asServiceRole(() => settle(booked.usage_id as string, { cost: 990_000 }));
    await t.db.query(
      "update ai_usage set created_at = now() - interval '25 hours' where id = $1",
      [booked.usage_id],
    );

    expect(await t.asServiceRole(() => spend())).toBe(0);
    expect((await t.asServiceRole(() => reserve({ reserveMicros: 100_000 }))).status).toBe('ok');
  });
});

/* ====================================== reservations nobody came back for === */

describe('an abandoned reservation', () => {
  it('is settled at its worst case rather than forgotten', async () => {
    const booked = await t.asServiceRole(() => reserve({ reserveMicros: 500_000, hold: 1 }));
    await t.db.query(
      "update ai_usage set reserved_until = now() - interval '1 second' where id = $1",
      [booked.usage_id],
    );

    // The next reservation sweeps it. Pessimistic on purpose: the request may
    // well have been billed, and protecting the ceiling beats reclaiming a cent.
    const next = await t.asServiceRole(() => reserve({ reserveMicros: 1_000 }));
    expect(next.status).toBe('ok');
    expect(next.spent).toBe(500_000);

    const [swept] = await rows<Record<string, unknown>>(
      'select state, note, cost_micros from ai_usage where id = $1', [booked.usage_id],
    );
    expect(swept.state).toBe('settled');
    expect(swept.cost_micros).toBeNull();
    expect(String(swept.note)).toContain('abandoned');
  });

  it('does not sweep one that is still in flight', async () => {
    const booked = await t.asServiceRole(() => reserve({ reserveMicros: 1_000, hold: 300 }));
    await t.asServiceRole(() => reserve({ reserveMicros: 1_000, token: 'other' }));

    const [row] = await rows<{ state: string }>(
      'select state from ai_usage where id = $1', [booked.usage_id],
    );
    expect(row.state).toBe('reserved');
  });
});

/* ============================================================ the rate === */

describe('the rate limit', () => {
  it('refuses once too many requests have been made in a minute', async () => {
    for (let i = 0; i < RATE; i += 1) {
      const booked = await t.asServiceRole(() =>
        reserve({ reserveMicros: 100, token: `press-${i}` }));
      expect(booked.status).toBe('ok');
    }

    const refused = await t.asServiceRole(() => reserve({ reserveMicros: 100, token: 'one-more' }));
    expect(refused.status).toBe('rate_limited');
    expect(refused.recent).toBe(RATE);
    expect(refused.allowed).toBe(RATE);
  });

  it('counts only the last minute', async () => {
    for (let i = 0; i < RATE; i += 1) {
      await t.asServiceRole(() => reserve({ reserveMicros: 100, token: `old-${i}` }));
    }
    await t.db.exec("update ai_usage set created_at = now() - interval '2 minutes';");

    const booked = await t.asServiceRole(() => reserve({ reserveMicros: 100, token: 'fresh' }));
    expect(booked.status).toBe('ok');
  });

  it('counts refusals as nothing, since they never happened', async () => {
    // A rate limited caller that kept trying would otherwise lock itself out
    // for longer each time.
    for (let i = 0; i < RATE; i += 1) {
      await t.asServiceRole(() => reserve({ reserveMicros: 100, token: `press-${i}` }));
    }
    for (let i = 0; i < 5; i += 1) {
      await t.asServiceRole(() => reserve({ reserveMicros: 100, token: `blocked-${i}` }));
    }
    expect(await rows('select id from ai_usage')).toHaveLength(RATE);
  });

  it('is scoped to one person', async () => {
    for (let i = 0; i < RATE; i += 1) {
      await t.asServiceRole(() => reserve({ reserveMicros: 100, token: `press-${i}` }));
    }
    const theirs = await t.asServiceRole(() =>
      reserve({ owner: USER_B, reserveMicros: 100, token: 'theirs' }));
    expect(theirs.status).toBe('ok');
  });
});

/* ======================================================= the same press === */

describe('the same press arriving twice', () => {
  it('is recognised and not charged again', async () => {
    const first = await t.asServiceRole(() => reserve({ token: 'press-abc' }));
    expect(first.status).toBe('ok');

    const again = await t.asServiceRole(() => reserve({ token: 'press-abc' }));
    expect(again.status).toBe('duplicate');
    expect(again.usage_id).toBe(first.usage_id);

    expect(await rows('select id from ai_usage')).toHaveLength(1);
  });

  it('is still recognised after the first one settled', async () => {
    const first = await t.asServiceRole(() => reserve({ token: 'press-xyz' }));
    await t.asServiceRole(() => settle(first.usage_id as string));

    const again = await t.asServiceRole(() => reserve({ token: 'press-xyz' }));
    expect(again.status).toBe('duplicate');
  });

  it('lets the same token through for a different person', async () => {
    await t.asServiceRole(() => reserve({ token: 'shared' }));
    const theirs = await t.asServiceRole(() => reserve({ owner: USER_B, token: 'shared' }));
    expect(theirs.status).toBe('ok');
  });

  it('treats a missing token as a separate request each time', async () => {
    // Not ideal, and deliberately not an error: a caller with no token gets no
    // duplicate protection rather than being refused.
    await t.asServiceRole(() => reserve({ token: null }));
    const second = await t.asServiceRole(() => reserve({ token: null }));
    expect(second.status).toBe('ok');
    expect(await rows('select id from ai_usage')).toHaveLength(2);
  });
});

/* ============================================== who may touch any of it === */

describe('spend accounting belongs to the server', () => {
  it('refuses a signed in browser', async () => {
    await expect(t.asUser(USER_A, () => reserve())).rejects.toThrow(/permission denied/i);
  });

  it('refuses an anonymous caller', async () => {
    await expect(t.asAnon(() => reserve())).rejects.toThrow(/permission denied/i);
  });

  it('refuses a browser trying to settle', async () => {
    const booked = await t.asServiceRole(() => reserve());
    await expect(
      t.asUser(USER_A, () => settle(booked.usage_id as string)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a reservation with no owner, rather than booking it against nobody', async () => {
    await expect(
      t.asServiceRole(() => t.db.query(
        `select reserve_ai_spend(null, 'capture', 'm', 100, 1000, 10, null, 120)`,
      )),
    ).rejects.toThrow(/owner/i);
  });

  it('refuses a negative reservation', async () => {
    await expect(
      t.asServiceRole(() => reserve({ reserveMicros: -500 })),
    ).rejects.toThrow(/worst case/i);
  });
});
