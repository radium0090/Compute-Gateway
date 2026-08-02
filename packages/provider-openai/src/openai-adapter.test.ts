import { describe, expect, it } from 'vitest';

import { OpenAiAdapter } from './openai-adapter.js';

const capabilities = {
  chat: true as const,
  streaming: false,
  tools: false,
  jsonObject: false,
  jsonSchema: false,
  systemMessages: true,
};

const request = {
  model: 'genchi/fast',
  messages: [{ role: 'user' as const, content: 'private prompt text' }],
  temperature: 0.2,
};

const context = {
  requestId: 'req_adapter_test',
  providerModel: 'gpt-test',
  signal: new AbortController().signal,
};

describe('OpenAiAdapter', () => {
  it('translates canonical input and normalizes a successful response', async () => {
    let sentUrl = '';
    let sentAuthorization = '';
    let sentBody: unknown;
    let sentSignal: AbortSignal | null = null;
    const fetchImplementation: typeof fetch = (input, init) => {
      sentUrl =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      sentAuthorization = new Headers(init?.headers).get('authorization') ?? '';
      sentSignal = init?.signal ?? null;
      sentBody =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : null;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'provider-id',
            choices: [
              {
                message: { role: 'assistant', content: 'safe normalized text' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 3,
              total_tokens: 7,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': capabilities },
      fetchImplementation,
    });

    await expect(
      adapter.createChatCompletion(request, context),
    ).resolves.toEqual({
      ok: true,
      response: {
        content: 'safe normalized text',
        finishReason: 'stop',
        usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
      },
    });
    expect(sentUrl).toBe('https://provider.example/v1/chat/completions');
    expect(sentAuthorization).toBe('Bearer fake-provider-secret');
    expect(sentSignal).toBe(context.signal);
    expect(sentBody).toMatchObject({
      model: 'gpt-test',
      messages: request.messages,
      stream: false,
      n: 1,
    });
  });

  it.each([
    [401, 'authentication', false],
    [429, 'rate_limit', true],
    [500, 'unavailable', true],
    [400, 'request', false],
  ] as const)(
    'classifies HTTP %s without returning the upstream body',
    async (status, expectedClass, retryable) => {
      const adapter = new OpenAiAdapter({
        id: 'openai-primary',
        baseUrl: 'https://provider.example/v1',
        apiKey: 'fake-provider-secret',
        models: { 'gpt-test': capabilities },
        fetchImplementation: () =>
          Promise.resolve(
            new Response('raw upstream secret-bearing body', {
              status,
              headers: status === 429 ? { 'retry-after': '3' } : {},
            }),
          ),
      });

      const result = await adapter.createChatCompletion(request, context);

      expect(result).toMatchObject({
        ok: false,
        error: { class: expectedClass, retryable },
      });
      expect(JSON.stringify(result)).not.toContain('raw upstream');
    },
  );

  it('classifies malformed success payloads as protocol errors', async () => {
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': capabilities },
      fetchImplementation: () =>
        Promise.resolve(new Response('{"unexpected":true}', { status: 200 })),
    });

    await expect(
      adapter.createChatCompletion(request, context),
    ).resolves.toEqual({
      ok: false,
      error: {
        class: 'protocol',
        code: 'provider_invalid_response',
        retryable: true,
      },
    });
  });

  it('bounds successful provider response bodies', async () => {
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': capabilities },
      maxResponseBytes: 10,
      fetchImplementation: () =>
        Promise.resolve(
          new Response(JSON.stringify({ oversized: 'response' })),
        ),
    });

    await expect(
      adapter.createChatCompletion(request, context),
    ).resolves.toMatchObject({
      ok: false,
      error: { class: 'protocol', code: 'provider_invalid_response' },
    });
  });

  it('propagates cancellation and returns a typed timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': capabilities },
      fetchImplementation: (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        return Promise.reject(new Error('aborted'));
      },
    });

    await expect(
      adapter.createChatCompletion(request, {
        ...context,
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        class: 'timeout',
        code: 'provider_timeout',
        retryable: true,
      },
    });
  });
});
