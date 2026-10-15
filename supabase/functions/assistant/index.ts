/**
 * The one place a model request happens.
 *
 * A signed in person sends what they typed, the conversation so far, and the
 * records their own Cockpit is already showing. This builds the prompt, asks the
 * model once, checks the answer, records what it cost, and returns a proposal.
 *
 * WHAT IT WILL NOT DO
 *
 * Write anything. Not a lead, not an activity, not a draft, not a task. Every
 * write in this feature happens afterwards, from the browser, through the same
 * database functions a button press uses, under row level security, with the
 * same idempotency tokens and the same Undo. A model cannot reach them from
 * here, which is deliberate: the person approves the record, and the approval is
 * the thing that makes it true.
 *
 * The one exception is ai_usage, which is written with the service role because
 * its policy gives the browser read and nothing else. A browser that could write
 * its own usage rows could understate what it had spent.
 *
 * WHY THE CONTEXT COMES FROM THE BROWSER
 *
 * It is the person's own data, read through their own session under row level
 * security, and it is exactly what they are looking at on screen. Re-reading it
 * here would be a second round trip to get the same rows, and would let the
 * answer disagree with the screen. What this does not do is trust an owner id
 * from the body: the owner is the verified session, every time, and that is what
 * the usage row is stamped with.
 *
 * WHAT NEVER LEAVES
 *
 * OPENAI_API_KEY. It is read from the environment, handed to one adapter call
 * and never logged, returned or put in an error. The response carries a
 * proposal, a model name, a token count and a cost.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

import { sanitizeError, safeLog } from '../../../server/integrations/sanitize.ts';
import { requireUser } from '../../../server/integrations/requestAuth.ts';
import {
  askModel, chooseModel, type AssistantOperation,
} from '../../../server/integrations/openai.ts';
import {
  runAssistantTurn, type ReserveRequest, type ReserveOutcome, type SettleRequest,
  type SpendGate,
} from '../../../server/integrations/assistantRun.ts';
import { readLimits, reserveMicros } from '../../../server/integrations/spendGuard.ts';
import {
  buildInput, buildInstructions, REPLY_SCHEMA, type AssistantContext, type DraftBrief,
  type HistoryBrief, type LeadBrief,
} from '../../../server/integrations/assistantContract.ts';
import { readProposal, unparsableProposal } from '../../../server/integrations/assistantReply.ts';

function env(name: string): string | null {
  const value = Deno.env.get(name);
  return value === undefined || value.trim() === '' ? null : value;
}

/**
 * The model key, under either spelling of its name.
 *
 * The documented name is OPENAI_API_KEY. The dashboard will accept
 * OPENAI-API-KEY, hyphens and all, and somebody typing a secret name by hand
 * reaches for the hyphen about as often as the underscore. A key that is set
 * and invisible to the function looks exactly like a feature that does not
 * work, so both names are read and the one that answered is logged by name.
 *
 * The value is never logged, returned or interpolated into anything.
 */
function modelKey(): { key: string; from: string } | null {
  for (const name of ['OPENAI_API_KEY', 'OPENAI-API-KEY']) {
    const key = env(name);
    if (key) return { key, from: name };
  }
  return null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
  return response;
}

/* ------------------------------------------------------------ the request --- */

/**
 * How much of anything the browser may send.
 *
 * Not a security boundary: it is the same person's own data either way. It is a
 * cost and latency boundary. An unbounded index would quietly turn a one cent
 * request into a fifty cent one, and the person would find out on the bill.
 */
const LIMITS = {
  turns: 12,
  message: 6000,
  index: 120,
  history: 24,
  drafts: 6,
  dueNow: 20,
  candidates: 6,
};

function str(value: unknown, limit = 300): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, limit);
}

function must(value: unknown, fallback: string, limit = 300): string {
  return str(value, limit) ?? fallback;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function readLead(raw: unknown): LeadBrief | null {
  if (raw === null || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id, 64);
  if (!id) return null;
  return {
    id,
    label: must(row.label, 'Name not known'),
    organization: str(row.organization),
    stage: must(row.stage, 'unknown', 40),
    channel: str(row.channel, 60),
    nextAction: str(row.nextAction),
    nextActionDate: str(row.nextActionDate, 10),
    followUpMode: must(row.followUpMode, 'auto', 20),
    lastTouchOn: str(row.lastTouchOn, 10),
    lastTouchBasis: must(row.lastTouchBasis, 'none', 20),
  };
}

function readLeads(raw: unknown, limit: number): LeadBrief[] {
  const out: LeadBrief[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= limit) break;
    const lead = readLead(item);
    if (lead) out.push(lead);
  }
  return out;
}

function readHistory(raw: unknown): HistoryBrief[] {
  const out: HistoryBrief[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= LIMITS.history) break;
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    out.push({
      on: must(row.on, 'date not known', 10),
      type: must(row.type, 'contact', 40),
      title: must(row.title, 'contact', 200),
      channel: str(row.channel, 60),
      message: str(row.message, 1200),
      outcome: str(row.outcome, 300),
      reversed: row.reversed === true,
    });
  }
  return out;
}

function readDrafts(raw: unknown): DraftBrief[] {
  const out: DraftBrief[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= LIMITS.drafts) break;
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = str(row.id, 64);
    const body = str(row.body, 1200);
    if (!id || !body) continue;
    out.push({
      id,
      channel: str(row.channel, 60),
      status: must(row.status, 'draft', 20),
      body,
      createdOn: must(row.createdOn, 'date not known', 10),
    });
  }
  return out;
}

function readContext(raw: unknown): AssistantContext {
  const row = (raw === null || typeof raw !== 'object' ? {} : raw) as Record<string, unknown>;
  const counts = (row.counts === null || typeof row.counts !== 'object'
    ? {}
    : row.counts) as Record<string, unknown>;

  const dueNow: AssistantContext['dueNow'] = [];
  for (const item of Array.isArray(row.dueNow) ? row.dueNow : []) {
    if (dueNow.length >= LIMITS.dueNow) break;
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = str(entry.id, 64);
    if (!id) continue;
    dueNow.push({
      id,
      label: must(entry.label, 'a contact'),
      dueDate: must(entry.dueDate, 'date not known', 10),
      title: must(entry.title, 'follow up', 200),
    });
  }

  const index = readLeads(row.index, LIMITS.index);

  return {
    // The browser's own day, which is the day the person is living in. The
    // server's clock could be a day off either side of midnight for them.
    today: must(row.today, new Date().toISOString().slice(0, 10), 10),
    screenName: must(row.screenName, 'the Cockpit', 80),
    focus: readLead(row.focus),
    candidates: readLeads(row.candidates, LIMITS.candidates),
    index,
    indexTruncated: row.indexTruncated === true || index.length >= LIMITS.index,
    history: readHistory(row.history),
    drafts: readDrafts(row.drafts),
    dueNow,
    counts: {
      leads: num(counts.leads),
      openFollowUps: num(counts.openFollowUps),
      overdue: num(counts.overdue),
    },
  };
}

function readTurns(raw: unknown): { role: 'user' | 'assistant'; content: string }[] {
  const all: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const content = str(row.content, LIMITS.message);
    if (!content) continue;
    all.push({ role: row.role === 'assistant' ? 'assistant' : 'user', content });
  }
  // The most recent turns, because those are the ones the answer depends on.
  return all.slice(-LIMITS.turns);
}

const OPERATIONS: AssistantOperation[] = ['capture', 'brief', 'draft'];

/**
 * The output ceiling for one turn.
 *
 * Named because two things depend on it agreeing: the request that caps the
 * model, and the reservation that books what that cap could cost.
 */
const MAX_OUTPUT_TOKENS = 1800;

/* ------------------------------------------------------------- the handler --- */

/**
 * The ceiling, as the function sees it.
 *
 * Two database calls, both with the service role, because spend accounting is
 * the server's business alone: ai_usage gives a browser read and nothing else,
 * and migration 0019 grants these two functions to service_role only.
 *
 * A reservation that cannot be made is reported as 'unavailable' rather than
 * thrown, because the orchestrator treats that as a refusal. A request that
 * cannot be counted must not be allowed to spend.
 */
function spendGate(client: ReturnType<typeof createClient>): SpendGate {
  return {
    async reserve(request: ReserveRequest): Promise<ReserveOutcome> {
      const { data, error } = await client.rpc('reserve_ai_spend', {
        p_owner: request.ownerId,
        p_operation: request.operation,
        p_model: request.model,
        p_reserve_micros: request.reserveMicros,
        p_limit_micros: request.limitMicros,
        p_max_per_minute: request.maxPerMinute,
        p_request_token: request.requestToken,
        p_hold_seconds: request.holdSeconds,
      });

      if (error) {
        safeLog('assistant: could not reserve spend', sanitizeError(error));
        return { status: 'unavailable', error: sanitizeError(error) };
      }

      const body = (data ?? {}) as Record<string, unknown>;
      const number = (value: unknown): number =>
        typeof value === 'number' ? value : Number(value ?? 0);

      switch (body.status) {
        case 'ok':
          return {
            status: 'ok',
            usageId: String(body.usage_id),
            spentMicros: number(body.spent),
            limitMicros: number(body.limit),
          };
        case 'over_cap':
          return {
            status: 'over_cap',
            spentMicros: number(body.spent),
            limitMicros: number(body.limit),
          };
        case 'rate_limited':
          return {
            status: 'rate_limited',
            recent: number(body.recent),
            allowed: number(body.allowed),
          };
        case 'duplicate':
          return { status: 'duplicate' };
        default:
          return { status: 'unavailable', error: 'the spending check gave no answer' };
      }
    },

    async settle(usageId: string, settlement: SettleRequest): Promise<void> {
      const { error } = await client.rpc('settle_ai_spend', {
        p_usage_id: usageId,
        p_input: settlement.inputTokens,
        p_output: settlement.outputTokens,
        p_cost: settlement.costMicros,
        p_error: settlement.error,
        p_note: settlement.note,
      });
      if (error) {
        /*
         * A reservation that will not settle is not fatal to the answer, and it
         * is not free either: it holds its worst case until it expires, and the
         * sweep in reserve_ai_spend then keeps that figure. Erring towards
         * holding budget is the right direction for a ceiling.
         */
        safeLog('assistant: could not settle usage', sanitizeError(error));
      }
    },
  };
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    const response = new Response(null, { status: 204 });
    for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
    return response;
  }
  if (request.method !== 'POST') return json({ status: 'bad_method', error: 'Use POST' }, 405);

  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = env('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ status: 'not_configured', error: 'The function is not configured.' }, 500);
  }

  const verifyJwt = async (token: string): Promise<string | null> => {
    try {
      const anon = createClient(supabaseUrl, anonKey ?? serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await anon.auth.getUser(token);
      return error ? null : (data.user?.id ?? null);
    } catch {
      return null;
    }
  };

  // A session and only a session. The scheduler has no business here: there is
  // nothing to ask and nobody to answer to.
  const ownerId = await requireUser(request.headers, verifyJwt);
  if (!ownerId) return json({ status: 'not_signed_in', error: 'Sign in first.' }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ status: 'bad_request', error: 'Send a JSON body.' }, 400);
  }

  const message = str(body.message, LIMITS.message);
  if (!message) return json({ status: 'bad_request', error: 'Say something first.' }, 400);

  const requested = typeof body.operation === 'string' ? body.operation : '';
  const operation: AssistantOperation = OPERATIONS.includes(requested as AssistantOperation)
    ? (requested as AssistantOperation)
    : 'capture';

  const context = readContext(body.context);
  const turns = readTurns(body.turns);
  // The newest turn is what they just typed. Sent separately so an empty or
  // malformed history cannot lose it.
  const conversation = [...turns, { role: 'user' as const, content: message }];

  const configured = modelKey();
  const service = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (!configured) {
    return json({
      status: 'no_model_key',
      error:
        'The assistant has no model key yet. Set OPENAI_API_KEY as a function '
        + 'secret and this starts working; nothing else needs to change.',
    }, 503);
  }

  const model = chooseModel(operation, env);
  const limits = readLimits(env);
  const instructions = buildInstructions(context);
  const input = buildInput(context, conversation);

  /*
   * What this request books before it is allowed to happen.
   *
   * Measured from the prompt that is about to be sent, not guessed: every
   * character of instructions, context and conversation, plus the output
   * ceiling at full price. See server/integrations/spendGuard.ts.
   */
  const promptCharacters = instructions.length
    + input.reduce((total, turn) => total + turn.content.length, 0);

  const outcome = await runAssistantTurn(
    {
      gate: spendGate(service),
      ask: () => askModel({
        apiKey: configured.key,
        model,
        instructions,
        input,
        jsonSchema: { name: 'cockpit_assistant_reply', schema: REPLY_SCHEMA },
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutSeconds: 45,
      }),
    },
    {
      ownerId,
      operation,
      model,
      requestToken: str(body.requestToken, 120),
      reserveMicros: reserveMicros({
        model, promptCharacters, maxOutputTokens: MAX_OUTPUT_TOKENS,
      }),
      limitMicros: limits.dailyMicros,
      maxPerMinute: limits.maxPerMinute,
      holdSeconds: limits.holdSeconds,
    },
  );

  if (outcome.kind === 'blocked') {
    safeLog(`assistant: blocked, ${outcome.status}`, `owner=${ownerId.slice(0, 8)}`);
    return json({
      status: outcome.status,
      model,
      error: outcome.message,
    }, outcome.status === 'duplicate' ? 409 : 429);
  }

  if (outcome.kind === 'failed') {
    safeLog(`assistant: request failed, key=${configured.from}`, outcome.message);

    /*
     * An exhausted balance is configuration, like a missing key, and the panel
     * shows it as a standing notice rather than as a turn that went wrong.
     * Repeating "that did not get through" for something no retry can fix is
     * the difference between a person adding credit and a person debugging.
     */
    if (outcome.status === 'no_credit') {
      const where = outcome.account?.organization
        ? ` The key is charged to organisation ${outcome.account.organization}`
          + `${outcome.account.project ? `, project ${outcome.account.project}` : ''}, `
          + 'so the credit has to be on that balance.'
        : '';
      return json({
        status: 'no_credit',
        model,
        error:
          'The model account has no credits left, so nothing can be asked yet. '
          + 'Everything else is set up and working; add credit and this starts '
          + 'answering with no further changes.' + where,
      }, 503);
    }

    return json({ status: 'failed', model, error: outcome.message }, 502);
  }

  const { result } = outcome;
  const priced = outcome.basis === 'priced';

  if (result.refusal) {
    return json({
      status: 'refused',
      model,
      costMicros: outcome.costMicros,
      priced,
      proposal: unparsableProposal(result.refusal),
    });
  }

  const proposal = readProposal(result.text, context, message)
    ?? unparsableProposal(result.text);

  safeLog(
    `assistant: ${operation} ${model} key=${configured.from}`,
    `in=${result.usage?.inputTokens ?? 'unknown'} `
    + `out=${result.usage?.outputTokens ?? 'unknown'} `
    + `cost=${outcome.costMicros ?? 'unknown'} basis=${outcome.basis} `
    + `answered_as=${result.model} intent=${proposal.intent}`,
  );

  return json({
    // The model that was asked for and priced, not the one the answer named.
    // A provider describing itself does not decide what a request cost.
    status: 'ok',
    model,
    costMicros: outcome.costMicros,
    priced,
    proposal,
  });
});
