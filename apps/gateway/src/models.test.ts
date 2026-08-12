import { describe, expect, it } from 'vitest';

import { loadConfig } from '@rax-digital/config';
import { createLogger } from '@rax-digital/observability';

import { buildGateway } from './app.js';

const config = loadConfig({
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://rcg:fake@localhost:5432/compute_gateway',
  RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});
const logger = createLogger({ environment: 'test', level: 'error' });
const readinessProbe = { check: () => Promise.resolve({ ready: true }) };

describe('GET /v1/models', () => {
  it('returns only models selected by the authenticated catalog service', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe,
      listModelsService: {
        execute: (credential) =>
          Promise.resolve(
            credential === 'fake-client-key'
              ? {
                  ok: true,
                  models: [{ id: 'rax/fast' }, { id: 'openai/gpt-test' }],
                }
              : { ok: false, failure: 'authentication' },
          ),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'bearer fake-client-key' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: 'list',
      data: [
        { id: 'rax/fast', object: 'model', owned_by: 'rax-digital' },
        { id: 'openai/gpt-test', object: 'model', owned_by: 'rax-digital' },
      ],
    });
    await app.close();
  });

  it('uses the canonical authentication error', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe,
      listModelsService: {
        execute: () =>
          Promise.resolve({ ok: false, failure: 'authentication' }),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { type: 'authentication_error', code: 'invalid_api_key' },
      rax: { retryable: false },
    });
    await app.close();
  });
});
