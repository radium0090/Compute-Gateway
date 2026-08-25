import { describe, expect, it } from 'vitest';

import { defineProviderAdapterConformance } from '@rax-digital/testkit';

import { AnthropicAdapter } from './anthropic-adapter.js';

const capabilities = {
  chat: true as const,
  streaming: true,
  tools: false,
  jsonObject: false,
  jsonSchema: false,
  systemMessages: true,
};

const messageStart =
  'event: message_start\ndata: {"type":"message_start","message":{"role":"assistant","usage":{"input_tokens":2,"output_tokens":0}}}\n\n';

defineProviderAdapterConformance({
  name: 'AnthropicAdapter',
  model: 'claude-test',
  request: {
    model: 'rax/fast',
    messages: [
      { role: 'system', content: 'concise' },
      { role: 'user', content: 'private prompt text' },
    ],
    temperature: 0.2,
    topP: 0.8,
    maxTokens: 32,
    stop: ['END'],
    user: 'opaque-user',
  },
  createAdapter: (fetchImplementation) =>
    new AnthropicAdapter({
      id: 'anthropic-primary',
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'fake-anthropic-secret',
      models: { 'claude-test': capabilities },
      fetchImplementation,
    }),
  successResponse: () =>
    new Response(
      JSON.stringify({
        id: 'msg_fake',
        role: 'assistant',
        content: [{ type: 'text', text: 'safe normalized text' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 1,
          output_tokens: 3,
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  expectedResponse: {
    content: 'safe normalized text',
    finishReason: 'stop',
    usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
  },
  streamResponse: () =>
    new Response(
      [
        messageStart,
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  streamPrefix: messageStart,
  expectedChunks: [
    { choice: { delta: { role: 'assistant' }, finishReason: null } },
    { choice: { delta: { content: '你' }, finishReason: null } },
    { choice: { delta: { content: '好' }, finishReason: null } },
    { choice: { delta: {}, finishReason: 'stop' } },
    {
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    },
  ],
  assertRequest: (captured, streaming) => {
    expect(captured.url).toBe('https://provider.example/v1/messages');
    expect(captured.headers.get('x-api-key')).toBe('fake-anthropic-secret');
    expect(captured.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(captured.body).toMatchObject({
      model: 'claude-test',
      max_tokens: 32,
      system: 'concise',
      messages: [{ role: 'user', content: 'private prompt text' }],
      temperature: 0.2,
      top_p: 0.8,
      stop_sequences: ['END'],
      metadata: { user_id: 'opaque-user' },
      stream: streaming,
    });
  },
});

describe('AnthropicAdapter provider-specific rules', () => {
  it('translates OpenAI-style tools and normalizes Anthropic tool_use blocks', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const adapter = new AnthropicAdapter({
      id: 'anthropic-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-anthropic-secret',
      models: {
        'claude-test': {
          ...capabilities,
          tools: true,
          parallelToolControl: true,
        },
      },
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('missing body');
        sentBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_1',
                  name: 'weather',
                  input: { city: 'Tokyo' },
                },
              ],
              stop_reason: 'tool_use',
              usage: { input_tokens: 9, output_tokens: 4 },
            }),
          ),
        );
      },
    });

    const result = await adapter.createChatCompletion(
      {
        model: 'rax/anthropic',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'weather',
              description: 'Get weather',
              parameters: { type: 'object' },
            },
          },
        ],
        toolChoice: {
          type: 'function',
          function: { name: 'weather' },
        },
        parallelToolCalls: false,
      },
      {
        requestId: 'req_tools',
        providerModel: 'claude-test',
        signal: new AbortController().signal,
      },
    );

    expect(sentBody).toMatchObject({
      tools: [
        {
          name: 'weather',
          description: 'Get weather',
          input_schema: { type: 'object' },
        },
      ],
      tool_choice: {
        type: 'tool',
        name: 'weather',
        disable_parallel_tool_use: true,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      response: {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'toolu_1',
            function: { name: 'weather', arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
    });
  });

  it('preserves disabled parallel tool calls when tool_choice is omitted', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const adapter = new AnthropicAdapter({
      id: 'anthropic-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-anthropic-secret',
      models: {
        'claude-test': {
          ...capabilities,
          tools: true,
          parallelToolControl: true,
        },
      },
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('missing body');
        sentBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ),
        );
      },
    });

    await adapter.createChatCompletion(
      {
        model: 'rax/anthropic',
        messages: [{ role: 'user', content: 'choose a tool if needed' }],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup', parameters: { type: 'object' } },
          },
        ],
        parallelToolCalls: false,
      },
      {
        requestId: 'req_parallel_control',
        providerModel: 'claude-test',
        signal: new AbortController().signal,
      },
    );

    expect(sentBody).toMatchObject({
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    });
  });

  it('normalizes streamed Anthropic tool argument deltas', async () => {
    const adapter = new AnthropicAdapter({
      id: 'anthropic-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-anthropic-secret',
      models: { 'claude-test': { ...capabilities, tools: true } },
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            messageStart +
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}\n\n' +
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":1}"}}\n\n' +
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        ),
    });
    const result = await adapter.streamChatCompletion(
      { model: 'rax/anthropic', messages: [{ role: 'user', content: 'go' }] },
      {
        requestId: 'req_stream_tools',
        providerModel: 'claude-test',
        signal: new AbortController().signal,
      },
    );
    if (!result.ok) throw new Error('expected stream');
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    expect(chunks).toContainEqual({
      choice: {
        delta: {
          toolCalls: [
            {
              index: 0,
              id: 'toolu_1',
              type: 'function',
              function: { name: 'lookup', arguments: '' },
            },
          ],
        },
        finishReason: null,
      },
    });
    expect(chunks).toContainEqual({
      choice: {
        delta: {
          toolCalls: [{ index: 0, function: { arguments: '{"id":1}' } }],
        },
        finishReason: null,
      },
    });
  });

  it('translates prior tool calls and results into Anthropic content blocks', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const adapter = new AnthropicAdapter({
      id: 'anthropic-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-anthropic-secret',
      models: { 'claude-test': { ...capabilities, tools: true } },
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('missing body');
        sentBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 9, output_tokens: 1 },
            }),
          ),
        );
      },
    });
    await adapter.createChatCompletion(
      {
        model: 'rax/anthropic',
        messages: [
          { role: 'user', content: 'lookup' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'toolu_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"id":1}' },
              },
            ],
          },
          { role: 'tool', toolCallId: 'toolu_1', content: '{"value":42}' },
        ],
      },
      {
        requestId: 'req_tool_result',
        providerModel: 'claude-test',
        signal: new AbortController().signal,
      },
    );
    expect(sentBody).toMatchObject({
      messages: [
        { role: 'user', content: 'lookup' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'lookup',
              input: { id: 1 },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: '{"value":42}',
            },
          ],
        },
      ],
    });
  });

  it('rejects interleaved system messages before contacting Anthropic', async () => {
    let called = false;
    const adapter = new AnthropicAdapter({
      id: 'anthropic-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-anthropic-secret',
      models: { 'claude-test': capabilities },
      fetchImplementation: () => {
        called = true;
        return Promise.reject(new Error('must not be called'));
      },
    });

    await expect(
      adapter.createChatCompletion(
        {
          model: 'rax/fast',
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'late instruction' },
          ],
        },
        {
          requestId: 'req_rule_test',
          providerModel: 'claude-test',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_parameter_unsupported', retryable: false },
    });
    expect(called).toBe(false);
  });

  it('bounds successful response bodies', async () => {
    const adapter = new AnthropicAdapter({
      id: 'anthropic-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-anthropic-secret',
      models: { 'claude-test': capabilities },
      maxResponseBytes: 8,
      fetchImplementation: () =>
        Promise.resolve(new Response('{"oversized":"provider response"}')),
    });

    await expect(
      adapter.createChatCompletion(
        { model: 'rax/fast', messages: [{ role: 'user', content: 'hi' }] },
        {
          requestId: 'req_bound_test',
          providerModel: 'claude-test',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { class: 'protocol', code: 'provider_invalid_response' },
    });
  });
});
