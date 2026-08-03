import { describe, expect, it } from 'vitest';

import { parsePolicyConfig } from '@genchi/config';
import {
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  tenantId,
  type ApiKey,
} from '@genchi/domain';

import { StaticModelCatalog, StaticPolicyRouter } from './policy-router.js';

const policy = parsePolicyConfig(
  `
version: 1
providers:
  openai-a:
    adapter: openai
    credential_env: OPENAI_API_KEY
    base_url: https://api.openai.com/v1
    models:
      model-a: { capabilities: [chat] }
  openai-b:
    adapter: openai
    credential_env: OPENAI_API_KEY_B
    base_url: https://api.openai.com/v1
    models:
      model-b: { capabilities: [chat, streaming] }
  openai-c:
    adapter: openai
    credential_env: OPENAI_API_KEY_C
    base_url: https://api.openai.com/v1
    models:
      model-c: { capabilities: [chat, streaming] }
aliases:
  genchi/fast:
    candidates:
      - { provider: openai-a, model: model-a, weight: 50 }
      - { provider: openai-b, model: model-b, weight: 50 }
      - { provider: openai-c, model: model-c, weight: 0 }
routing:
  max_attempts: 2
  total_timeout_ms: 60000
`,
  'test',
);

function key(patterns: readonly string[]): ApiKey {
  return {
    id: apiKeyId('01989c9b-a400-7000-8000-000000000001'),
    publicId: apiKeyPublicId('public-id-123'),
    keyHash: apiKeyHash('a'.repeat(64)),
    tenantId: tenantId('01989c9b-a400-7000-8000-000000000002'),
    name: 'router test',
    environment: 'test',
    status: 'active',
    policy: {
      allowedModelPatterns: patterns,
      allowStreaming: false,
      allowTools: false,
      requestsPerMinute: 60,
      maxConcurrentRequests: 4,
    },
    createdAt: new Date('2026-08-03T00:00:00Z'),
    expiresAt: null,
  };
}

describe('StaticPolicyRouter', () => {
  it('returns the same weighted primary for the same request and alias', () => {
    const router = new StaticPolicyRouter(policy);
    const input = {
      requestedModel: 'genchi/fast',
      requestId: 'req_stable_123',
      apiKey: key(['genchi/*']),
    };

    expect(router.resolve(input)).toEqual(router.resolve(input));
  });

  it('distributes stable hashes across configured positive-weight routes', () => {
    const router = new StaticPolicyRouter(policy);
    const selected = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const result = router.resolve({
        requestedModel: 'genchi/fast',
        requestId: `req_${String(index).padStart(3, '0')}`,
        apiKey: key(['genchi/*']),
      });
      if (result.ok) {
        selected.add(result.route.providerRef);
      }
    }
    expect(selected).toEqual(new Set(['openai-a', 'openai-b']));
  });

  it('builds a primary-first plan followed by ordered fallback candidates', () => {
    const router = new StaticPolicyRouter(policy);
    const result = router.plan({
      requestedModel: 'genchi/fast',
      requestId: 'req_plan',
      apiKey: key(['genchi/*']),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.routes).toHaveLength(3);
    expect(result.plan.routes[0]?.providerRef).toMatch(/^openai-[ab]$/);
    expect(result.plan.routes.at(-1)?.providerRef).toBe('openai-c');
    expect(
      new Set(result.plan.routes.map((route) => route.providerRef)),
    ).toEqual(new Set(['openai-a', 'openai-b', 'openai-c']));
    expect(result.plan.candidateCount).toBe(3);
    expect(result.plan.selectionReason).toBe('stable_weighted_primary');
  });

  it('denies by default and resolves an unambiguous qualified model', () => {
    const router = new StaticPolicyRouter(policy);

    expect(
      router.resolve({
        requestedModel: 'genchi/fast',
        requestId: 'req_denied',
        apiKey: key([]),
      }),
    ).toEqual({ ok: false, reason: 'model_not_allowed' });
    expect(
      router.resolve({
        requestedModel: 'openai/model-a',
        requestId: 'req_qualified',
        apiKey: key(['openai/*']),
      }),
    ).toMatchObject({
      ok: true,
      route: { provider: 'openai', providerModel: 'model-a' },
    });
    expect(
      router.plan({
        requestedModel: 'openai/model-a',
        requestId: 'req_qualified',
        apiKey: key(['openai/*']),
      }),
    ).toMatchObject({
      ok: true,
      plan: { selectionReason: 'qualified_model' },
    });
  });

  it('filters routes that do not support requested streaming', () => {
    const router = new StaticPolicyRouter(policy);

    expect(
      router.resolve({
        requestedModel: 'genchi/fast',
        requestId: 'req_streaming',
        apiKey: key(['genchi/*']),
        requireStreaming: true,
      }),
    ).toMatchObject({
      ok: true,
      route: { providerRef: 'openai-b', providerModel: 'model-b' },
    });
    expect(
      router.resolve({
        requestedModel: 'openai/model-a',
        requestId: 'req_streaming_qualified',
        apiKey: key(['openai/*']),
        requireStreaming: true,
      }),
    ).toEqual({ ok: false, reason: 'model_not_found' });
  });

  it('lists only configured and key-allowed public models', () => {
    const catalog = new StaticModelCatalog(policy);

    expect(catalog.listAllowed(key(['genchi/*']))).toEqual([
      { id: 'genchi/fast' },
    ]);
    expect(catalog.listAllowed(key(['openai/*']))).toEqual([
      { id: 'openai/model-a' },
      { id: 'openai/model-b' },
      { id: 'openai/model-c' },
    ]);
    expect(catalog.listAllowed(key([]))).toEqual([]);
  });
});
