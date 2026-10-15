/**
 * One turn, with the gate in front of the money.
 *
 * This exists so that "a blocked request never reaches the provider" is a
 * property a test can prove rather than a sentence in a comment. The model call
 * arrives as a function this never invokes unless the gate said yes, and the
 * test passes in a spy.
 *
 * WHAT IT GUARANTEES
 *
 *   the gate refuses   ask is not called, nothing is settled, nothing is charged
 *   the gate allows    ask is called once, and the reservation is settled either
 *                      way, including when ask throws
 *
 * WHY THE PRICE COMES OFF THE REQUESTED MODEL
 *
 * The response says which model answered, and that is the provider describing
 * itself. It goes in the record as a note when it differs from what was asked
 * for, and the arithmetic uses the id we chose, which is the one the price table
 * is keyed on and the one the configuration decided. A provider that renamed
 * itself mid-flight cannot change what a request is priced at.
 */

import {
  isOutOfCredit, ModelError, priceUsage, type CostBasis, type ModelResult,
} from './openai.ts';
import { capMessage, duplicateMessage, rateMessage } from './spendGuard.ts';

/* ---------------------------------------------------------------- the gate --- */

export interface ReserveRequest {
  ownerId: string;
  operation: string;
  model: string;
  reserveMicros: number;
  limitMicros: number;
  maxPerMinute: number;
  requestToken: string | null;
  holdSeconds: number;
}

export type ReserveOutcome =
  | { status: 'ok'; usageId: string; spentMicros: number; limitMicros: number }
  | { status: 'duplicate' }
  | { status: 'rate_limited'; recent: number; allowed: number }
  | { status: 'over_cap'; spentMicros: number; limitMicros: number }
  | { status: 'unavailable'; error: string };

export interface SettleRequest {
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  error: string | null;
  note: string | null;
}

export interface SpendGate {
  reserve(request: ReserveRequest): Promise<ReserveOutcome>;
  settle(usageId: string, settlement: SettleRequest): Promise<void>;
}

/* --------------------------------------------------------------- the turn --- */

export type TurnOutcome =
  | {
      kind: 'answered';
      result: ModelResult;
      /** What the record says it cost, priced from the model we asked for. */
      costMicros: number | null;
      basis: CostBasis;
      usageId: string;
    }
  | {
      kind: 'blocked';
      status: 'daily_cap' | 'rate_limited' | 'duplicate' | 'unavailable';
      message: string;
    }
  | {
      kind: 'failed';
      status: 'failed' | 'no_credit';
      message: string;
      /** Set when the provider said which account it was charging. */
      account: { organization: string | null; project: string | null } | null;
    };

export interface RunInput {
  ownerId: string;
  operation: string;
  model: string;
  requestToken: string | null;
  reserveMicros: number;
  limitMicros: number;
  maxPerMinute: number;
  holdSeconds: number;
}

/** Why a cost is unknown, in words for the usage row's note. */
function basisNote(basis: CostBasis, model: string): string | null {
  if (basis === 'priced') return null;
  if (basis === 'no_price') {
    return `no price on file for ${model}, so this request is counted but not costed`;
  }
  return 'the provider reported no usage figures for this request';
}

export async function runAssistantTurn(
  deps: { gate: SpendGate; ask: () => Promise<ModelResult> },
  input: RunInput,
): Promise<TurnOutcome> {
  const reserved = await deps.gate.reserve({
    ownerId: input.ownerId,
    operation: input.operation,
    model: input.model,
    reserveMicros: input.reserveMicros,
    limitMicros: input.limitMicros,
    maxPerMinute: input.maxPerMinute,
    requestToken: input.requestToken,
    holdSeconds: input.holdSeconds,
  });

  // Every branch here returns. Nothing below this point runs for a request that
  // was not reserved, which is what makes "blocked means not charged" true.
  if (reserved.status === 'over_cap') {
    return {
      kind: 'blocked',
      status: 'daily_cap',
      message: capMessage(reserved.spentMicros, reserved.limitMicros),
    };
  }
  if (reserved.status === 'rate_limited') {
    return {
      kind: 'blocked',
      status: 'rate_limited',
      message: rateMessage(reserved.recent, reserved.allowed),
    };
  }
  if (reserved.status === 'duplicate') {
    return { kind: 'blocked', status: 'duplicate', message: duplicateMessage() };
  }
  if (reserved.status === 'unavailable') {
    /*
     * The accounting itself is unreachable.
     *
     * Refused rather than waved through. A request that cannot be counted is a
     * request that cannot be capped, and an uncapped assistant is the thing
     * this whole file exists to prevent.
     */
    return {
      kind: 'blocked',
      status: 'unavailable',
      message:
        'The assistant could not check its spending limit, so it did not ask '
        + `the model. Nothing was charged. (${reserved.error})`,
    };
  }

  const { usageId } = reserved;

  try {
    const result = await deps.ask();
    const { costMicros, basis } = priceUsage(input.model, result.usage);

    // The provider describing itself goes in the note, never into the price.
    const renamed = result.model !== input.model
      ? `the provider answered as ${result.model}; priced as ${input.model}`
      : null;
    const note = [renamed, basisNote(basis, input.model)]
      .filter((part): part is string => part !== null)
      .join('; ');

    await deps.gate.settle(usageId, {
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      costMicros,
      error: null,
      note: note === '' ? null : note,
    });

    return { kind: 'answered', result, costMicros, basis, usageId };
  } catch (error) {
    const problem = error instanceof ModelError ? error : null;
    const message = problem ? problem.message : String(error);
    const usage = problem?.usage ?? null;
    const { costMicros, basis } = priceUsage(input.model, usage);

    // Settled even though it failed. A failed request may well have been
    // billed, and an unsettled reservation would hold the budget anyway.
    await deps.gate.settle(usageId, {
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costMicros,
      error: message,
      note: basis === 'no_usage' ? null : basisNote(basis, input.model),
    });

    return {
      kind: 'failed',
      status: isOutOfCredit(error) ? 'no_credit' : 'failed',
      message,
      account: problem?.account ?? null,
    };
  }
}
