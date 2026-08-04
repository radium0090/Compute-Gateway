import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '@genchi/config';
import { ProviderStreamFailure } from '@genchi/domain';
import { createLogger } from '@genchi/observability';

import { buildGateway } from './app.js';

const config = loadConfig({
  GENCHI_ENVIRONMENT: 'test',
  GENCHI_DATABASE_URL: 'postgresql://genchi:fake@localhost:5432/genchi',
  GENCHI_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});
const logger = createLogger({ environment: 'test', level: 'error' });
const readinessProbe = { check: () => Promise.resolve({ ready: true }) };
const validBody = {
  model: 'genchi/fast',
  messages: [{ role: 'user', content: 'private prompt' }],
};

describe('POST /v1/chat/completions', () => {
  it('returns an OpenAI-compatible normalized response', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe,
      chatCompletionService: {
        executeStream: () => {
          throw new Error('streaming is not used by this test');
        },
        execute: () =>
          Promise.resolve({
            ok: true,
            response: {
              content: 'normalized answer',
              finishReason: 'stop',
              usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
            },
            route: {
              providerRef: 'openai-primary',
              provider: 'openai',
              providerModel: 'gpt-test',
            },
            attempts: 1,
          }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-genchi-key' },
      payload: validBody,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'chat.completion',
      model: 'genchi/fast',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'normalized answer' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      genchi: {
        provider: 'openai',
        provider_model: 'gpt-test',
        attempts: 1,
      },
    });
    expect(response.headers['x-request-id']).toBeTruthy();
    await app.close();
  });

  it('returns the uniform authentication error', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe,
      chatCompletionService: {
        executeStream: () => {
          throw new Error('streaming is not used by this test');
        },
        execute: () =>
          Promise.resolve({
            ok: false,
            failure: { kind: 'authentication' },
          }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: validBody,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        message: 'Invalid authentication credentials.',
        type: 'authentication_error',
        code: 'invalid_api_key',
        param: null,
      },
      genchi: {
        request_id: response.headers['x-request-id'],
        retryable: false,
      },
    });
    await app.close();
  });

  it('returns the canonical request deadline error', async () => {
    let serviceCalled = false;
    const app = await buildGateway({
      config,
      logger,
      readinessProbe,
      requestTimeoutSignalFactory: () => AbortSignal.abort(),
      chatCompletionService: {
        executeStream: () => {
          throw new Error('streaming is not used by this test');
        },
        execute: () => {
          serviceCalled = true;
          return Promise.reject(new Error('expired request must not execute'));
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-genchi-key' },
      payload: validBody,
    });

    expect(response.statusCode).toBe(408);
    expect(response.json()).toMatchObject({
      error: { type: 'timeout_error', code: 'request_deadline_exceeded' },
      genchi: { retryable: true },
    });
    expect(serviceCalled).toBe(false);
    await app.close();
  });

  it('does not open a provider stream after the request deadline', async () => {
    let serviceCalled = false;
    const app = await buildGateway({
      config,
      logger,
      readinessProbe,
      requestTimeoutSignalFactory: () => AbortSignal.abort(),
      chatCompletionService: {
        execute: () => {
          throw new Error('non-streaming is not used by this test');
        },
        executeStream: () => {
          serviceCalled = true;
          return Promise.reject(new Error('expired stream must not execute'));
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-genchi-key' },
      payload: { ...validBody, stream: true },
    });

    expect(response.statusCode).toBe(408);
    expect(response.json()).toMatchObject({
      error: { type: 'timeout_error', code: 'request_deadline_exceeded' },
      genchi: { retryable: true },
    });
    expect(serviceCalled).toBe(false);
    await app.close();
  });

  it('rejects unknown request fields with the canonical envelope', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe,
      chatCompletionService: {
        executeStream: () => {
          throw new Error('streaming is not used by this test');
        },
        execute: () => {
          throw new Error('validation should run before the service');
        },
      },
    });

    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-genchi-key' },
      payload: { ...validBody, unsupported: 'value' },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'invalid_request' },
    });
    await app.close();
  });

  it('emits ordered OpenAI-compatible SSE chunks followed by DONE', async () => {
    let logOutput = '';
    const streamLogger = createLogger({
      environment: 'test',
      level: 'info',
      destination: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          logOutput += chunk.toString('utf8');
          callback();
        },
      }),
    });
    const app = await buildGateway({
      config,
      logger: streamLogger,
      readinessProbe,
      chatCompletionService: {
        execute: () => {
          throw new Error('non-streaming is not used by this test');
        },
        executeStream: () =>
          Promise.resolve({
            ok: true,
            stream: (async function* () {
              await Promise.resolve();
              yield {
                choice: { delta: { content: 'first' }, finishReason: null },
              };
              yield {
                choice: { delta: { content: ' second' }, finishReason: 'stop' },
              };
              yield {
                usage: {
                  promptTokens: 2,
                  completionTokens: 2,
                  totalTokens: 4,
                },
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
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-genchi-key' },
      payload: { ...validBody, stream: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = response.body
      .split('\n\n')
      .filter(Boolean)
      .map((event) => event.replace(/^data: /, ''));
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events
      .slice(0, -1)
      .map((event) => JSON.parse(event) as unknown);
    expect(chunks).toMatchObject([
      {
        object: 'chat.completion.chunk',
        model: 'genchi/fast',
        choices: [
          {
            delta: { role: 'assistant', content: 'first' },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: { content: ' second' }, finish_reason: 'stop' }],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 2,
          total_tokens: 4,
        },
      },
    ]);
    expect(logOutput).toContain('request.completed');
    expect(logOutput).not.toContain('first');
    expect(logOutput).not.toContain(' second');
    await app.close();
  });

  it('returns JSON errors before SSE commitment and closes after mid-stream failure', async () => {
    const preCommit = await buildGateway({
      config,
      logger,
      readinessProbe,
      chatCompletionService: {
        execute: () => {
          throw new Error('not used');
        },
        executeStream: () =>
          Promise.resolve({
            ok: false,
            failure: {
              kind: 'provider',
              error: {
                class: 'rate_limit',
                code: 'provider_rate_limited',
                retryable: true,
                retryAfterSeconds: 2,
              },
            },
          }),
      },
    });
    const errorResponse = await preCommit.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-genchi-key' },
      payload: { ...validBody, stream: true },
    });
    expect(errorResponse.statusCode).toBe(429);
    expect(errorResponse.headers['retry-after']).toBe('2');
    expect(errorResponse.json()).toMatchObject({
      error: { code: 'provider_rate_limited' },
    });
    await preCommit.close();

    const midStream = await buildGateway({
      config,
      logger,
      readinessProbe,
      chatCompletionService: {
        execute: () => {
          throw new Error('not used');
        },
        executeStream: () =>
          Promise.resolve({
            ok: true,
            stream: (async function* () {
              await Promise.resolve();
              yield {
                choice: { delta: { content: 'partial' }, finishReason: null },
              };
              throw new ProviderStreamFailure({
                class: 'unavailable',
                code: 'provider_stream_interrupted',
                retryable: true,
              });
            })(),
            route: {
              providerRef: 'openai-primary',
              provider: 'openai',
              providerModel: 'gpt-test',
            },
            attempts: 1,
          }),
      },
    });
    const partial = await midStream.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-genchi-key' },
      payload: { ...validBody, stream: true },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.body).toContain('partial');
    expect(partial.body).not.toContain('[DONE]');
    await midStream.close();
  });
});
