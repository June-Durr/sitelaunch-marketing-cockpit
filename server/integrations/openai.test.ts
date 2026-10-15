/**
 * The model adapter, tested without a model.
 *
 * Every test here uses a fake fetch. The point is not whether OpenAI answers,
 * it is whether this file asks correctly, reads the answer correctly, prices it
 * correctly, and keeps the key out of everything it hands back.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  askModel, chooseModel, MODEL_PRICES, ModelError, OPERATION_MODELS, priceUsage,
  readError, readResult, readUsage, RESPONSES_URL, type ModelUsage,
} from './openai.ts';

const KEY = 'sk-test-not-a-real-key-0000';

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textAnswer(text: string, usage?: Record<string, unknown>) {
  return {
    model: 'gpt-6.1-sol',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: usage ?? { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
  };
}

describe('choosing a model', () => {
  const none = () => null;

  it('uses the per-operation default when nothing is configured', () => {
    expect(chooseModel('capture', none)).toBe(OPERATION_MODELS.capture);
    expect(chooseModel('brief', none)).toBe(OPERATION_MODELS.brief);
    expect(chooseModel('draft', none)).toBe(OPERATION_MODELS.draft);
  });

  it('gives the cheap model only to the operation that just summarises', () => {
    // The judgement this file encodes: capture and draft decide what gets
    // written about a real person, brief reads rows it was handed.
    expect(OPERATION_MODELS.brief).not.toBe(OPERATION_MODELS.capture);
    const brief = MODEL_PRICES[OPERATION_MODELS.brief];
    const capture = MODEL_PRICES[OPERATION_MODELS.capture];
    expect(brief.output).toBeLessThan(capture.output);
  });

  it('every default model has a price on file', () => {
    for (const model of Object.values(OPERATION_MODELS)) {
      expect(MODEL_PRICES[model], `${model} has no price`).toBeDefined();
    }
  });

  it('lets one variable replace all three', () => {
    const env = (name: string) => (name === 'ASSISTANT_MODEL' ? 'gpt-6-astra' : null);
    expect(chooseModel('capture', env)).toBe('gpt-6-astra');
    expect(chooseModel('brief', env)).toBe('gpt-6-astra');
  });

  it('lets one operation be overridden on its own, and that wins', () => {
    const env = (name: string) => {
      if (name === 'ASSISTANT_MODEL_BRIEF') return 'gpt-5.6-terra';
      if (name === 'ASSISTANT_MODEL') return 'gpt-6-astra';
      return null;
    };
    expect(chooseModel('brief', env)).toBe('gpt-5.6-terra');
    expect(chooseModel('draft', env)).toBe('gpt-6-astra');
  });

  it('trims a value somebody pasted with a space on the end', () => {
    expect(chooseModel('capture', () => ' gpt-6-luna ')).toBe('gpt-6-luna');
  });
});

describe('pricing one call', () => {
  it('charges input and output at the published rates', () => {
    // gpt-6.1-sol: $2.00 per million in, $10.00 per million out.
    const { costMicros, priced } = priceUsage('gpt-6.1-sol', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(priced).toBe(true);
    expect(costMicros).toBe(12_000_000);
  });

  it('is pennies for a realistic call', () => {
    const { costMicros } = priceUsage('gpt-6.1-sol', {
      inputTokens: 2500, cachedInputTokens: 0, outputTokens: 400,
    });
    // 2500 * 2 + 400 * 10 = 9000 millionths, nine thousandths of a cent short
    // of a cent. Asserted so a price table edit that moves a decimal point
    // shows up as a failing test rather than as a surprise on the bill.
    expect(costMicros).toBe(9_000);
  });

  it('takes cached tokens out of the full rate rather than charging twice', () => {
    const usage: ModelUsage = {
      inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0,
    };
    // 100k fresh at $2/M plus 900k cached at $0.10/M.
    expect(priceUsage('gpt-6.1-sol', usage).costMicros).toBe(200_000 + 90_000);
  });

  it('never lets a cached count exceed the input count', () => {
    const usage: ModelUsage = {
      inputTokens: 100, cachedInputTokens: 10_000, outputTokens: 0,
    };
    expect(priceUsage('gpt-6.1-sol', usage).costMicros).toBe(
      Math.round((100 * MODEL_PRICES['gpt-6.1-sol'].cachedInput) / 1_000_000),
    );
  });

  it('says a model has no price rather than calling it free', () => {
    const { costMicros, priced } = priceUsage('some-model-nobody-priced', {
      inputTokens: 5000, cachedInputTokens: 0, outputTokens: 5000,
    });
    expect(costMicros).toBe(0);
    expect(priced).toBe(false);
  });

  it('treats negative counts as zero rather than as a refund', () => {
    expect(
      priceUsage('gpt-6.1-sol', { inputTokens: -5, cachedInputTokens: -5, outputTokens: -5 })
        .costMicros,
    ).toBe(0);
  });
});

describe('reading usage off a response', () => {
  it('reads the three documented fields', () => {
    expect(readUsage({
      usage: {
        input_tokens: 900, output_tokens: 120,
        input_tokens_details: { cached_tokens: 400 },
      },
    })).toEqual({ inputTokens: 900, cachedInputTokens: 400, outputTokens: 120 });
  });

  it('reports zeros rather than throwing when usage is missing', () => {
    expect(readUsage({})).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(readUsage(null)).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });
});

describe('reading the output', () => {
  it('joins every text part in order', () => {
    const result = readResult('gpt-6.1-sol', {
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: '{"a":' }, { type: 'output_text', text: '1}' }],
      }],
    });
    expect(result.text).toBe('{"a":1}');
  });

  it('reports a refusal separately, because it does not follow the schema', () => {
    const result = readResult('gpt-6.1-sol', {
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I will not.' }] }],
    });
    expect(result.refusal).toBe('I will not.');
    expect(result.text).toBe('');
  });

  it('parses a function call, keeping the arguments as the raw string', () => {
    const result = readResult('gpt-6.1-sol', {
      output: [{
        type: 'function_call', id: 'fc_1', call_id: 'call_1',
        name: 'find_contact', arguments: '{"name":"Ariel"}',
      }],
    });
    expect(result.functionCalls).toEqual([
      { callId: 'call_1', name: 'find_contact', arguments: '{"name":"Ariel"}' },
    ]);
  });

  it('ignores an output item type it has never heard of', () => {
    const result = readResult('gpt-6.1-sol', {
      output: [
        { type: 'something_new', payload: 'whatever' },
        { type: 'message', content: [{ type: 'output_text', text: 'still here' }] },
      ],
    });
    expect(result.text).toBe('still here');
  });

  it('drops a function call with no call id, since nothing could answer it', () => {
    const result = readResult('gpt-6.1-sol', {
      output: [{ type: 'function_call', name: 'find_contact', arguments: '{}' }],
    });
    expect(result.functionCalls).toEqual([]);
  });

  it('reports a cut off answer rather than parsing half of one', () => {
    const result = readResult('gpt-6.1-sol', {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"intent":' }] }],
    });
    expect(result.truncated).toBe('max_output_tokens');
  });
});

describe('the error line', () => {
  it('names the type, code and message, capped', () => {
    const line = readError(400, {
      error: { type: 'invalid_request_error', code: 'model_not_found', message: 'No such model' },
    });
    expect(line).toBe('400: invalid_request_error model_not_found No such model');
  });

  it('still says something when the body is not the documented shape', () => {
    expect(readError(500, 'gateway down')).toContain('500');
  });

  it('caps a message that tries to quote the whole request back', () => {
    const line = readError(400, { error: { message: 'x'.repeat(5000) } });
    expect(line.length).toBeLessThan(400);
  });
});

describe('asking the model', () => {
  it('posts to the documented endpoint with the key in the header and not the body', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => answer(textAnswer('{"intent":"answer"}')));
    await askModel({
      apiKey: KEY,
      model: 'gpt-6.1-sol',
      instructions: 'be plain',
      input: [{ role: 'user', content: 'hello' }],
    }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESPONSES_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(String(init.body)).not.toContain(KEY);

    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload.model).toBe('gpt-6.1-sol');
    expect(payload.instructions).toBe('be plain');
    expect(payload.input).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('sends a strict json schema in the documented place', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => answer(textAnswer('{}')));
    await askModel({
      apiKey: KEY,
      model: 'gpt-6.1-sol',
      instructions: 'x',
      input: [{ role: 'user', content: 'y' }],
      jsonSchema: { name: 'reply', schema: { type: 'object' } },
    }, fetchImpl);

    const payload = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect(payload.text).toEqual({
      format: { type: 'json_schema', name: 'reply', schema: { type: 'object' }, strict: true },
    });
  });

  it('sends tools flat, which is the Responses shape, not nested under function', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => answer(textAnswer('{}')));
    await askModel({
      apiKey: KEY,
      model: 'gpt-6.1-sol',
      instructions: 'x',
      input: [{ role: 'user', content: 'y' }],
      tools: [{
        name: 'find_contact',
        description: 'Find a contact by name',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
      }],
    }, fetchImpl);

    const payload = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    const tools = payload.tools as Record<string, unknown>[];
    expect(tools[0].type).toBe('function');
    expect(tools[0].name).toBe('find_contact');
    expect(tools[0].strict).toBe(true);
    expect(tools[0].function).toBeUndefined();
    expect(payload.tool_choice).toBe('auto');
  });

  it('sends no tools key at all when there are none', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => answer(textAnswer('{}')));
    await askModel({
      apiKey: KEY, model: 'gpt-6.1-sol', instructions: 'x',
      input: [{ role: 'user', content: 'y' }],
    }, fetchImpl);
    const payload = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect('tools' in payload).toBe(false);
  });

  it('returns the text and the priced usage', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => answer(textAnswer('{"intent":"answer"}', {
      input_tokens: 2000, output_tokens: 300, input_tokens_details: { cached_tokens: 0 },
    })));
    const result = await askModel({
      apiKey: KEY, model: 'gpt-6.1-sol', instructions: 'x',
      input: [{ role: 'user', content: 'y' }],
    }, fetchImpl);

    expect(result.text).toBe('{"intent":"answer"}');
    expect(result.usage.inputTokens).toBe(2000);
    expect(result.costMicros).toBe(2000 * 2 + 300 * 10);
    expect(result.priced).toBe(true);
  });

  it('throws with the status and the tokens when the provider refuses the request', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => answer({
      error: { type: 'invalid_request_error', message: 'bad schema' },
      usage: { input_tokens: 500, output_tokens: 0 },
    }, 400));

    await expect(askModel({
      apiKey: KEY, model: 'gpt-6.1-sol', instructions: 'x',
      input: [{ role: 'user', content: 'y' }],
    }, fetchImpl)).rejects.toMatchObject({
      name: 'ModelError',
      status: 400,
      // A failed call is still billed, so the counts come back with the error.
      usage: { inputTokens: 500 },
    });
  });

  it('keeps the key out of the message when the network itself fails', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${KEY}`);
    });
    const error = await askModel({
      apiKey: KEY, model: 'gpt-6.1-sol', instructions: 'x',
      input: [{ role: 'user', content: 'y' }],
    }, fetchImpl).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).message).not.toContain(KEY);
    expect((error as ModelError).message).toBe('Could not reach the model.');
  });

  it('refuses to hand back half an answer', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => answer({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"intent"' }] }],
      usage: { input_tokens: 10, output_tokens: 1800 },
    }));
    await expect(askModel({
      apiKey: KEY, model: 'gpt-6.1-sol', instructions: 'x',
      input: [{ role: 'user', content: 'y' }],
    }, fetchImpl)).rejects.toThrow(/cut off/);
  });

  it('will not call out at all without a key', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => answer(textAnswer('{}')));
    await expect(askModel({
      apiKey: '', model: 'gpt-6.1-sol', instructions: 'x',
      input: [{ role: 'user', content: 'y' }],
    }, fetchImpl)).rejects.toThrow(/no model key/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
