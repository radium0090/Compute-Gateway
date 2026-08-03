import { randomUUID } from 'node:crypto';

import type {
  AdmissionResult,
  CircuitBreaker,
  CircuitOutcome,
  CircuitPermit,
  CircuitPermitResult,
  CoordinationLease,
  ProviderConcurrencyController,
  RequestAdmissionController,
  ResolvedRoute,
} from '@genchi/domain';

interface KeyLimitState {
  bucket: number;
  count: number;
  inFlight: number;
}

function timedLease(ttlMs: number, release: () => void): CoordinationLease {
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    release();
  };
  const timer = setTimeout(releaseOnce, ttlMs);
  timer.unref();
  return {
    release: () => {
      releaseOnce();
      return Promise.resolve();
    },
  };
}

/** Single-process coordination for development and one-replica deployments. */
export class InMemoryCoordination
  implements RequestAdmissionController, ProviderConcurrencyController
{
  private readonly keyLimits = new Map<string, KeyLimitState>();
  private readonly providerInFlight = new Map<string, number>();
  private globalInFlight = 0;

  public constructor(private readonly clock: () => number = Date.now) {}

  public acquire(input: {
    readonly apiKeyId?: string;
    readonly requestsPerMinute?: number;
    readonly maxConcurrentRequests?: number;
    readonly route?: ResolvedRoute;
    readonly globalLimit?: number;
    readonly providerLimit?: number;
    readonly leaseTtlMs: number;
  }): Promise<AdmissionResult> {
    return input.apiKeyId === undefined
      ? this.acquireProvider(input)
      : this.acquireRequest({
          apiKeyId: input.apiKeyId,
          ...(input.requestsPerMinute === undefined
            ? {}
            : { requestsPerMinute: input.requestsPerMinute }),
          ...(input.maxConcurrentRequests === undefined
            ? {}
            : { maxConcurrentRequests: input.maxConcurrentRequests }),
          leaseTtlMs: input.leaseTtlMs,
        });
  }

  private acquireRequest(input: {
    readonly apiKeyId: string;
    readonly requestsPerMinute?: number;
    readonly maxConcurrentRequests?: number;
    readonly leaseTtlMs: number;
  }): Promise<AdmissionResult> {
    if (
      input.requestsPerMinute === undefined ||
      input.maxConcurrentRequests === undefined
    ) {
      return Promise.resolve({
        ok: false,
        reason: 'coordination_unavailable',
      });
    }
    const now = this.clock();
    const bucket = Math.floor(now / 60_000);
    const state = this.keyLimits.get(input.apiKeyId) ?? {
      bucket,
      count: 0,
      inFlight: 0,
    };
    if (state.bucket !== bucket) {
      state.bucket = bucket;
      state.count = 0;
    }
    if (state.count >= input.requestsPerMinute) {
      return Promise.resolve({
        ok: false,
        reason: 'rate_limited',
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(((bucket + 1) * 60_000 - now) / 1_000),
        ),
      });
    }
    if (state.inFlight >= input.maxConcurrentRequests) {
      return Promise.resolve({
        ok: false,
        reason: 'concurrency_limited',
        retryAfterSeconds: 1,
      });
    }
    state.count += 1;
    state.inFlight += 1;
    this.keyLimits.set(input.apiKeyId, state);
    return Promise.resolve({
      ok: true,
      lease: timedLease(input.leaseTtlMs, () => {
        state.inFlight = Math.max(0, state.inFlight - 1);
      }),
    });
  }

  private acquireProvider(input: {
    readonly route?: ResolvedRoute;
    readonly globalLimit?: number;
    readonly providerLimit?: number;
    readonly leaseTtlMs: number;
  }): Promise<AdmissionResult> {
    if (
      input.route === undefined ||
      input.globalLimit === undefined ||
      input.providerLimit === undefined
    ) {
      return Promise.resolve({
        ok: false,
        reason: 'coordination_unavailable',
      });
    }
    const key = input.route.providerRef;
    const providerCount = this.providerInFlight.get(key) ?? 0;
    if (
      this.globalInFlight >= input.globalLimit ||
      providerCount >= input.providerLimit
    ) {
      return Promise.resolve({
        ok: false,
        reason: 'concurrency_limited',
        retryAfterSeconds: 1,
      });
    }
    this.globalInFlight += 1;
    this.providerInFlight.set(key, providerCount + 1);
    return Promise.resolve({
      ok: true,
      lease: timedLease(input.leaseTtlMs, () => {
        this.globalInFlight = Math.max(0, this.globalInFlight - 1);
        const current = this.providerInFlight.get(key) ?? 0;
        if (current <= 1) this.providerInFlight.delete(key);
        else this.providerInFlight.set(key, current - 1);
      }),
    });
  }
}

export interface InMemoryCircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly rollingWindowMs: number;
  readonly openDurationMs: number;
  readonly halfOpenMaxCalls: number;
  readonly clock?: () => number;
}

interface CircuitState {
  failures: number[];
  openUntil: number | null;
  halfOpenInFlight: number;
}

function circuitKey(route: ResolvedRoute): string {
  return `${route.providerRef}\u0000${route.providerModel}`;
}

/** Rolling-window circuit breaker for one gateway process. */
export class InMemoryCircuitBreaker implements CircuitBreaker {
  private readonly states = new Map<string, CircuitState>();
  private readonly clock: () => number;

  public constructor(private readonly options: InMemoryCircuitBreakerOptions) {
    this.clock = options.clock ?? Date.now;
  }

  public acquire(route: ResolvedRoute): Promise<CircuitPermitResult> {
    const key = circuitKey(route);
    const now = this.clock();
    const state = this.states.get(key) ?? {
      failures: [],
      openUntil: null,
      halfOpenInFlight: 0,
    };
    this.prune(state, now);
    if (state.openUntil !== null && state.openUntil > now) {
      return Promise.resolve({
        ok: false,
        reason: 'open',
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((state.openUntil - now) / 1_000),
        ),
      });
    }
    const probe = state.openUntil !== null;
    if (probe && state.halfOpenInFlight >= this.options.halfOpenMaxCalls) {
      return Promise.resolve({ ok: false, reason: 'open' });
    }
    if (probe) state.halfOpenInFlight += 1;
    this.states.set(key, state);
    return Promise.resolve({
      ok: true,
      permit: { route, probe, token: randomUUID() },
    });
  }

  public record(permit: CircuitPermit, outcome: CircuitOutcome): Promise<void> {
    const key = circuitKey(permit.route);
    const state = this.states.get(key);
    if (state === undefined) return Promise.resolve();
    const now = this.clock();
    if (permit.probe) {
      state.halfOpenInFlight = Math.max(0, state.halfOpenInFlight - 1);
    }
    if (outcome === 'success') {
      if (permit.probe) this.states.delete(key);
      return Promise.resolve();
    }
    if (outcome === 'neutral') return Promise.resolve();

    if (permit.probe) {
      state.openUntil = now + this.options.openDurationMs;
      state.failures = [];
      return Promise.resolve();
    }
    this.prune(state, now);
    state.failures.push(now);
    if (state.failures.length >= this.options.failureThreshold) {
      state.openUntil = now + this.options.openDurationMs;
      state.failures = [];
    }
    return Promise.resolve();
  }

  private prune(state: CircuitState, now: number): void {
    const oldest = now - this.options.rollingWindowMs;
    state.failures = state.failures.filter((failure) => failure >= oldest);
  }
}
