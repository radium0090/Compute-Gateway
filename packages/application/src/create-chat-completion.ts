import {
  ProviderStreamFailure,
  circuitOutcomeForProviderError,
} from '@genchi/domain';
import type {
  AdmissionRejectionReason,
  ApiKey,
  CanonicalChatChunk,
  CanonicalChatRequest,
  CanonicalChatResponse,
  CircuitBreaker,
  CircuitPermit,
  ClientAuthenticator,
  CoordinationLease,
  ProviderAdapter,
  ProviderCallContext,
  ProviderCallResult,
  ProviderConcurrencyController,
  ProviderError,
  ProviderStreamCallResult,
  RequestAdmissionController,
  ResolvedRoute,
  ResolvedRoutePlan,
  RoutePlanner,
  RouteResolver,
  RoutingExecutionPolicy,
  RoutingObserver,
} from '@genchi/domain';

export type ChatCompletionFailure =
  | { readonly kind: 'authentication' }
  | {
      readonly kind: 'routing';
      readonly reason:
        | 'model_not_allowed'
        | 'model_not_found'
        | 'no_healthy_route'
        | 'streaming_not_allowed';
    }
  | {
      readonly kind: 'admission';
      readonly reason: AdmissionRejectionReason;
      readonly retryAfterSeconds?: number;
    }
  | { readonly kind: 'provider'; readonly error: ProviderError };

interface ChatCompletionFailureResult {
  readonly ok: false;
  readonly failure: ChatCompletionFailure;
}

export type CreateChatCompletionResult =
  | {
      readonly ok: true;
      readonly response: CanonicalChatResponse;
      readonly route: ResolvedRoute;
      readonly attempts: number;
    }
  | ChatCompletionFailureResult;

export type CreateChatCompletionStreamResult =
  | {
      readonly ok: true;
      readonly stream: AsyncIterable<CanonicalChatChunk>;
      readonly route: ResolvedRoute;
      readonly attempts: number;
    }
  | ChatCompletionFailureResult;

export interface CreateChatCompletionInput {
  readonly credential: string;
  readonly requestId: string;
  readonly request: CanonicalChatRequest;
  readonly signal: AbortSignal;
}

export interface ChatCompletionResilienceOptions {
  readonly requestAdmission: RequestAdmissionController;
  readonly providerConcurrency: ProviderConcurrencyController;
  readonly circuitBreaker: CircuitBreaker;
  readonly policy: RoutingExecutionPolicy;
  readonly clock?: () => number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly observer?: RoutingObserver;
}

const timeoutError: ProviderError = {
  class: 'timeout',
  code: 'request_deadline_exceeded',
  retryable: true,
};

const invalidStreamError: ProviderError = {
  class: 'protocol',
  code: 'provider_invalid_stream',
  retryable: true,
};

const unexpectedProviderError: ProviderError = {
  class: 'unavailable',
  code: 'provider_adapter_failure',
  retryable: true,
};

const noopLease: CoordinationLease = { release: () => Promise.resolve() };

async function defaultSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    let settled = false;
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function streamError(error: unknown): ProviderError {
  return error instanceof ProviderStreamFailure
    ? error.providerError
    : invalidStreamError;
}

async function releaseSafely(lease: CoordinationLease): Promise<void> {
  try {
    await lease.release();
  } catch {
    // Expiring coordination leases make cleanup failure bounded.
  }
}

async function recordSafely(
  circuitBreaker: CircuitBreaker,
  permit: CircuitPermit,
  outcome: 'success' | 'failure' | 'neutral',
): Promise<void> {
  try {
    await circuitBreaker.record(permit, outcome);
  } catch {
    // A completed provider response is not corrupted by telemetry/state loss.
  }
}

function singleRoutePlan(
  router: RouteResolver,
  input: Parameters<RouteResolver['resolve']>[0],
) {
  const result = router.resolve(input);
  return result.ok
    ? {
        ok: true as const,
        plan: {
          routes: [result.route],
          candidateCount: 1,
          selectionReason: 'legacy_single_route' as const,
        },
      }
    : result;
}

/** Authenticates, admits, routes, and executes bounded provider attempts. */
export class CreateChatCompletionService {
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly sleep: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;

  public constructor(
    private readonly authenticator: ClientAuthenticator,
    private readonly router: RoutePlanner | RouteResolver,
    private readonly providers: ReadonlyMap<string, ProviderAdapter>,
    private readonly resilience?: ChatCompletionResilienceOptions,
  ) {
    this.clock = resilience?.clock ?? Date.now;
    this.random = resilience?.random ?? Math.random;
    this.sleep = resilience?.sleep ?? defaultSleep;
  }

  public async execute(
    input: CreateChatCompletionInput,
  ): Promise<CreateChatCompletionResult> {
    const authentication = await this.authenticator.authenticate(
      input.credential,
    );
    if (!authentication.authenticated) {
      return { ok: false, failure: { kind: 'authentication' } };
    }
    const admission = await this.acquireRequest(authentication.apiKey);
    if (!admission.ok) return admission.result;
    try {
      const plan = this.plan(input, authentication.apiKey, false);
      if (!plan.ok) return plan.result;
      return await this.executePlan(input, plan.plan);
    } finally {
      await releaseSafely(admission.lease);
    }
  }

  public async executeStream(
    input: CreateChatCompletionInput,
  ): Promise<CreateChatCompletionStreamResult> {
    const authentication = await this.authenticator.authenticate(
      input.credential,
    );
    if (!authentication.authenticated) {
      return { ok: false, failure: { kind: 'authentication' } };
    }
    if (!authentication.apiKey.policy.allowStreaming) {
      return {
        ok: false,
        failure: { kind: 'routing', reason: 'streaming_not_allowed' },
      };
    }
    const admission = await this.acquireRequest(authentication.apiKey);
    if (!admission.ok) return admission.result;
    const plan = this.plan(input, authentication.apiKey, true);
    if (!plan.ok) {
      await releaseSafely(admission.lease);
      return plan.result;
    }
    const result = await this.executeStreamPlan(
      input,
      plan.plan,
      admission.lease,
    );
    if (!result.ok) await releaseSafely(admission.lease);
    return result;
  }

  private plan(
    input: CreateChatCompletionInput,
    apiKey: ApiKey,
    requireStreaming: boolean,
  ):
    | { readonly ok: true; readonly plan: ResolvedRoutePlan }
    | { readonly ok: false; readonly result: ChatCompletionFailureResult } {
    const request = {
      requestedModel: input.request.model,
      requestId: input.requestId,
      apiKey,
      ...(requireStreaming ? { requireStreaming: true } : {}),
    };
    const resolution =
      'plan' in this.router
        ? this.router.plan(request)
        : singleRoutePlan(this.router, request);
    if (resolution.ok) {
      const selected = resolution.plan.routes[0];
      if (selected !== undefined) {
        this.resilience?.observer?.plan({
          requestedModel: input.request.model,
          candidateCount: resolution.plan.candidateCount,
          selected,
          selectionReason: resolution.plan.selectionReason,
        });
      }
      return { ok: true, plan: resolution.plan };
    }
    return {
      ok: false,
      result: {
        ok: false,
        failure: { kind: 'routing', reason: resolution.reason },
      },
    };
  }

  private async acquireRequest(
    apiKey: ApiKey,
  ): Promise<
    | { readonly ok: true; readonly lease: CoordinationLease }
    | { readonly ok: false; readonly result: ChatCompletionFailureResult }
  > {
    if (this.resilience === undefined) return { ok: true, lease: noopLease };
    const result = await this.resilience.requestAdmission.acquire({
      apiKeyId: apiKey.id,
      requestsPerMinute: apiKey.policy.requestsPerMinute,
      maxConcurrentRequests: apiKey.policy.maxConcurrentRequests,
      leaseTtlMs: this.resilience.policy.totalTimeoutMs + 5_000,
    });
    if (result.ok) return result;
    this.resilience.observer?.admissionRejected({
      scope:
        result.reason === 'coordination_unavailable'
          ? 'coordination'
          : 'api_key',
      reason: result.reason,
    });
    return {
      ok: false,
      result: {
        ok: false,
        failure: {
          kind: 'admission',
          reason: result.reason,
          ...(result.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: result.retryAfterSeconds }),
        },
      },
    };
  }

  private async executePlan(
    input: CreateChatCompletionInput,
    plan: ResolvedRoutePlan,
  ): Promise<CreateChatCompletionResult> {
    if (this.resilience === undefined) {
      return this.executeSingle(input, plan);
    }
    const startedAt = this.clock();
    const executionSignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.resilience.policy.totalTimeoutMs),
    ]);
    let attempts = 0;
    let lastError: ProviderError | undefined;
    let previousRoute: ResolvedRoute | undefined;
    for (const route of plan.routes) {
      if (previousRoute !== undefined && lastError !== undefined) {
        this.resilience.observer?.fallback({
          from: previousRoute,
          to: route,
          reason: lastError.code,
        });
      }
      for (
        let sameRouteAttempt = 0;
        sameRouteAttempt <= this.resilience.policy.sameRouteRetries;
        sameRouteAttempt += 1
      ) {
        if (attempts >= this.resilience.policy.maxAttempts) break;
        const remaining = this.remainingBudget(startedAt);
        if (remaining < this.resilience.policy.minimumAttemptBudgetMs) {
          return this.providerFailure(lastError ?? timeoutError);
        }
        const resources = await this.acquireRoute(route, remaining);
        if (!resources.ok) {
          if (resources.result !== null) return resources.result;
          break;
        }
        attempts += 1;
        previousRoute = route;
        const adapter = this.providers.get(route.providerRef);
        if (adapter?.capabilities(route.providerModel) == null) {
          await this.finishAttempt(resources, 'neutral');
          break;
        }
        const attemptStartedAt = this.clock();
        const result = await this.callProvider(adapter, input.request, {
          requestId: input.requestId,
          providerModel: route.providerModel,
          signal: executionSignal,
          connectTimeoutMs: Math.min(
            this.resilience.policy.connectTimeoutMs,
            remaining,
          ),
        });
        if (result.ok) {
          this.resilience.observer?.providerAttempt({
            route,
            attempt: attempts,
            outcome: 'success',
            durationMs: this.clock() - attemptStartedAt,
          });
          await this.finishAttempt(resources, 'success');
          return {
            ok: true,
            response: result.response,
            route,
            attempts,
          };
        }
        lastError = result.error;
        this.resilience.observer?.providerAttempt({
          route,
          attempt: attempts,
          outcome: 'failure',
          durationMs: this.clock() - attemptStartedAt,
        });
        await this.finishAttempt(
          resources,
          circuitOutcomeForProviderError(result.error),
        );
        if (!result.error.retryable) return this.providerFailure(result.error);
        if (sameRouteAttempt < this.resilience.policy.sameRouteRetries) {
          const retry = await this.waitForRetry(
            result.error,
            attempts,
            startedAt,
            executionSignal,
          );
          if (retry) continue;
        }
        break;
      }
      if (attempts >= this.resilience.policy.maxAttempts) break;
    }
    return lastError === undefined
      ? {
          ok: false,
          failure: { kind: 'routing', reason: 'no_healthy_route' },
        }
      : this.providerFailure(lastError);
  }

  private async executeStreamPlan(
    input: CreateChatCompletionInput,
    plan: ResolvedRoutePlan,
    requestLease: CoordinationLease,
  ): Promise<CreateChatCompletionStreamResult> {
    if (this.resilience === undefined) {
      const single = await this.executeSingleStream(input, plan);
      return single;
    }
    const startedAt = this.clock();
    const executionSignal = AbortSignal.any([
      input.signal,
      AbortSignal.timeout(this.resilience.policy.totalTimeoutMs),
    ]);
    let attempts = 0;
    let lastError: ProviderError | undefined;
    let previousRoute: ResolvedRoute | undefined;
    for (const route of plan.routes) {
      if (previousRoute !== undefined && lastError !== undefined) {
        this.resilience.observer?.fallback({
          from: previousRoute,
          to: route,
          reason: lastError.code,
        });
      }
      for (
        let sameRouteAttempt = 0;
        sameRouteAttempt <= this.resilience.policy.sameRouteRetries;
        sameRouteAttempt += 1
      ) {
        if (attempts >= this.resilience.policy.maxAttempts) break;
        const remaining = this.remainingBudget(startedAt);
        if (remaining < this.resilience.policy.minimumAttemptBudgetMs) {
          return this.providerFailure(lastError ?? timeoutError);
        }
        const resources = await this.acquireRoute(route, remaining);
        if (!resources.ok) {
          if (resources.result !== null) return resources.result;
          break;
        }
        attempts += 1;
        previousRoute = route;
        const adapter = this.providers.get(route.providerRef);
        if (adapter?.capabilities(route.providerModel)?.streaming !== true) {
          await this.finishAttempt(resources, 'neutral');
          break;
        }
        const attemptStartedAt = this.clock();
        const opened = await this.openProviderStream(adapter, input.request, {
          requestId: input.requestId,
          providerModel: route.providerModel,
          signal: executionSignal,
          connectTimeoutMs: Math.min(
            this.resilience.policy.connectTimeoutMs,
            remaining,
          ),
        });
        let error: ProviderError | undefined;
        if (!opened.ok) {
          error = opened.error;
        } else {
          let iterator: AsyncIterator<CanonicalChatChunk> | undefined;
          try {
            iterator = opened.stream[Symbol.asyncIterator]();
            const first = await iterator.next();
            if (!first.done) {
              this.resilience.observer?.providerAttempt({
                route,
                attempt: attempts,
                outcome: 'success',
                durationMs: this.clock() - attemptStartedAt,
              });
              return {
                ok: true,
                stream: this.committedStream(
                  first.value,
                  iterator,
                  resources,
                  requestLease,
                ),
                route,
                attempts,
              };
            }
            error = invalidStreamError;
          } catch (caught: unknown) {
            error = streamError(caught);
          }
          if (iterator !== undefined) {
            try {
              await iterator.return?.();
            } catch {
              // The pre-commit provider failure remains the useful error.
            }
          }
        }
        lastError = error;
        this.resilience.observer?.providerAttempt({
          route,
          attempt: attempts,
          outcome: 'failure',
          durationMs: this.clock() - attemptStartedAt,
        });
        await this.finishAttempt(
          resources,
          circuitOutcomeForProviderError(error),
        );
        if (!error.retryable) return this.providerFailure(error);
        if (sameRouteAttempt < this.resilience.policy.sameRouteRetries) {
          const retry = await this.waitForRetry(
            error,
            attempts,
            startedAt,
            executionSignal,
          );
          if (retry) continue;
        }
        break;
      }
      if (attempts >= this.resilience.policy.maxAttempts) break;
    }
    return lastError === undefined
      ? {
          ok: false,
          failure: { kind: 'routing', reason: 'no_healthy_route' },
        }
      : this.providerFailure(lastError);
  }

  private async *committedStream(
    first: CanonicalChatChunk,
    iterator: AsyncIterator<CanonicalChatChunk>,
    resources: AttemptResources,
    requestLease: CoordinationLease,
  ): AsyncIterable<CanonicalChatChunk> {
    let completed = false;
    let outcome: 'success' | 'failure' | 'neutral' = 'neutral';
    try {
      yield first;
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          completed = true;
          outcome = 'success';
          break;
        }
        yield next.value;
      }
    } catch (error: unknown) {
      outcome = circuitOutcomeForProviderError(streamError(error));
      throw error;
    } finally {
      if (!completed) {
        try {
          await iterator.return?.();
        } catch {
          // Client cancellation cleanup is best-effort.
        }
      }
      await recordSafely(
        this.requiredResilience().circuitBreaker,
        resources.permit,
        outcome,
      );
      await releaseSafely(resources.lease);
      await releaseSafely(requestLease);
    }
  }

  private async acquireRoute(
    route: ResolvedRoute,
    remainingMs: number,
  ): Promise<
    | {
        readonly ok: true;
        readonly lease: CoordinationLease;
        readonly permit: CircuitPermit;
      }
    | {
        readonly ok: false;
        readonly result: ChatCompletionFailureResult | null;
      }
  > {
    const resilience = this.requiredResilience();
    const circuit = await resilience.circuitBreaker.acquire(route);
    if (!circuit.ok) {
      if (circuit.reason === 'open') {
        resilience.observer?.circuitState(route, 'open');
        resilience.observer?.circuitSkipped(route);
      } else {
        resilience.observer?.admissionRejected({
          scope: 'coordination',
          reason: 'coordination_unavailable',
        });
      }
      return circuit.reason === 'coordination_unavailable'
        ? {
            ok: false,
            result: this.admissionFailure('coordination_unavailable'),
          }
        : { ok: false, result: null };
    }
    resilience.observer?.circuitState(
      route,
      circuit.permit.probe ? 'half_open' : 'closed',
    );
    const concurrency = await resilience.providerConcurrency.acquire({
      route,
      globalLimit: resilience.policy.globalMaxConcurrentCalls,
      providerLimit: resilience.policy.providerMaxConcurrentCalls,
      leaseTtlMs: remainingMs + 5_000,
    });
    if (!concurrency.ok) {
      resilience.observer?.admissionRejected({
        scope:
          concurrency.reason === 'coordination_unavailable'
            ? 'coordination'
            : 'provider',
        reason: concurrency.reason,
      });
      await recordSafely(resilience.circuitBreaker, circuit.permit, 'neutral');
      return concurrency.reason === 'coordination_unavailable'
        ? {
            ok: false,
            result: this.admissionFailure('coordination_unavailable'),
          }
        : {
            ok: false,
            result: this.admissionFailure(
              'concurrency_limited',
              concurrency.retryAfterSeconds,
            ),
          };
    }
    return { ok: true, lease: concurrency.lease, permit: circuit.permit };
  }

  private async finishAttempt(
    resources: AttemptResources,
    outcome: 'success' | 'failure' | 'neutral',
  ): Promise<void> {
    await recordSafely(
      this.requiredResilience().circuitBreaker,
      resources.permit,
      outcome,
    );
    await releaseSafely(resources.lease);
  }

  private remainingBudget(startedAt: number): number {
    return Math.max(
      0,
      this.requiredResilience().policy.totalTimeoutMs -
        (this.clock() - startedAt),
    );
  }

  private async waitForRetry(
    error: ProviderError,
    attempts: number,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const policy = this.requiredResilience().policy;
    const cappedBackoff = Math.min(
      policy.retryBaseDelayMs * 2 ** Math.max(0, attempts - 1),
      5_000,
    );
    const jitter = Math.floor(this.random() * cappedBackoff);
    const delay =
      error.retryAfterSeconds === undefined
        ? jitter
        : error.retryAfterSeconds * 1_000;
    if (
      this.remainingBudget(startedAt) - delay <
      policy.minimumAttemptBudgetMs
    ) {
      return false;
    }
    await this.sleep(delay, signal);
    return !signal.aborted;
  }

  private async executeSingle(
    input: CreateChatCompletionInput,
    plan: ResolvedRoutePlan,
  ): Promise<CreateChatCompletionResult> {
    const route = plan.routes[0];
    const adapter =
      route === undefined ? undefined : this.providers.get(route.providerRef);
    if (
      route === undefined ||
      adapter?.capabilities(route.providerModel) == null
    ) {
      return {
        ok: false,
        failure: { kind: 'routing', reason: 'no_healthy_route' },
      };
    }
    const result = await this.callProvider(adapter, input.request, {
      requestId: input.requestId,
      providerModel: route.providerModel,
      signal: input.signal,
    });
    return result.ok
      ? { ok: true, response: result.response, route, attempts: 1 }
      : this.providerFailure(result.error);
  }

  private async executeSingleStream(
    input: CreateChatCompletionInput,
    plan: ResolvedRoutePlan,
  ): Promise<CreateChatCompletionStreamResult> {
    const route = plan.routes[0];
    const adapter =
      route === undefined ? undefined : this.providers.get(route.providerRef);
    if (
      route === undefined ||
      adapter?.capabilities(route.providerModel)?.streaming !== true
    ) {
      return {
        ok: false,
        failure: { kind: 'routing', reason: 'no_healthy_route' },
      };
    }
    const result = await this.openProviderStream(adapter, input.request, {
      requestId: input.requestId,
      providerModel: route.providerModel,
      signal: input.signal,
    });
    if (!result.ok) return this.providerFailure(result.error);
    return { ok: true, stream: result.stream, route, attempts: 1 };
  }

  private admissionFailure(
    reason: AdmissionRejectionReason,
    retryAfterSeconds?: number,
  ): ChatCompletionFailureResult {
    return {
      ok: false,
      failure: {
        kind: 'admission',
        reason,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      },
    };
  }

  private providerFailure(error: ProviderError): ChatCompletionFailureResult {
    return { ok: false, failure: { kind: 'provider', error } };
  }

  private async callProvider(
    adapter: ProviderAdapter,
    request: CanonicalChatRequest,
    context: ProviderCallContext,
  ): Promise<ProviderCallResult> {
    try {
      return await adapter.createChatCompletion(request, context);
    } catch {
      return { ok: false, error: unexpectedProviderError };
    }
  }

  private async openProviderStream(
    adapter: ProviderAdapter,
    request: CanonicalChatRequest,
    context: ProviderCallContext,
  ): Promise<ProviderStreamCallResult> {
    try {
      return await adapter.streamChatCompletion(request, context);
    } catch {
      return { ok: false, error: unexpectedProviderError };
    }
  }

  private requiredResilience(): ChatCompletionResilienceOptions {
    if (this.resilience === undefined) {
      throw new TypeError('Resilience options are required for this operation');
    }
    return this.resilience;
  }
}

interface AttemptResources {
  readonly lease: CoordinationLease;
  readonly permit: CircuitPermit;
}
