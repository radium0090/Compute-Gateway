import { describe, expect, it } from 'vitest';

import { loadConfig } from '@genchi/config';
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

  it('rejects unsupported streaming with the canonical envelope', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe,
      chatCompletionService: {
        execute: () => {
          throw new Error('validation should run before the service');
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-genchi-key' },
      payload: { ...validBody, stream: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'invalid_request' },
      genchi: { retryable: false },
    });
    expect(response.body).not.toContain('validation should run');

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
});
