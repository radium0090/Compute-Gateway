import { describe, expect, it, vi } from 'vitest';

import { Genchi, GenchiApiError, GenchiConnectionError } from './client.js';

const request = {
  model: 'genchi/fast',
  messages: [{ role: 'user' as const, content: 'test prompt' }],
};

describe('Genchi TypeScript SDK', () => {
  it('creates completions and lists models with bearer authentication', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: 'chatcmpl_test',
          object: 'chat.completion',
          created: 1,
          model: 'genchi/fast',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'answer' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          genchi: {
            request_id: 'req_test',
            provider: 'openai',
            provider_model: 'gpt-test',
            attempts: 1,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          object: 'list',
          data: [
            {
              id: 'genchi/fast',
              object: 'model',
              created: 1,
              owned_by: 'genchi',
            },
          ],
        }),
      );
    const client = new Genchi({
      apiKey: 'fake-client-key',
      baseUrl: 'http://genchi.test/v1/',
      maxRetries: 0,
      fetchImplementation,
    });

    await expect(
      client.chat.completions.create(request),
    ).resolves.toMatchObject({
      choices: [{ message: { content: 'answer' } }],
    });
    await expect(client.models.list()).resolves.toMatchObject({
      data: [{ id: 'genchi/fast' }],
    });
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      'http://genchi.test/v1/chat/completions',
    );
    expect(
      new Headers(fetchImplementation.mock.calls[0]?.[1]?.headers).get(
        'authorization',
      ),
    ).toBe('Bearer fake-client-key');
  });

  it('maps canonical errors and retries only pre-response failures', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              message: 'The requested model is not available.',
              type: 'model_unavailable_error',
              code: 'no_healthy_route',
              param: 'model',
            },
            genchi: { request_id: 'req_error', retryable: true },
          },
          { status: 503 },
        ),
      );
    const client = new Genchi({
      apiKey: 'fake-client-key',
      baseUrl: 'http://genchi.test/v1',
      maxRetries: 1,
      fetchImplementation,
    });

    const error = await client.chat.completions
      .create(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenchiApiError);
    expect(error).toMatchObject({
      status: 503,
      code: 'no_healthy_route',
      requestId: 'req_error',
      retryable: true,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('parses split SSE events and cancels the body when iteration stops', async () => {
    let cancelled = false;
    const encoded = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoded.encode(
            'data: {"id":"one","object":"chat.completion.chunk","created":1,',
          ),
        );
        controller.enqueue(
          encoded.encode(
            '"model":"genchi/fast","choices":[],"genchi":{"request_id":"req","provider":"openai","provider_model":"gpt","attempts":1}}\n\n',
          ),
        );
        controller.enqueue(encoded.encode('data: [DONE]\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new Genchi({
      apiKey: 'fake-client-key',
      maxRetries: 0,
      fetchImplementation: () =>
        Promise.resolve(
          new Response(body, {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
    });

    const stream = await client.chat.completions.stream(request);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it('rejects missing credentials and network timeouts safely', async () => {
    expect(() => new Genchi({ apiKey: '' })).toThrow(TypeError);
    const client = new Genchi({
      apiKey: 'fake-client-key',
      timeoutMs: 1,
      maxRetries: 0,
      fetchImplementation: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    await expect(client.models.list()).rejects.toBeInstanceOf(
      GenchiConnectionError,
    );
  });
});
