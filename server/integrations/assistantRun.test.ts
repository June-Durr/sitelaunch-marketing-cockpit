/**
 * The gate, and the one property that matters about it.
 *
 * A blocked request must not reach the provider. That is asserted here by
 * passing in a spy for the model call and checking it was never invoked, which
 * is the only form of that claim a test can actually prove.
 *
 * No network, no database, no key. The gate is a stub whose answers are chosen
 * per test, which is the point: every branch of the real gate gets exercised
 * without spending anything.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  runAssistantTurn, type ReserveOutcome, type SettleRequest, type SpendGate,
} from './assistantRun.ts';
import { ModelError, type ModelResult } from './openai.ts';
import {
  DEFAULT_DAILY_LIMIT_MICROS, DEFAULT_MAX_PER_MINUTE, dollarsToMicros,
  estimateTokens, readLimits, reserveMicros,
} from './spendGuard.ts';

const INPUT = {
  ownerId: '11111111-1111-1111-1111-111111111111',
  operation: 'capture',
  model: 'gpt-6.1-sol',
  requestToken: 'press-1',
  reserveMicros: 21_000,
  limitMicros: DEFAULT_DAILY_LIMIT_MICROS,
  maxPerMinute: DEFAULT_MAX_PER_MINUTE,
  holdSeconds: 120,
};

function gateThat(outcome: ReserveOutcome) {
  const settled: { usageId: string; settlement: SettleRequest }[] = [];
  const reserve = vi.fn(async () => outcome);
  const settle = vi.fn(async (usageId: string, settlement: SettleRequest) => {
    settled.push({ usageId, settlement });
  });
  const gate: SpendGate = { reserve, settle };
  return { gate, reserve, settle, settled };
}

function answered(over: Partial<ModelResult> = {}): ModelResult {
  return {
    model: 'gpt-6.1-sol',
    text: '{"intent":"answer"}',
    refusal: null,
    functionCalls: [],
    usage: { inputTokens: 1461, cachedInputTokens: 0, outputTokens: 960 },
    costMicros: 12_522,
    basis: 'priced',
    truncated: null,
    ...over,
  };
}

/* ============================================ blocked means not charged === */

describe('a blocked request never reaches the provider', () => {
  const blocking: ReserveOutcome[] = [
    { status: 'over_cap', spentMicros: 995_000, limitMicros: 1_000_000 },
    { status: 'rate_limited', recent: 10, allowed: 10 },
    { status: 'duplicate' },
    { status: 'unavailable', error: 'the accounting is down' },
  ];

  for (const outcome of blocking) {
    it(`does not ask the model when the gate says ${outcome.status}`, async () => {
      const { gate, settle } = gateThat(outcome);
      const ask = vi.fn(async () => answered());

      const result = await runAssistantTurn({ gate, ask }, INPUT);

      // The assertion the whole file exists for.
      expect(ask).not.toHaveBeenCalled();
      // And nothing was settled, because nothing was reserved.
      expect(settle).not.toHaveBeenCalled();
      expect(result.kind).toBe('blocked');
    });
  }

  it('says what the limit is and that nothing was charged', async () => {
    const { gate } = gateThat({
      status: 'over_cap', spentMicros: 995_000, limitMicros: 1_000_000,
    });
    const result = await runAssistantTurn({ gate, ask: async () => answered() }, INPUT);
    if (result.kind !== 'blocked') throw new Error('expected blocked');

    expect(result.status).toBe('daily_cap');
    expect(result.message).toContain('$1.00');
    expect(result.message).toContain('nothing was charged');
    expect(result.message).toContain('ASSISTANT_DAILY_LIMIT_USD');
  });

  it('names the rate it exceeded, and says a loop may be the cause', async () => {
    const { gate } = gateThat({ status: 'rate_limited', recent: 11, allowed: 10 });
    const result = await runAssistantTurn({ gate, ask: async () => answered() }, INPUT);
    if (result.kind !== 'blocked') throw new Error('expected blocked');

    expect(result.message).toContain('11 requests in the last minute');
    expect(result.message).toContain('the limit is 10');
    expect(result.message).toContain('retrying on its own');
  });

  it('refuses rather than waving a request through when it cannot count', async () => {
    // A request that cannot be counted cannot be capped.
    const { gate } = gateThat({ status: 'unavailable', error: 'connection refused' });
    const result = await runAssistantTurn({ gate, ask: async () => answered() }, INPUT);
    if (result.kind !== 'blocked') throw new Error('expected blocked');
    expect(result.message).toContain('did not ask');
    expect(result.message).toContain('connection refused');
  });

  it('says a duplicate was not charged twice', async () => {
    const { gate } = gateThat({ status: 'duplicate' });
    const result = await runAssistantTurn({ gate, ask: async () => answered() }, INPUT);
    if (result.kind !== 'blocked') throw new Error('expected blocked');
    expect(result.message).toContain('not sent to the model');
    expect(result.message).toContain('charged twice');
  });
});

/* ====================================================== an allowed turn === */

describe('an allowed request', () => {
  const allowed: ReserveOutcome = {
    status: 'ok', usageId: 'usage-1', spentMicros: 0, limitMicros: 1_000_000,
  };

  it('asks once, and settles with the real figures', async () => {
    const { gate, settled } = gateThat(allowed);
    const ask = vi.fn(async () => answered());

    const result = await runAssistantTurn({ gate, ask }, INPUT);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('answered');
    expect(settled).toHaveLength(1);
    expect(settled[0].usageId).toBe('usage-1');
    expect(settled[0].settlement).toEqual({
      inputTokens: 1461,
      outputTokens: 960,
      // 1461 at $2 per million plus 960 at $10 per million.
      costMicros: 1461 * 2 + 960 * 10,
      error: null,
      note: null,
    });
  });

  it('prices cached input at the cached rate', async () => {
    const { gate, settled } = gateThat(allowed);
    await runAssistantTurn({
      gate,
      ask: async () => answered({
        usage: { inputTokens: 1556, cachedInputTokens: 1282, outputTokens: 293 },
      }),
    }, INPUT);

    // 274 fresh at $2, 1282 cached at $0.10, 293 out at $10. The figure the
    // real API produced on 2026-10-15 for exactly these counts.
    expect(settled[0].settlement.costMicros).toBe(274 * 2 + Math.round(1282 * 0.1) + 293 * 10);
    expect(settled[0].settlement.costMicros).toBe(3_606);
  });

  it('prices the model that was asked for, not the one the answer names', async () => {
    const { gate, settled } = gateThat(allowed);
    // A provider that resolved an alias, or renamed itself. The arithmetic must
    // not follow it: the price table is keyed on what we chose.
    await runAssistantTurn({
      gate,
      ask: async () => answered({ model: 'gpt-6-astra' }),
    }, INPUT);

    expect(settled[0].settlement.costMicros).toBe(1461 * 2 + 960 * 10);
    expect(settled[0].settlement.note).toContain('answered as gpt-6-astra');
    expect(settled[0].settlement.note).toContain('priced as gpt-6.1-sol');
  });

  it('records an unknown cost with the reason, when the model has no price', async () => {
    const { gate, settled } = gateThat(allowed);
    await runAssistantTurn({
      gate,
      ask: async () => answered({ model: 'zz-unpriced' }),
    }, { ...INPUT, model: 'zz-unpriced' });

    expect(settled[0].settlement.costMicros).toBeNull();
    expect(settled[0].settlement.note).toContain('no price on file');
  });

  it('records an unknown cost when the provider reported no usage', async () => {
    const { gate, settled } = gateThat(allowed);
    await runAssistantTurn({ gate, ask: async () => answered({ usage: null }) }, INPUT);

    expect(settled[0].settlement.inputTokens).toBeNull();
    expect(settled[0].settlement.costMicros).toBeNull();
    expect(settled[0].settlement.note).toContain('no usage figures');
  });
});

/* ======================================================== when it fails === */

describe('a request that fails', () => {
  const allowed: ReserveOutcome = {
    status: 'ok', usageId: 'usage-2', spentMicros: 0, limitMicros: 1_000_000,
  };

  it('settles the reservation anyway, so the budget is not held forever', async () => {
    const { gate, settled } = gateThat(allowed);
    const result = await runAssistantTurn({
      gate,
      ask: async () => {
        throw new ModelError('504: gateway timeout', 504, null);
      },
    }, INPUT);

    expect(result.kind).toBe('failed');
    expect(settled).toHaveLength(1);
    expect(settled[0].settlement.error).toContain('504');
    // No usage came back, so the cost is unknown rather than zero.
    expect(settled[0].settlement.costMicros).toBeNull();
  });

  it('keeps the tokens a failure did report, and prices them', async () => {
    const { gate, settled } = gateThat(allowed);
    await runAssistantTurn({
      gate,
      ask: async () => {
        throw new ModelError('400: bad request', 400, {
          inputTokens: 500, cachedInputTokens: 0, outputTokens: 0,
        });
      },
    }, INPUT);

    expect(settled[0].settlement.inputTokens).toBe(500);
    expect(settled[0].settlement.costMicros).toBe(1_000);
  });

  it('tells an empty balance apart from an ordinary failure', async () => {
    const { gate } = gateThat(allowed);
    const result = await runAssistantTurn({
      gate,
      ask: async () => {
        throw new ModelError(
          '429: insufficient_quota credit_balance_exhausted You have no credits remaining.',
          429, null,
          { organization: 'user-t4zut13ktq3petrtvb3cqcxg', project: 'proj_Wyi' },
        );
      },
    }, INPUT);

    if (result.kind !== 'failed') throw new Error('expected failed');
    expect(result.status).toBe('no_credit');
    expect(result.account?.organization).toBe('user-t4zut13ktq3petrtvb3cqcxg');
  });
});

/* ===================================================== the reservation === */

describe('how much a request books', () => {
  it('books the output ceiling, not a guess at the output', () => {
    // 1800 output tokens at $10 per million is 18000 millionths on its own.
    const micros = reserveMicros({
      model: 'gpt-6.1-sol', promptCharacters: 0, maxOutputTokens: 1800,
    });
    expect(micros).toBe(18_000);
  });

  it('books more than a measured turn actually cost', () => {
    // The real capture turn on 2026-10-15: about 5,800 characters in, 1,461
    // tokens, 960 out, $0.0125. The reservation has to cover it.
    const booked = reserveMicros({
      model: 'gpt-6.1-sol', promptCharacters: 5_800, maxOutputTokens: 1800,
    });
    expect(booked).toBeGreaterThan(12_522);
    // And not absurdly more: a dollar a day still has to buy a working day.
    expect(booked).toBeLessThan(30_000);
  });

  it('assumes no caching discount', () => {
    const fresh = reserveMicros({
      model: 'gpt-6.1-sol', promptCharacters: 3_000, maxOutputTokens: 100,
    });
    // 1000 tokens at the full $2 rate, not the $0.10 cached rate.
    expect(fresh).toBe(2_000 + 1_000);
  });

  it('books the dearest known rate for a model with no price', () => {
    const unpriced = reserveMicros({
      model: 'zz-nobody-priced-this', promptCharacters: 3_000, maxOutputTokens: 1000,
    });
    const astra = reserveMicros({
      model: 'gpt-6-astra', promptCharacters: 3_000, maxOutputTokens: 1000,
    });
    expect(unpriced).toBe(astra);
  });

  it('counts tokens pessimistically', () => {
    // Three characters per token, below the real average, so the estimate is
    // high rather than low.
    expect(estimateTokens(3_000)).toBe(1_000);
    expect(estimateTokens(0)).toBe(0);
  });
});

describe('reading the limits from configuration', () => {
  it('defaults to a dollar a day and ten a minute', () => {
    const limits = readLimits(() => null);
    expect(limits.dailyMicros).toBe(1_000_000);
    expect(limits.maxPerMinute).toBe(10);
  });

  it('takes a dollar figure', () => {
    expect(readLimits((n) => (n === 'ASSISTANT_DAILY_LIMIT_USD' ? '5' : null)).dailyMicros)
      .toBe(5_000_000);
    expect(readLimits((n) => (n === 'ASSISTANT_DAILY_LIMIT_USD' ? '$0.50' : null)).dailyMicros)
      .toBe(500_000);
  });

  it('falls back to the default rather than to no limit when it cannot parse one', () => {
    // A typo in configuration must not remove the ceiling.
    for (const bad of ['', 'lots', '-5', 'NaN', '1,000']) {
      expect(readLimits((n) => (n === 'ASSISTANT_DAILY_LIMIT_USD' ? bad : null)).dailyMicros)
        .toBe(DEFAULT_DAILY_LIMIT_MICROS);
    }
  });

  it('refuses a rate limit of zero, which would mean no limit at all in SQL', () => {
    expect(readLimits((n) => (n === 'ASSISTANT_MAX_PER_MINUTE' ? '0' : null)).maxPerMinute)
      .toBe(DEFAULT_MAX_PER_MINUTE);
  });

  it('reads dollars into millionths without floating point drift', () => {
    expect(dollarsToMicros('1')).toBe(1_000_000);
    expect(dollarsToMicros('0.03')).toBe(30_000);
    expect(dollarsToMicros('2.50')).toBe(2_500_000);
    expect(dollarsToMicros('nope')).toBeNull();
  });
});
