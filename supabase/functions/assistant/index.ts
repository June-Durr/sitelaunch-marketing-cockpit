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
  askModel, chooseModel, isOutOfCredit, ModelError, priceUsage,
  type AssistantOperation, type CostBasis, type ModelUsage,
} from '../../../server/integrations/openai.ts';
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

/* ------------------------------------------------------------- the handler --- */

/**
 * The usage row. Written for failures too, because a failed call is still billed.
 *
 * Nulls where something is not known, never zeros. A request that failed on the
 * way back was charged and reported nothing, and a zero in this table would be
 * a claim that it was free. Migration 0018 makes the three numbers nullable for
 * exactly this, and requires a reason beside any unknown cost.
 */
async function recordUsage(
  client: ReturnType<typeof createClient> | null,
  ownerId: string,
  operation: string,
  model: string,
  usage: ModelUsage | null,
  costMicros: number | null,
  basis: CostBasis,
  error: string | null,
): Promise<void> {
  if (!client) return;
  const note = basis === 'no_price'
    ? `no price on file for ${model}, so this request is counted but not costed`
    : basis === 'no_usage' && error === null
      ? 'the provider reported no usage figures for this request'
      : null;
  try {
    await client.from('ai_usage').insert({
      owner_id: ownerId,
      operation,
      model,
      input_tokens: usage ? usage.inputTokens : null,
      output_tokens: usage ? usage.outputTokens : null,
      cost_micros: costMicros,
      note,
      error,
    });
  } catch (problem) {
    // A usage row that will not write must not take the answer down with it.
    safeLog('assistant: could not record usage', sanitizeError(problem));
  }
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

  try {
    const result = await askModel({
      apiKey: configured.key,
      model,
      instructions: buildInstructions(context),
      input: buildInput(context, conversation),
      jsonSchema: { name: 'cockpit_assistant_reply', schema: REPLY_SCHEMA },
      maxOutputTokens: 1800,
      timeoutSeconds: 45,
    });

    await recordUsage(
      service, ownerId, operation, result.model, result.usage, result.costMicros,
      result.basis, null,
    );

    if (result.refusal) {
      return json({
        status: 'refused',
        model: result.model,
        costMicros: result.costMicros,
        priced: result.basis === 'priced',
        proposal: unparsableProposal(result.refusal),
      });
    }

    const proposal = readProposal(result.text, context, message) ?? unparsableProposal(result.text);

    safeLog(
      `assistant: ${operation} ${result.model} key=${configured.from}`,
      `in=${result.usage?.inputTokens ?? 'unknown'} `
      + `out=${result.usage?.outputTokens ?? 'unknown'} `
      + `cost=${result.costMicros ?? 'unknown'} basis=${result.basis} `
      + `intent=${proposal.intent}`,
    );

    return json({
      status: 'ok',
      model: result.model,
      costMicros: result.costMicros,
      priced: result.basis === 'priced',
      proposal,
    });
  } catch (error) {
    const summary = error instanceof ModelError ? error.message : sanitizeError(error);
    // Null, not zeros, when the provider told us nothing. See recordUsage.
    const usage = error instanceof ModelError ? error.usage : null;
    const { costMicros, basis } = priceUsage(model, usage);

    await recordUsage(service, ownerId, operation, model, usage, costMicros, basis, summary);
    // The key's name, never its value, so a configuration problem is visible
    // in the logs of a failed request as well as a successful one.
    safeLog(`assistant: request failed, key=${configured.from}`, summary);

    /*
     * An exhausted balance is configuration, like a missing key, and the panel
     * shows it as a standing notice rather than as a turn that went wrong.
     * Repeating "that did not get through" for something no retry can fix is
     * the difference between a person adding credit and a person debugging.
     */
    if (isOutOfCredit(error)) {
      /*
       * Name the account, because "add credit" is not actionable on its own.
       *
       * A project scoped key draws on one organisation's balance. Credit added
       * to a different organisation, or to a different login, looks from in
       * here exactly like credit nobody added, and the identifiers are the only
       * way to tell those apart. They are identifiers, not credentials.
       */
      const account = error instanceof ModelError ? error.account : null;
      const where = account?.organization
        ? ` The key is charged to organisation ${account.organization}`
          + `${account.project ? `, project ${account.project}` : ''}, `
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

    return json({ status: 'failed', model, error: summary }, 502);
  }
});
