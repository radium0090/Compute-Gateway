import { describe, expect, it } from 'vitest';

import { apiKeyId } from '@genchi/domain';
import type { ResolvedRoute } from '@genchi/domain';

import {
  InMemoryCircuitBreaker,
  InMemoryCoordination,
} from './in-memory-resilience.js';

const route: ResolvedRoute = {
  providerRef: 'openai-primary',
  provider: 'openai',
  providerModel: 'model-a',
};

describe('InMemoryCoordination', () => {
  it('enforces per-key fixed-window request rate', async () => {
    const coordination = new InMemoryCoordination(() => 10_000);
    const input = {
      apiKeyId: apiKeyId('key-rate'),
      requestsPerMinute: 2,
      maxConcurrentRequests: 10,
      leaseTtlMs: 60_000,
    };
    const first = await coordination.acquire(input);
    const second = await coordination.acquire(input);
    if (first.ok) await first.lease.release();
    if (second.ok) await second.lease.release();

    await expect(coordination.acquire(input)).resolves.toMatchObject({
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: 50,
    });
  });

  it('releases per-key and provider concurrency leases idempotently', async () => {
    const coordination = new InMemoryCoordination();
    const keyInput = {
      apiKeyId: apiKeyId('key-concurrency'),
      requestsPerMinute: 100,
      maxConcurrentRequests: 1,
      leaseTtlMs: 60_000,
    };
    const first = await coordination.acquire(keyInput);
    expect(first.ok).toBe(true);
    await expect(coordination.acquire(keyInput)).resolves.toMatchObject({
      ok: false,
      reason: 'concurrency_limited',
    });
    if (first.ok) {
      await first.lease.release();
      await first.lease.release();
    }
    await expect(coordination.acquire(keyInput)).resolves.toMatchObject({
      ok: true,
    });

    const providerInput = {
      route,
      globalLimit: 1,
      providerLimit: 1,
      leaseTtlMs: 60_000,
    };
    const providerFirst = await coordination.acquire(providerInput);
    expect(providerFirst.ok).toBe(true);
    await expect(coordination.acquire(providerInput)).resolves.toMatchObject({
      ok: false,
      reason: 'concurrency_limited',
    });
    if (providerFirst.ok) await providerFirst.lease.release();
    await expect(coordination.acquire(providerInput)).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe('InMemoryCircuitBreaker', () => {
  it('counts failures across successful closed-state calls in the rolling window', async () => {
    const circuit = new InMemoryCircuitBreaker({
      failureThreshold: 2,
      rollingWindowMs: 10_000,
      openDurationMs: 5_000,
      halfOpenMaxCalls: 1,
      clock: () => 1_000,
    });
    const firstFailure = await circuit.acquire(route);
    const success = await circuit.acquire(route);
    const secondFailure = await circuit.acquire(route);
    if (!firstFailure.ok || !success.ok || !secondFailure.ok) {
      throw new Error('expected closed circuit permits');
    }
    await circuit.record(firstFailure.permit, 'failure');
    await circuit.record(success.permit, 'success');
    await circuit.record(secondFailure.permit, 'failure');

    await expect(circuit.acquire(route)).resolves.toMatchObject({
      ok: false,
      reason: 'open',
    });
  });

  it('opens after the rolling threshold and closes after a successful probe', async () => {
    let now = 1_000;
    const circuit = new InMemoryCircuitBreaker({
      failureThreshold: 2,
      rollingWindowMs: 10_000,
      openDurationMs: 5_000,
      halfOpenMaxCalls: 1,
      clock: () => now,
    });
    const first = await circuit.acquire(route);
    const second = await circuit.acquire(route);
    if (!first.ok || !second.ok) throw new Error('expected closed circuit');
    await circuit.record(first.permit, 'failure');
    await circuit.record(second.permit, 'failure');

    await expect(circuit.acquire(route)).resolves.toMatchObject({
      ok: false,
      reason: 'open',
      retryAfterSeconds: 5,
    });
    now += 5_001;
    const probe = await circuit.acquire(route);
    expect(probe).toMatchObject({ ok: true, permit: { probe: true } });
    await expect(circuit.acquire(route)).resolves.toMatchObject({
      ok: false,
      reason: 'open',
    });
    if (!probe.ok) throw new Error('expected half-open probe');
    await circuit.record(probe.permit, 'success');
    await expect(circuit.acquire(route)).resolves.toMatchObject({
      ok: true,
      permit: { probe: false },
    });
  });
});
