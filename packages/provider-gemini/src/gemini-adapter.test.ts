import { describe, expect, it } from 'vitest';

import { defineProviderAdapterConformance } from '@rax-digital/testkit';

import { GeminiAdapter } from './gemini-adapter.js';

const capabilities = {
  chat: true as const,
  streaming: true,
  tools: false,
  jsonObject: false,
  jsonSchema: false,
  systemMessages: true,
};

const firstStreamEvent =
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你"}]}}]}\n\n';

defineProviderAdapterConformance({
  name: 'GeminiAdapter',
  model: 'gemini-2.5-flash',
  request: {
    model: 'rax/fast',
    messages: [
      { role: 'system', content: 'concise' },
      { role: 'user', content: 'private prompt text' },
      { role: 'assistant', content: 'prior answer' },
      { role: 'user', content: 'continue' },
    ],
    temperature: 0.2,
    topP: 0.8,
    maxTokens: 32,
    stop: 'END',
  },
  createAdapter: (fetchImplementation) =>
    new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta/',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-2.5-flash': capabilities },
      fetchImplementation,
    }),
  successResponse: () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'safe normalized text' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 3,
          totalTokenCount: 7,
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
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2,"totalTokenCount":4}}\n\n',
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
    {
      choice: { delta: { content: '好' }, finishReason: 'stop' },
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    },
  ],
  assertRequest: (captured, streaming) => {
    expect(captured.url).toBe(
      streaming
        ? 'https://provider.example/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
        : 'https://provider.example/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(captured.headers.get('x-goog-api-key')).toBe('fake-gemini-secret');
    expect(captured.headers.get('x-request-id')).toBeNull();
    expect(captured.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'concise' }] },
      contents: [
        { role: 'user', parts: [{ text: 'private prompt text' }] },
        { role: 'model', parts: [{ text: 'prior answer' }] },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
      generationConfig: {
        candidateCount: 1,
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 32,
        thinkingConfig: { thinkingBudget: 0 },
        stopSequences: ['END'],
      },
    });
  },
});

describe('GeminiAdapter provider-specific rules', () => {
  it('translates tools and JSON Schema and normalizes function calls', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: {
        'gemini-test': {
          ...capabilities,
          tools: true,
          jsonObject: true,
          jsonSchema: true,
        },
      },
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('missing body');
        sentBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          id: 'call_1',
                          name: 'weather',
                          args: { city: 'Tokyo' },
                        },
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 8,
                candidatesTokenCount: 3,
                totalTokenCount: 11,
              },
            }),
          ),
        );
      },
    });
    const result = await adapter.createChatCompletion(
      {
        model: 'rax/gemini',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'weather',
              parameters: { type: 'object' },
            },
          },
        ],
        toolChoice: 'required',
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: 'answer',
            schema: { type: 'object', properties: {} },
          },
        },
      },
      {
        requestId: 'req_tools',
        providerModel: 'gemini-test',
        signal: new AbortController().signal,
      },
    );

    expect(sentBody).toMatchObject({
      tools: [
        {
          functionDeclarations: [
            { name: 'weather', parameters: { type: 'object' } },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object', properties: {} },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      response: {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call_1',
            function: { name: 'weather', arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
    });
  });

  it('translates prior tool results for a subsequent Gemini turn', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-test': { ...capabilities, tools: true } },
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== 'string') throw new Error('missing body');
        sentBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'done' }] },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 8,
                candidatesTokenCount: 1,
                totalTokenCount: 9,
              },
            }),
          ),
        );
      },
    });
    await adapter.createChatCompletion(
      {
        model: 'rax/gemini',
        messages: [
          { role: 'user', content: 'lookup' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"id":1}' },
              },
            ],
          },
          { role: 'tool', toolCallId: 'call_1', content: '{"value":42}' },
        ],
      },
      {
        requestId: 'req_tool_result',
        providerModel: 'gemini-test',
        signal: new AbortController().signal,
      },
    );
    expect(sentBody).toMatchObject({
      contents: [
        { role: 'user', parts: [{ text: 'lookup' }] },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'call_1', name: 'lookup' } }],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'lookup',
                response: { value: 42 },
              },
            },
          ],
        },
      ],
    });
  });

  it('classifies allowlisted Google API key reasons without exposing the body', async () => {
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-test': capabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message: 'raw secret-bearing upstream body',
                details: [
                  {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'API_KEY_INVALID',
                    metadata: { credential: 'raw-secret-value' },
                  },
                ],
              },
            }),
            { status: 400 },
          ),
        ),
    });

    const result = await adapter.createChatCompletion(
      { model: 'rax/fast', messages: [{ role: 'user', content: 'hi' }] },
      {
        requestId: 'req_auth_test',
        providerModel: 'gemini-test',
        signal: new AbortController().signal,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        class: 'authentication',
        code: 'provider_authentication_failed',
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('raw-secret-value');
    expect(JSON.stringify(result)).not.toContain('secret-bearing');
  });

  it('classifies a Google account precondition without exposing the body', async () => {
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-test': capabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                status: 'FAILED_PRECONDITION',
                message: 'raw account and billing details',
              },
            }),
            { status: 400 },
          ),
        ),
    });

    const result = await adapter.createChatCompletion(
      { model: 'rax/fast', messages: [{ role: 'user', content: 'hi' }] },
      {
        requestId: 'req_precondition_test',
        providerModel: 'gemini-test',
        signal: new AbortController().signal,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        class: 'authentication',
        code: 'provider_configuration_failed',
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('billing details');
  });

  it("classifies Google's fixed leaked-key message without exposing it", async () => {
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-test': capabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                status: 'PERMISSION_DENIED',
                message:
                  'Your API key was reported as leaked. Please use another API key.',
              },
            }),
            { status: 400 },
          ),
        ),
    });

    const result = await adapter.createChatCompletion(
      { model: 'rax/fast', messages: [{ role: 'user', content: 'hi' }] },
      {
        requestId: 'req_leaked_key_test',
        providerModel: 'gemini-test',
        signal: new AbortController().signal,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        class: 'authentication',
        code: 'provider_authentication_failed',
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('reported as leaked');
  });

  it('normalizes prompt safety blocks without inventing content', async () => {
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-test': capabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              promptFeedback: { blockReason: 'SAFETY' },
              usageMetadata: {
                promptTokenCount: 2,
                totalTokenCount: 2,
              },
            }),
          ),
        ),
    });

    await expect(
      adapter.createChatCompletion(
        { model: 'rax/fast', messages: [{ role: 'user', content: 'hi' }] },
        {
          requestId: 'req_safety_test',
          providerModel: 'gemini-test',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toEqual({
      ok: true,
      response: {
        content: '',
        finishReason: 'content_filter',
        usage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
      },
    });
  });

  it('normalizes an empty MAX_TOKENS candidate for completion and streaming', async () => {
    const responseBody = {
      candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }],
      usageMetadata: {
        promptTokenCount: 3,
        totalTokenCount: 11,
      },
    };
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-3.5-flash': capabilities },
      fetchImplementation: (input) =>
        Promise.resolve(
          typeof input === 'string' && input.includes('streamGenerateContent')
            ? new Response(`data: ${JSON.stringify(responseBody)}\n\n`, {
                headers: { 'content-type': 'text/event-stream' },
              })
            : new Response(JSON.stringify(responseBody), {
                headers: { 'content-type': 'application/json' },
              }),
        ),
    });
    const context = {
      requestId: 'req_empty_length_test',
      providerModel: 'gemini-3.5-flash',
      signal: new AbortController().signal,
    };
    const request = {
      model: 'rax/fast',
      messages: [{ role: 'user' as const, content: 'hi' }],
      maxTokens: 8,
    };

    await expect(
      adapter.createChatCompletion(request, context),
    ).resolves.toEqual({
      ok: true,
      response: {
        content: '',
        finishReason: 'length',
        usage: { promptTokens: 3, completionTokens: 0, totalTokens: 11 },
      },
    });

    const streamed = await adapter.streamChatCompletion(request, context);
    expect(streamed.ok).toBe(true);
    if (!streamed.ok) throw new Error('expected stream');
    const chunks = [];
    for await (const chunk of streamed.stream) chunks.push(chunk);
    expect(chunks).toEqual([
      {
        choice: { delta: { role: 'assistant' }, finishReason: 'length' },
        usage: { promptTokens: 3, completionTokens: 0, totalTokens: 11 },
      },
    ]);
  });

  it('rejects missing content without a terminal explanation', async () => {
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-test': capabilities },
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [{ content: {} }],
              usageMetadata: { promptTokenCount: 2, totalTokenCount: 2 },
            }),
          ),
        ),
    });

    await expect(
      adapter.createChatCompletion(
        { model: 'rax/fast', messages: [{ role: 'user', content: 'hi' }] },
        {
          requestId: 'req_missing_content_test',
          providerModel: 'gemini-test',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { class: 'protocol', code: 'provider_invalid_response' },
    });
  });

  it('bounds successful response bodies', async () => {
    const adapter = new GeminiAdapter({
      id: 'gemini-primary',
      baseUrl: 'https://provider.example/v1beta',
      apiKey: 'fake-gemini-secret',
      models: { 'gemini-test': capabilities },
      maxResponseBytes: 8,
      fetchImplementation: () =>
        Promise.resolve(new Response('{"oversized":"provider response"}')),
    });

    await expect(
      adapter.createChatCompletion(
        { model: 'rax/fast', messages: [{ role: 'user', content: 'hi' }] },
        {
          requestId: 'req_bound_test',
          providerModel: 'gemini-test',
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { class: 'protocol', code: 'provider_invalid_response' },
    });
  });
});
