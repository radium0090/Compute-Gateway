import type { ApiKeyId } from './api-key.js';
import type {
  ProviderError,
  ResolvedRoute,
  ResolvedRoutePlan,
} from './chat-completion.js';

export interface CoordinationLease {
  release(): Promise<void>;
}

export type AdmissionRejectionReason =
  'rate_limited' | 'concurrency_limited' | 'coordination_unavailable';

export type AdmissionResult =
  | { readonly ok: true; readonly lease: CoordinationLease }
  | {
      readonly ok: false;
      readonly reason: AdmissionRejectionReason;
      readonly retryAfterSeconds?: number;
    };

/** Coordinates per-key request rate and in-flight request limits. */
export interface RequestAdmissionController {
  acquire(input: {
    readonly apiKeyId: ApiKeyId;
    readonly requestsPerMinute: number;
    readonly maxConcurrentRequests: number;
    readonly leaseTtlMs: number;
  }): Promise<AdmissionResult>;
}

/** Coordinates global and per-provider in-flight provider calls. */
export interface ProviderConcurrencyController {
  acquire(input: {
    readonly route: ResolvedRoute;
    readonly globalLimit: number;
    readonly providerLimit: number;
    readonly leaseTtlMs: number;
  }): Promise<AdmissionResult>;
}

export interface CircuitPermit {
  readonly route: ResolvedRoute;
  readonly probe: boolean;
  readonly token: string;
}

export type CircuitPermitResult =
  | { readonly ok: true; readonly permit: CircuitPermit }
  | {
      readonly ok: false;
      readonly reason: 'open' | 'coordination_unavailable';
      readonly retryAfterSeconds?: number;
    };

export type CircuitOutcome = 'success' | 'failure' | 'neutral';

export interface CircuitBreaker {
  acquire(route: ResolvedRoute): Promise<CircuitPermitResult>;
  record(permit: CircuitPermit, outcome: CircuitOutcome): Promise<void>;
}

export interface RoutingExecutionPolicy {
  readonly totalTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxAttempts: number;
  readonly sameRouteRetries: number;
  readonly minimumAttemptBudgetMs: number;
  readonly globalMaxConcurrentCalls: number;
  readonly providerMaxConcurrentCalls: number;
  readonly retryBaseDelayMs: number;
}

export interface RoutingObserver {
  plan(input: {
    readonly requestedModel: string;
    readonly candidateCount: number;
    readonly selected: ResolvedRoute;
    readonly selectionReason: ResolvedRoutePlan['selectionReason'];
  }): void;
  providerAttempt(input: {
    readonly route: ResolvedRoute;
    readonly attempt: number;
    readonly outcome: 'success' | 'failure';
    readonly durationMs: number;
  }): void;
  fallback(input: {
    readonly from: ResolvedRoute;
    readonly to: ResolvedRoute;
    readonly reason: string;
  }): void;
  admissionRejected(input: {
    readonly scope: 'api_key' | 'provider' | 'coordination';
    readonly reason: AdmissionRejectionReason;
  }): void;
  circuitState(
    route: ResolvedRoute,
    state: 'closed' | 'open' | 'half_open',
  ): void;
  circuitSkipped(route: ResolvedRoute): void;
}

export function circuitOutcomeForProviderError(
  error: ProviderError,
): CircuitOutcome {
  switch (error.class) {
    case 'authentication':
    case 'rate_limit':
    case 'timeout':
    case 'unavailable':
    case 'protocol':
      return 'failure';
    case 'request':
    case 'policy':
      return 'neutral';
  }
}
