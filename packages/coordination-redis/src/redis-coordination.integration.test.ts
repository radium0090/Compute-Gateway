import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiKeyId, type ResolvedRoute } from '@genchi/domain';

import {
  RedisCoordination,
  createRedisCoordination,
} from './redis-coordination.js';

const redisUrl = process.env.GENCHI_TEST_REDIS_URL;
const describeIntegration = redisUrl === undefined ? describe.skip : describe;

describeIntegration('RedisCoordination integration', () => {
  let coordination: RedisCoordination;
  const suffix = randomUUID();
  const route: ResolvedRoute = {
    providerRef: `provider-${suffix}`,
    provider: 'openai',
    providerModel: 'integration-model',
  };

  beforeAll(async () => {
    coordination = await createRedisCoordination({
      redisUrl: redisUrl ?? 'redis://integration-test.invalid:6379',
      connectTimeoutMs: 5_000,
      circuit: {
        failureThreshold: 1,
        rollingWindowMs: 10_000,
        openDurationMs: 10_000,
        halfOpenMaxCalls: 1,
      },
    });
  });

  afterAll(async () => {
    await coordination.close();
  });

  it('coordinates rate, concurrency, readiness, and circuit state atomically', async () => {
    const request = {
      apiKeyId: apiKeyId(`key-${suffix}`),
      requestsPerMinute: 1,
      maxConcurrentRequests: 1,
      leaseTtlMs: 10_000,
    };
    const admission = await coordination.acquire(request);
    expect(admission.ok).toBe(true);
    if (admission.ok) await admission.lease.release();
    await expect(coordination.acquire(request)).resolves.toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });

    const provider = await coordination.acquire({
      route,
      globalLimit: 100,
      providerLimit: 1,
      leaseTtlMs: 10_000,
    });
    expect(provider.ok).toBe(true);
    if (provider.ok) await provider.lease.release();

    const permit = await coordination.acquire(route);
    expect(permit.ok).toBe(true);
    if (permit.ok) await coordination.record(permit.permit, 'failure');
    await expect(coordination.acquire(route)).resolves.toMatchObject({
      ok: false,
      reason: 'open',
    });
    await expect(coordination.check()).resolves.toEqual({ ready: true });
  });
});
