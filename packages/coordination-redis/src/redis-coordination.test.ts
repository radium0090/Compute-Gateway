import { describe, expect, it } from 'vitest';

import { apiKeyId } from '@genchi/domain';
import type { ResolvedRoute } from '@genchi/domain';

import {
  RedisCoordination,
  type RedisCommandClient,
} from './redis-coordination.js';

const circuitOptions = {
  failureThreshold: 2,
  rollingWindowMs: 10_000,
  openDurationMs: 5_000,
  halfOpenMaxCalls: 1,
};

const route: ResolvedRoute = {
  providerRef: 'openai-primary',
  provider: 'openai',
  providerModel: 'model-a',
};

function client(results: unknown[]): RedisCommandClient & {
  readonly calls: {
    readonly script: string;
    readonly keys: readonly string[];
    readonly arguments: readonly string[];
  }[];
} {
  const calls: {
    readonly script: string;
    readonly keys: readonly string[];
    readonly arguments: readonly string[];
  }[] = [];
  return {
    calls,
    eval: (script, options) => {
      calls.push({ script, keys: options.keys, arguments: options.arguments });
      const result = results.shift();
      return result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result);
    },
    ping: () => Promise.resolve('PONG'),
    quit: () => Promise.resolve(),
  };
}

describe('RedisCoordination', () => {
  it('acquires and releases an opaque per-key distributed lease', async () => {
    const commands = client([[1, 0, 0], 1]);
    const coordination = new RedisCoordination(
      commands,
      circuitOptions,
      () => 10_000,
    );
    const result = await coordination.acquire({
      apiKeyId: apiKeyId('internal-key-id'),
      requestsPerMinute: 60,
      maxConcurrentRequests: 4,
      leaseTtlMs: 65_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) await result.lease.release();
    expect(commands.calls).toHaveLength(2);
    expect(JSON.stringify(commands.calls)).not.toContain('internal-key-id');
    expect(commands.calls[0]?.script).toContain('ZREMRANGEBYSCORE');
    expect(commands.calls[0]?.arguments[5]).toBe(
      commands.calls[1]?.arguments[0],
    );
    expect(commands.calls[1]?.script).toContain('ZREM');
  });

  it('fails closed on Redis errors and preserves retry timing', async () => {
    const unavailable = new RedisCoordination(
      client([new Error('connection lost')]),
      circuitOptions,
    );
    await expect(
      unavailable.acquire({
        apiKeyId: apiKeyId('key-unavailable'),
        requestsPerMinute: 60,
        maxConcurrentRequests: 4,
        leaseTtlMs: 60_000,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'coordination_unavailable',
    });

    const limited = new RedisCoordination(
      client([[0, 1, 4_500]]),
      circuitOptions,
    );
    await expect(
      limited.acquire({
        apiKeyId: apiKeyId('key-limited'),
        requestsPerMinute: 1,
        maxConcurrentRequests: 4,
        leaseTtlMs: 60_000,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 5,
    });
  });

  it('returns typed circuit permits and records outcomes', async () => {
    const commands = client([[1, 1, 0], 1]);
    const coordination = new RedisCoordination(
      commands,
      circuitOptions,
      () => 10_000,
    );
    const permit = await coordination.acquire(route);

    expect(permit).toMatchObject({ ok: true, permit: { probe: true, route } });
    if (!permit.ok) return;
    await coordination.record(permit.permit, 'failure');
    expect(commands.calls).toHaveLength(2);
  });

  it('reports readiness without exposing Redis errors', async () => {
    const coordination = new RedisCoordination(client([]), circuitOptions);
    await expect(coordination.check()).resolves.toEqual({ ready: true });
  });
});
