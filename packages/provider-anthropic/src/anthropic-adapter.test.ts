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
