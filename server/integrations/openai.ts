/**
 * The model adapter. One provider today, a seam either way.
 *
 * Everything the Cockpit asks a model goes through askModel: one HTTP call, one
 * parsed result, one priced usage record. Nothing above this file knows the
 * provider's wire format, and nothing in this file knows what the Cockpit is
 * asking for. That is the whole point of it being here.
 *
 * WHY THE RESPONSES ENDPOINT
 *
 * It is OpenAI's current API and the only one where strict structured output and
 * function tools share the same request. The assistant needs the first for
 * every call and will need the second the moment the lead index outgrows a
 * prompt, and writing against two endpoints to get both would mean two parsers.
 *
 * WHAT NEVER LEAVES THIS FILE
 *
 * The API key. It arrives as an argument, goes into one Authorization header and
 * is never logged, never returned and never put in an error message. ModelError
 * carries a status and a sanitized line, because the caller writes that line
 * into a usage row and a usage row is readable by its owner.
 */

/** OpenAI's current request endpoint. */
export const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/* --------------------------------------------------------------- the money --- */

/**
 * Prices, in millionths of a US dollar per million tokens.
 *
 * Integers, because ai_usage.cost_micros is an integer and a float that spends
 * a session being multiplied and summed is a cost table that slowly stops
 * matching the invoice. $2.00 per million reads as 2_000_000 here.
 *
 * Cached input is a real rate and is charged instead of the full input rate for
 * the tokens the provider says it reused, so it is priced separately below
 * rather than averaged in.
 *
 * Taken from the published price list on 2026-10-14. A model that is not in
 * this table still gets a usage row with its real token counts; what it does
 * not get is an invented cost. See priceUsage.
 */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-6-astra': { input: 10_000_000, cachedInput: 1_000_000, output: 50_000_000 },
  'gpt-6.1-sol': { input: 2_000_000, cachedInput: 100_000, output: 10_000_000 },
  'gpt-6-sol': { input: 2_000_000, cachedInput: 200_000, output: 10_000_000 },
  'gpt-6-luna': { input: 100_000, cachedInput: 10_000, output: 500_000 },
  'gpt-5.6-sol': { input: 4_000_000, cachedInput: 400_000, output: 20_000_000 },
  'gpt-5.6-terra': { input: 2_000_000, cachedInput: 200_000, output: 12_000_000 },
  'gpt-5.6-luna': { input: 200_000, cachedInput: 20_000, output: 1_200_000 },
  'gpt-5.5': { input: 5_000_000, cachedInput: 500_000, output: 30_000_000 },
};

/* ------------------------------------------------------- choosing a model --- */

/**
 * What the assistant is being asked to do.
 *
 * Cost is attributed to one of these rather than to "the assistant", because
 * "drafting is most of the bill" is a thing somebody can act on and "the
 * assistant cost nine dollars" is not.
 */
export type AssistantOperation = 'capture' | 'brief' | 'draft';

/**
 * Which model each operation gets, and why these ones.
 *
 * capture reads a messy paragraph about a real person and decides what is a
 * stated fact, what is an impression and what is a guess. Getting that wrong
 * writes a wrong thing into a CRM, so it gets the stronger model.
 *
 * draft writes the message that actually goes to a prospect, sometimes in
 * Spanish. Wording quality is the whole deliverable, so it gets the stronger
 * model too.
 *
 * brief summarises rows the Cockpit has already selected and handed over. There
 * is no retrieval and no judgement about provenance, so the small model is the
 * right trade: twenty times cheaper, noticeably faster, same strict schema.
 *
 * This split is a judgement made before any live measurement, which is why
 * every one of them is overridable without a deploy. ASSISTANT_MODEL replaces
 * all three; ASSISTANT_MODEL_CAPTURE and friends replace one.
 */
export const OPERATION_MODELS: Record<AssistantOperation, string> = {
  capture: 'gpt-6.1-sol',
  draft: 'gpt-6.1-sol',
  brief: 'gpt-6-luna',
};

export type ReadEnv = (name: string) => string | null;

/** The model for one operation: the specific override, the general one, or the default. */
export function chooseModel(operation: AssistantOperation, readEnv: ReadEnv): string {
  const specific = readEnv(`ASSISTANT_MODEL_${operation.toUpperCase()}`);
  if (specific) return specific.trim();
  const general = readEnv('ASSISTANT_MODEL');
  if (general) return general.trim();
  return OPERATION_MODELS[operation];
}

/* ------------------------------------------------------------- the request --- */

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool the model may call. Flat, which is the Responses shape. */
export interface ModelTool {
  name: string;
  description: string;
  /** JSON Schema. Strict mode requires additionalProperties false and every key required. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  apiKey: string;
  model: string;
  /** The standing instructions. Sent as `instructions`, not as a fake first turn. */
  instructions: string;
  input: ModelMessage[];
  /** Forces every reply through one strict schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> } | null;
  tools?: ModelTool[];
  maxOutputTokens?: number;
  /** Seconds. A request that has not answered by then is abandoned. */
  timeoutSeconds?: number;
}

export interface ModelUsage {
  inputTokens: number;
  /** A subset of inputTokens, charged at the cheaper rate. */
  cachedInputTokens: number;
  outputTokens: number;
}

export interface ModelFunctionCall {
  callId: string;
  name: string;
  /** The raw JSON string the model produced. Parsed by the caller, never trusted. */
  arguments: string;
}

export interface ModelResult {
  model: string;
  /** The assistant's text, concatenated. Empty when it refused or only called tools. */
  text: string;
  /** Set when the model declined. Does not follow the schema, so check it first. */
  refusal: string | null;
  functionCalls: ModelFunctionCall[];
  /** Null when the provider sent no usage figures at all. Not zero. */
  usage: ModelUsage | null;
  /** Null when the cost is not known. See basis for which kind of not known. */
  costMicros: number | null;
  basis: CostBasis;
  /** Set when the answer was cut short, with the provider's reason. */
  truncated: string | null;
}

/**
 * Which account a request was charged to, as the provider reported it.
 *
 * Identifiers, not credentials, and they are the difference between "add
 * credit" and "add credit to this organisation". A project scoped key draws on
 * one particular organisation's balance, and credit added to a different one
 * looks from here exactly like credit that was never added. Read off the
 * response headers because nothing else says which account answered.
 */
export interface ModelAccount {
  organization: string | null;
  project: string | null;
}

/** A request that failed, with nothing in it that could have come from a key. */
export class ModelError extends Error {
  readonly status: number | null;
  /**
   * What the failed request used, when the provider said.
   *
   * Null is the common case and is the whole point of this being nullable: a
   * request that timed out after the model had generated tokens was billed, and
   * recording zero for it would understate the bill. Null means not known.
   */
  readonly usage: ModelUsage | null;
  /** Null when the failure happened before any response came back. */
  readonly account: ModelAccount | null;

  constructor(
    message: string,
    status: number | null = null,
    usage: ModelUsage | null = null,
    account: ModelAccount | null = null,
  ) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.usage = usage;
    this.account = account;
  }
}

/** The account that answered, off the response headers. Absent is normal. */
export function readAccount(response: Response): ModelAccount {
  return {
    organization: response.headers.get('openai-organization'),
    project: response.headers.get('openai-project'),
  };
}

export const EMPTY_USAGE: ModelUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

/**
 * Out of credit, which is a billing state rather than a failed question.
 *
 * Worth telling apart because the two call for different things from the
 * person reading the screen. A rate limit or a bad gateway means try again; an
 * exhausted balance means nothing will work until somebody adds credit, and
 * saying "that did not get through" over and over instead is how an afternoon
 * gets lost. Found by running the real thing: the provider answers 429 with
 * insufficient_quota and no usage figures at all.
 */
export function isOutOfCredit(error: unknown): boolean {
  if (!(error instanceof ModelError)) return false;
  return error.status === 429
    && /insufficient_quota|credit_balance_exhausted|no credits remaining/i.test(error.message);
}

/**
 * Why a cost is or is not known.
 *
 *   priced    the provider reported usage and the model has a price on file
 *   no_price  usage is known, the model is not in the price table
 *   no_usage  the provider reported nothing, so nothing can be worked out
 *
 * The caller stores the reason, because "we do not know" is only an acceptable
 * answer in a cost table if it comes with which kind of not knowing it was.
 */
export type CostBasis = 'priced' | 'no_price' | 'no_usage';

/**
 * What one call cost, in millionths of a dollar, or nothing if that is unknown.
 *
 * Cached tokens are counted inside inputTokens by the provider, so they are
 * taken out and charged at their own rate rather than counted twice. Each of
 * the three lines is rounded on its own, which keeps the arithmetic the same
 * whichever order the rows are summed in later.
 *
 * It returns null rather than zero for both kinds of unknown. A failed request
 * is still billed, and a zero in a cost table is a claim that it was free.
 */
export function priceUsage(
  model: string,
  usage: ModelUsage | null,
): { costMicros: number | null; basis: CostBasis } {
  if (!usage) return { costMicros: null, basis: 'no_usage' };
  const price = MODEL_PRICES[model];
  if (!price) return { costMicros: null, basis: 'no_price' };

  const cached = Math.min(Math.max(usage.cachedInputTokens, 0), Math.max(usage.inputTokens, 0));
  const fresh = Math.max(usage.inputTokens, 0) - cached;

  const micros =
    Math.round((fresh * price.input) / 1_000_000) +
    Math.round((cached * price.cachedInput) / 1_000_000) +
    Math.round((Math.max(usage.outputTokens, 0) * price.output) / 1_000_000);

  return { costMicros: micros, basis: 'priced' };
}

/* ------------------------------------------------------------- the parsing --- */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * The token counts, or null when the provider did not report any.
 *
 * The distinction is the reason this returns null rather than zeros. A response
 * with usage and zeros in it would be strange; a response with no usage object
 * means the request did not get far enough to be measured, or failed on the way
 * back. Those are different rows in the cost table.
 */
export function readUsage(body: unknown): ModelUsage | null {
  const root = asRecord(body);
  if (root.usage === null || typeof root.usage !== 'object') return null;
  const usage = asRecord(root.usage);
  return {
    inputTokens: asCount(usage.input_tokens),
    cachedInputTokens: asCount(asRecord(usage.input_tokens_details).cached_tokens),
    outputTokens: asCount(usage.output_tokens),
  };
}

/**
 * The provider's response, turned into the four things a caller needs.
 *
 * Written against the documented output array rather than a convenience field,
 * because the convenience field is an SDK nicety and this talks HTTP. Unknown
 * item types are ignored instead of failing: a provider adding a new one must
 * not take the assistant down.
 */
export function readResult(model: string, body: unknown): Omit<ModelResult, 'model'> & { model: string } {
  const root = asRecord(body);
  const texts: string[] = [];
  const calls: ModelFunctionCall[] = [];
  let refusal: string | null = null;

  for (const raw of asArray(root.output)) {
    const item = asRecord(raw);
    if (item.type === 'function_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      const name = typeof item.name === 'string' ? item.name : '';
      if (callId && name) {
        calls.push({
          callId,
          name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        });
      }
      continue;
    }
    if (item.type !== 'message') continue;
    for (const rawPart of asArray(item.content)) {
      const part = asRecord(rawPart);
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
      if (part.type === 'refusal' && typeof part.refusal === 'string') refusal = part.refusal;
    }
  }

  const usage = readUsage(root);
  const { costMicros, basis } = priceUsage(model, usage);

  // 'incomplete' means the answer stopped early. Reported rather than parsed as
  // though it were whole, because half a JSON object is not a proposal.
  const incomplete = asRecord(root.incomplete_details);
  const truncated =
    root.status === 'incomplete'
      ? (typeof incomplete.reason === 'string' ? incomplete.reason : 'incomplete')
      : null;

  return {
    model: typeof root.model === 'string' ? root.model : model,
    text: texts.join('').trim(),
    refusal,
    functionCalls: calls,
    usage,
    costMicros,
    basis,
    truncated,
  };
}

/**
 * One line about a failed request, safe to store and to show.
 *
 * The provider's error body can quote the request back, so only the type, code
 * and message are read out of it, each capped. Nothing is interpolated from the
 * request itself.
 */
export function readError(status: number, body: unknown): string {
  const error = asRecord(asRecord(body).error);
  const parts = [
    typeof error.type === 'string' ? error.type : null,
    typeof error.code === 'string' ? error.code : null,
    typeof error.message === 'string' ? error.message.slice(0, 300) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `${status}: ${parts.join(' ')}` : `The model request failed (${status}).`;
}

/* -------------------------------------------------------------- the request --- */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Ask the model once.
 *
 * Throws ModelError on anything that is not a usable answer, carrying the token
 * counts when the provider sent them, because a failed call is still billed and
 * a cost record that drops those is a cost record that understates the bill.
 */
export async function askModel(
  request: ModelRequest,
  fetchImpl: FetchLike = fetch,
): Promise<ModelResult> {
  if (!request.apiKey) throw new ModelError('No model key is configured.');

  const payload: Record<string, unknown> = {
    model: request.model,
    instructions: request.instructions,
    input: request.input.map((message) => ({ role: message.role, content: message.content })),
  };

  if (request.maxOutputTokens) payload.max_output_tokens = request.maxOutputTokens;

  if (request.jsonSchema) {
    payload.text = {
      format: {
        type: 'json_schema',
        name: request.jsonSchema.name,
        schema: request.jsonSchema.schema,
        strict: true,
      },
    };
  }

  /*
   * Tools are passed through when a caller has them, and nothing in the first
   * release does: every fact the assistant needs is selected by the Cockpit and
   * put in the prompt, which is one round trip instead of three and cannot
   * retrieve the wrong person. The shape is here because this file is the seam,
   * and the lead index it relies on stops fitting in a prompt somewhere in the
   * low thousands of contacts.
   */
  if (request.tools && request.tools.length > 0) {
    payload.tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    }));
    payload.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, request.timeoutSeconds ?? 45) * 1000,
  );

  let response: Response;
  try {
    response = await fetchImpl(RESPONSES_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    // Deliberately not the thrown error's own message: an aborted or failed
    // fetch can quote the request, and the request carries a key header.
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ModelError(
      aborted ? 'The model did not answer in time.' : 'Could not reach the model.',
    );
  } finally {
    clearTimeout(timeout);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new ModelError(
      readError(response.status, body), response.status, readUsage(body),
      readAccount(response),
    );
  }

  const result = readResult(request.model, body);
  if (result.truncated) {
    throw new ModelError(
      `The answer was cut off (${result.truncated}).`,
      null,
      result.usage,
    );
  }
  return result;
}
