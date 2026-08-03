import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '@genchi/config';
import { createLogger } from '@genchi/observability';

import { buildGateway } from './app.js';

const config = loadConfig({
  GENCHI_ENVIRONMENT: 'test',
  GENCHI_DATABASE_URL: 'postgresql://genchi:fake@localhost:5432/genchi',
  GENCHI_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});

function injectFetch(app: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const url =
      input instanceof Request
        ? new URL(input.url)
        : new URL(input instanceof URL ? input.href : input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        responseHeaders.set(
          name,
          Array.isArray(value) ? value.join(', ') : String(value),
        );
      }
    }
    return new Response(response.rawPayload, {
      status: response.statusCode,
      headers: responseHeaders,
    });
  };
}

describe('OpenAI Node SDK compatibility', () => {
  it('supports completion, streaming, and model list calls', async () => {
    const app = await buildGateway({
      config,
      logger: createLogger({ environment: 'test', level: 'error' }),
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
      chatCompletionService: {
        execute: () =>
          Promise.resolve({
            ok: true,
            response: {
              content: 'SDK answer',
              finishReason: 'stop',
              usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
            },
            route: {
              providerRef: 'openai-primary',
              provider: 'openai',
              providerModel: 'gpt-test',
            },
            attempts: 1,
          }),
        executeStream: () =>
          Promise.resolve({
            ok: true,
            stream: (async function* () {
              await Promise.resolve();
              yield {
                choice: { delta: { content: 'SDK' }, finishReason: null },
              };
              yield {
                choice: { delta: { content: ' stream' }, finishReason: 'stop' },
              };
            })(),
            route: {
              providerRef: 'openai-primary',
              provider: 'openai',
              providerModel: 'gpt-test',
            },
            attempts: 1,
          }),
      },
      listModelsService: {
        execute: () =>
          Promise.resolve({ ok: true, models: [{ id: 'genchi/fast' }] }),
      },
    });
    const client = new OpenAI({
      apiKey: 'fake-client-key',
      baseURL: 'http://genchi.test/v1',
      fetch: injectFetch(app),
      maxRetries: 0,
    });

    const completion = await client.chat.completions.create({
      model: 'genchi/fast',
      messages: [{ role: 'user', content: 'SDK smoke prompt' }],
    });
    expect(completion.choices[0]?.message.content).toBe('SDK answer');

    const stream = await client.chat.completions.create({
      model: 'genchi/fast',
      messages: [{ role: 'user', content: 'SDK stream prompt' }],
      stream: true,
    });
    let streamed = '';
    for await (const chunk of stream) {
      streamed += chunk.choices[0]?.delta.content ?? '';
    }
    expect(streamed).toBe('SDK stream');

    const models = await client.models.list();
    expect(models.data.map((model) => model.id)).toEqual(['genchi/fast']);
    await app.close();
  });
});
