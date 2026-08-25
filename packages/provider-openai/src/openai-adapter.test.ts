import { describe, expect, it } from 'vitest';

import { ProviderStreamFailure } from '@rax-digital/domain';

import { OpenAiAdapter } from './openai-adapter.js';

const capabilities = {
  chat: true as const,
  streaming: false,
  tools: false,
  jsonObject: false,
  jsonSchema: false,
  systemMessages: true,
};

const streamingCapabilities = { ...capabilities, streaming: true };
const agentCapabilities = {
  ...streamingCapabilities,
  tools: true,
  strictTools: true,
  parallelToolControl: true,
  jsonObject: true,
  jsonSchema: true,
};

const request = {
  model: 'rax/fast',
  messages: [{ role: 'user' as const, content: 'private prompt text' }],
  temperature: 0.2,
};

const context = {
  requestId: 'req_adapter_test',
  providerModel: 'gpt-test',
  signal: new AbortController().signal,
};

describe('OpenAiAdapter', () => {
  it('passes tools and structured output through and normalizes tool calls', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': agentCapabilities },
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('missing body');
        sentBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_weather',
                        type: 'function',
                        function: {
                          name: 'weather',
                          arguments: '{"city":"Tokyo"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            }),
          ),
        );
      },
    });

    const result = await adapter.createChatCompletion(
      {
        ...request,
        messages: [
          { role: 'user', content: 'lookup' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call_previous',
                type: 'function',
                function: { name: 'lookup', arguments: '{"id":1}' },
              },
            ],
          },
          { role: 'tool', toolCallId: 'call_previous', content: '42' },
          { role: 'user', content: 'weather?' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'weather',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
              },
              strict: true,
            },
          },
        ],
        toolChoice: 'required',
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'weather_result',
            schema: { type: 'object' },
            strict: true,
          },
        },
      },
      context,
    );

    expect(sentBody).toMatchObject({
      messages: [
        { role: 'user', content: 'lookup' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_previous', function: { name: 'lookup' } }],
        },
        { role: 'tool', tool_call_id: 'call_previous', content: '42' },
        { role: 'user', content: 'weather?' },
      ],
      tools: [{ function: { name: 'weather', strict: true } }],
      tool_choice: 'required',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'weather_result', strict: true },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      response: {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call_weather',
            function: { name: 'weather', arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
    });
  });

  it('normalizes streamed tool-call deltas without assembling arguments', async () => {
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': agentCapabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            [
              'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"finish_reason":null}]}\n\n',
              'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"id\\":1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
              'data: [DONE]\n\n',
            ].join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
    });
    const result = await adapter.streamChatCompletion(request, context);
    if (!result.ok) throw new Error('expected stream');
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    expect(chunks).toMatchObject([
      {
        choice: {
          delta: {
            role: 'assistant',
            toolCalls: [{ index: 0, id: 'call_1', type: 'function' }],
          },
        },
      },
      {
        choice: {
          delta: {
            toolCalls: [{ index: 0, function: { arguments: '{"id":1}' } }],
          },
          finishReason: 'tool_calls',
        },
      },
    ]);
  });

  it('rejects undeclared tool capability before contacting the provider', async () => {
    let called = false;
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': capabilities },
      fetchImplementation: () => {
        called = true;
        return Promise.reject(new Error('must not be called'));
      },
    });
    await expect(
      adapter.createChatCompletion(
        {
          ...request,
          tools: [
            {
              type: 'function',
              function: { name: 'lookup', parameters: { type: 'object' } },
            },
          ],
        },
        context,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_parameter_unsupported', retryable: false },
    });
    expect(called).toBe(false);
  });

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

  it('parses ordered SSE chunks and normalizes terminal usage', async () => {
    const encoded = new TextEncoder().encode(
      [
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    );
    let sentBody: unknown;
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': streamingCapabilities },
      fetchImplementation: (_input, init) => {
        sentBody =
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as unknown)
            : null;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoded.subarray(0, 97));
                controller.enqueue(encoded.subarray(97, 101));
                controller.enqueue(encoded.subarray(101));
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      },
    });

    const result = await adapter.streamChatCompletion(request, context);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected a stream');
    }
    const chunks = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }
    expect(sentBody).toMatchObject({
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(chunks).toEqual([
      {
        choice: {
          delta: { role: 'assistant', content: '你' },
          finishReason: null,
        },
      },
      {
        choice: { delta: { content: '好' }, finishReason: 'stop' },
      },
      {
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      },
    ]);
  });

  it('returns typed pre-commit stream errors without exposing the body', async () => {
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': streamingCapabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response('secret upstream failure', { status: 429 }),
        ),
    });

    const result = await adapter.streamChatCompletion(request, context);

    expect(result).toMatchObject({
      ok: false,
      error: { class: 'rate_limit', code: 'provider_rate_limited' },
    });
    expect(JSON.stringify(result)).not.toContain('secret upstream failure');
  });

  it('cancels an incomplete upstream stream when consumption stops', async () => {
    let cancelled = false;
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': streamingCapabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}\n\n',
                  ),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
    });
    const result = await adapter.streamChatCompletion(request, context);
    if (!result.ok) {
      throw new Error('expected a stream');
    }
    const iterator = result.stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await iterator.return?.();

    expect(cancelled).toBe(true);
  });

  it('fails malformed streams with a safe typed error', async () => {
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-secret',
      models: { 'gpt-test': streamingCapabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response('data: {"invalid":true}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
    });
    const result = await adapter.streamChatCompletion(request, context);
    if (!result.ok) {
      throw new Error('expected a stream');
    }

    const consume = async (): Promise<void> => {
      for await (const chunk of result.stream) {
        void chunk;
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ProviderStreamFailure);
  });
});
