import { expect } from 'vitest';

import { defineProviderAdapterConformance } from '@rax-digital/testkit';

import { OpenAiAdapter } from './openai-adapter.js';

const capabilities = {
  chat: true as const,
  streaming: true,
  tools: false,
  jsonObject: false,
  jsonSchema: false,
  systemMessages: true,
};

const firstStreamEvent =
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"你"},"finish_reason":null}]}\n\n';

defineProviderAdapterConformance({
  name: 'OpenAiAdapter',
  model: 'gpt-test',
  request: {
    model: 'rax/fast',
    messages: [{ role: 'user', content: 'private prompt text' }],
    temperature: 0.2,
    topP: 0.8,
    maxTokens: 32,
    stop: 'END',
    user: 'opaque-user',
  },
  createAdapter: (fetchImplementation) =>
    new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'fake-openai-secret',
      models: { 'gpt-test': capabilities },
      fetchImplementation,
    }),
  successResponse: () =>
    new Response(
      JSON.stringify({
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
      { headers: { 'content-type': 'application/json' } },
    ),
  expectedResponse: {
    content: 'safe normalized text',
    finishReason: 'stop',
    usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
  },
  streamResponse: () =>
    new Response(
      firstStreamEvent +
        'data: {"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n' +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  streamPrefix: firstStreamEvent,
  expectedChunks: [
    {
      choice: {
        delta: { role: 'assistant', content: '你' },
        finishReason: null,
      },
    },
    { choice: { delta: { content: '好' }, finishReason: 'stop' } },
    { usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 } },
  ],
  assertRequest: (captured, streaming) => {
    expect(captured.url).toBe('https://provider.example/v1/chat/completions');
    expect(captured.headers.get('authorization')).toBe(
      'Bearer fake-openai-secret',
    );
    expect(captured.body).toMatchObject({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'private prompt text' }],
      temperature: 0.2,
      top_p: 0.8,
      max_completion_tokens: 32,
      stop: 'END',
      user: 'opaque-user',
      n: 1,
      stream: streaming,
    });
  },
});
