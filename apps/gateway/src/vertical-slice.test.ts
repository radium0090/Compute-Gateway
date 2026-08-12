import { describe, expect, it } from 'vitest';

import { CreateChatCompletionService } from '@rax-digital/application';
import { loadConfig, parsePolicyConfig } from '@rax-digital/config';
import {
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  tenantId,
  type ApiKey,
} from '@rax-digital/domain';
import { createLogger } from '@rax-digital/observability';
import { OpenAiAdapter } from '@rax-digital/provider-openai';
import { StaticPolicyRouter } from '@rax-digital/router';

import { buildGateway } from './app.js';

const config = loadConfig({
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://rcg:fake@localhost:5432/compute_gateway',
  RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});

const policy = parsePolicyConfig(
  `
version: 1
providers:
  openai-primary:
    adapter: openai
    credential_env: OPENAI_API_KEY
    base_url: https://provider.example/v1
    models:
      gpt-test: { capabilities: [chat] }
aliases:
  rax/fast:
    candidates:
      - { provider: openai-primary, model: gpt-test, weight: 100 }
routing:
  max_attempts: 1
  total_timeout_ms: 60000
`,
  'test',
);

const apiKey: ApiKey = {
  id: apiKeyId('01989c9b-a400-7000-8000-000000000001'),
  publicId: apiKeyPublicId('public-id-123'),
  keyHash: apiKeyHash('a'.repeat(64)),
  tenantId: tenantId('01989c9b-a400-7000-8000-000000000002'),
  name: 'vertical slice key',
  environment: 'test',
  status: 'active',
  policy: {
    allowedModelPatterns: ['rax/*'],
    allowStreaming: false,
    allowTools: false,
    requestsPerMinute: 60,
    maxConcurrentRequests: 4,
  },
  createdAt: new Date('2026-08-03T00:00:00Z'),
  expiresAt: null,
};

describe('authenticated OpenAI vertical slice', () => {
  it('runs the full in-process request translation and normalization path', async () => {
    let providerRequest: unknown;
    const adapter = new OpenAiAdapter({
      id: 'openai-primary',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'fake-provider-key',
      models: {
        'gpt-test': {
          chat: true,
          streaming: false,
          tools: false,
          jsonObject: false,
          jsonSchema: false,
          systemMessages: true,
        },
      },
      fetchImplementation: (_input, init) => {
        providerRequest =
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as unknown)
            : null;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: 'assistant', content: 'vertical answer' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 2,
                total_tokens: 4,
              },
            }),
            { status: 200 },
          ),
        );
      },
    });
    const service = new CreateChatCompletionService(
      {
        authenticate: (credential) =>
          Promise.resolve(
            credential === 'fake-client-key'
              ? { authenticated: true, apiKey }
              : { authenticated: false },
          ),
      },
      new StaticPolicyRouter(policy),
      new Map([['openai-primary', adapter]]),
    );
    const app = await buildGateway({
      config,
      logger: createLogger({ environment: 'test', level: 'error' }),
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
      chatCompletionService: service,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer fake-client-key' },
      payload: {
        model: 'rax/fast',
        messages: [{ role: 'user', content: 'vertical prompt' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(providerRequest).toMatchObject({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'vertical prompt' }],
    });
    expect(response.json()).toMatchObject({
      model: 'rax/fast',
      choices: [{ message: { content: 'vertical answer' } }],
      rax: { provider: 'openai', provider_model: 'gpt-test', attempts: 1 },
    });
    await app.close();
  });
});
