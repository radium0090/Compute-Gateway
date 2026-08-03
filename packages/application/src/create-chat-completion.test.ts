import { describe, expect, it } from 'vitest';

import type {
  AdmissionResult,
  ApiKey,
  CircuitBreaker,
  ClientAuthenticator,
  ProviderConcurrencyController,
  ProviderAdapter,
  RequestAdmissionController,
  RoutePlanner,
  RouteResolver,
} from '@genchi/domain';
import { ProviderStreamFailure, apiKeyId } from '@genchi/domain';

import { CreateChatCompletionService } from './create-chat-completion.js';

const apiKey = { policy: {} } as ApiKey;
const streamingApiKey = {
  policy: { allowStreaming: true },
} as ApiKey;
const request = {
  model: 'genchi/fast',
  messages: [{ role: 'user' as const, content: 'content stays in memory' }],
};

function provider(): ProviderAdapter {
  return {
    id: 'openai-primary',
    capabilities: () => ({
      chat: true,
      streaming: false,
      tools: false,
      jsonObject: false,
      jsonSchema: false,
      systemMessages: true,
    }),
    createChatCompletion: () =>
      Promise.resolve({
        ok: true,
        response: {
          content: 'normalized response',
          finishReason: 'stop',
          usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        },
      }),
    streamChatCompletion: () =>
      Promise.resolve({
        ok: true,
        stream: (async function* () {
          await Promise.resolve();
          yield {
            choice: {
              delta: { content: 'streamed' },
              finishReason: 'stop' as const,
            },
          };
        })(),
      }),
  };
}

const router: RouteResolver = {
  resolve: () => ({
    ok: true,
    route: {
      providerRef: 'openai-primary',
      provider: 'openai',
      providerModel: 'model-a',
    },
  }),
};

describe('CreateChatCompletionService', () => {
  it('stops before routing when authentication fails', async () => {
    let routed = false;
    const authenticator: ClientAuthenticator = {
      authenticate: () => Promise.resolve({ authenticated: false }),
    };
    const service = new CreateChatCompletionService(
      authenticator,
      {
        resolve: () => (
          (routed = true),
          { ok: false, reason: 'model_not_found' }
        ),
      },
      new Map(),
    );

    await expect(
      service.execute({
        credential: 'invalid',
        requestId: 'req_test',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: 'authentication' },
    });
    expect(routed).toBe(false);
  });

  it('returns one normalized provider attempt', async () => {
    const authenticator: ClientAuthenticator = {
      authenticate: () => Promise.resolve({ authenticated: true, apiKey }),
    };
    const service = new CreateChatCompletionService(
      authenticator,
      router,
      new Map([['openai-primary', provider()]]),
    );

    const result = await service.execute({
      credential: 'opaque credential',
      requestId: 'req_test',
      request,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      response: { content: 'normalized response' },
      route: { provider: 'openai', providerModel: 'model-a' },
    });
  });

  it('rejects streaming before routing when the key policy denies it', async () => {
    let routed = false;
    const service = new CreateChatCompletionService(
      {
        authenticate: () => Promise.resolve({ authenticated: true, apiKey }),
      },
      {
        resolve: () => (
          (routed = true),
          { ok: false, reason: 'model_not_found' }
        ),
      },
      new Map(),
    );

    await expect(
      service.executeStream({
        credential: 'opaque credential',
        requestId: 'req_stream_denied',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      ok: false,
      failure: { kind: 'routing', reason: 'streaming_not_allowed' },
    });
    expect(routed).toBe(false);
  });

  it('opens one capability-checked provider stream', async () => {
    const streamingRouter: RouteResolver = {
      resolve: (input) => {
        expect(input.requireStreaming).toBe(true);
        return router.resolve(input);
      },
    };
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: streamingApiKey }),
      },
      streamingRouter,
      new Map([
        [
          'openai-primary',
          {
            ...provider(),
            capabilities: () => ({
              chat: true,
              streaming: true,
              tools: false,
              jsonObject: false,
              jsonSchema: false,
              systemMessages: true,
            }),
          },
        ],
      ]),
    );

    const result = await service.executeStream({
      credential: 'opaque credential',
      requestId: 'req_stream',
      request,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      route: { providerModel: 'model-a' },
    });
    if (result.ok) {
      const chunks = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
      expect(chunks).toHaveLength(1);
    }
  });
});

const routedApiKey = {
  id: apiKeyId('routing-test-key'),
  policy: {
    allowStreaming: true,
    requestsPerMinute: 60,
    maxConcurrentRequests: 4,
  },
} as ApiKey;

const fallbackPlanner: RoutePlanner = {
  plan: () => ({
    ok: true,
    plan: {
      candidateCount: 2,
      selectionReason: 'stable_weighted_primary',
      routes: [
        {
          providerRef: 'primary',
          provider: 'openai',
          providerModel: 'model-primary',
        },
        {
          providerRef: 'fallback',
          provider: 'anthropic',
          providerModel: 'model-fallback',
        },
      ],
    },
  }),
};

function resilience(overrides?: {
  readonly requestAdmission?: RequestAdmissionController;
}) {
  const leaseResult = (): AdmissionResult => ({
    ok: true,
    lease: { release: () => Promise.resolve() },
  });
  const providerConcurrency: ProviderConcurrencyController = {
    acquire: () => Promise.resolve(leaseResult()),
  };
  const circuitBreaker: CircuitBreaker = {
    acquire: (route) =>
      Promise.resolve({
        ok: true,
        permit: { route, probe: false, token: 'permit' },
      }),
    record: () => Promise.resolve(),
  };
  return {
    requestAdmission:
      overrides?.requestAdmission ??
      ({
        acquire: () => Promise.resolve(leaseResult()),
      } satisfies RequestAdmissionController),
    providerConcurrency,
    circuitBreaker,
    policy: {
      totalTimeoutMs: 60_000,
      connectTimeoutMs: 5_000,
      maxAttempts: 2,
      sameRouteRetries: 0,
      minimumAttemptBudgetMs: 2_000,
      globalMaxConcurrentCalls: 100,
      providerMaxConcurrentCalls: 10,
      retryBaseDelayMs: 0,
    },
    clock: () => 0,
    random: () => 0,
  };
}

function successfulProvider(id: string): ProviderAdapter {
  return {
    ...provider(),
    id,
    capabilities: () => ({
      chat: true,
      streaming: true,
      tools: false,
      jsonObject: false,
      jsonSchema: false,
      systemMessages: true,
    }),
  };
}

describe('CreateChatCompletionService fallback and admission', () => {
  it('classifies an unexpected adapter throw and releases its attempt lease', async () => {
    let releases = 0;
    const base = resilience();
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: routedApiKey }),
      },
      fallbackPlanner,
      new Map([
        [
          'primary',
          {
            ...successfulProvider('primary'),
            createChatCompletion: () =>
              Promise.reject(new Error('untrusted adapter detail')),
          },
        ],
        ['fallback', successfulProvider('fallback')],
      ]),
      {
        ...base,
        providerConcurrency: {
          acquire: () =>
            Promise.resolve({
              ok: true,
              lease: {
                release: () => {
                  releases += 1;
                  return Promise.resolve();
                },
              },
            }),
        },
      },
    );

    await expect(
      service.execute({
        credential: 'opaque',
        requestId: 'req_adapter_throw',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: true,
      attempts: 2,
      route: { providerRef: 'fallback' },
    });
    expect(releases).toBe(2);
  });

  it('falls back only after a retryable pre-commit provider failure', async () => {
    let fallbackCalls = 0;
    const primary: ProviderAdapter = {
      ...successfulProvider('primary'),
      createChatCompletion: () =>
        Promise.resolve({
          ok: false,
          error: {
            class: 'rate_limit',
            code: 'provider_rate_limited',
            retryable: true,
          },
        }),
    };
    const fallback: ProviderAdapter = {
      ...successfulProvider('fallback'),
      createChatCompletion: () => {
        fallbackCalls += 1;
        return provider().createChatCompletion(request, {
          requestId: 'internal',
          providerModel: 'model-fallback',
          signal: new AbortController().signal,
        });
      },
    };
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: routedApiKey }),
      },
      fallbackPlanner,
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
      resilience(),
    );

    await expect(
      service.execute({
        credential: 'opaque',
        requestId: 'req_fallback',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: true,
      attempts: 2,
      route: { providerRef: 'fallback' },
    });
    expect(fallbackCalls).toBe(1);
  });

  it('never exceeds max attempts across retries and fallbacks', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const transient = {
      ok: false as const,
      error: {
        class: 'unavailable' as const,
        code: 'provider_unavailable',
        retryable: true,
      },
    };
    const base = resilience();
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: routedApiKey }),
      },
      fallbackPlanner,
      new Map([
        [
          'primary',
          {
            ...successfulProvider('primary'),
            createChatCompletion: () => {
              primaryCalls += 1;
              return Promise.resolve(transient);
            },
          },
        ],
        [
          'fallback',
          {
            ...successfulProvider('fallback'),
            createChatCompletion: () => {
              fallbackCalls += 1;
              return Promise.resolve(transient);
            },
          },
        ],
      ]),
      {
        ...base,
        policy: { ...base.policy, maxAttempts: 2, sameRouteRetries: 1 },
      },
    );

    await expect(
      service.execute({
        credential: 'opaque',
        requestId: 'req_attempt_budget',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'provider', error: { code: 'provider_unavailable' } },
    });
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
  });

  it('skips an open circuit without consuming a provider attempt', async () => {
    let primaryCalls = 0;
    const base = resilience();
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: routedApiKey }),
      },
      fallbackPlanner,
      new Map([
        [
          'primary',
          {
            ...successfulProvider('primary'),
            createChatCompletion: () => {
              primaryCalls += 1;
              return Promise.reject(new Error('must not be called'));
            },
          },
        ],
        ['fallback', successfulProvider('fallback')],
      ]),
      {
        ...base,
        circuitBreaker: {
          acquire: (candidate) =>
            Promise.resolve(
              candidate.providerRef === 'primary'
                ? { ok: false as const, reason: 'open' as const }
                : {
                    ok: true as const,
                    permit: {
                      route: candidate,
                      probe: false,
                      token: 'fallback-permit',
                    },
                  },
            ),
          record: () => Promise.resolve(),
        },
      },
    );

    await expect(
      service.execute({
        credential: 'opaque',
        requestId: 'req_open_circuit',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: true,
      attempts: 1,
      route: { providerRef: 'fallback' },
    });
    expect(primaryCalls).toBe(0);
  });

  it('does not fall back after a non-retryable provider rejection', async () => {
    let fallbackCalls = 0;
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: routedApiKey }),
      },
      fallbackPlanner,
      new Map([
        [
          'primary',
          {
            ...successfulProvider('primary'),
            createChatCompletion: () =>
              Promise.resolve({
                ok: false,
                error: {
                  class: 'request' as const,
                  code: 'provider_rejected_request',
                  retryable: false,
                },
              }),
          },
        ],
        [
          'fallback',
          {
            ...successfulProvider('fallback'),
            createChatCompletion: () => {
              fallbackCalls += 1;
              return Promise.reject(new Error('must not be called'));
            },
          },
        ],
      ]),
      resilience(),
    );

    await expect(
      service.execute({
        credential: 'opaque',
        requestId: 'req_no_fallback',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'provider', error: { retryable: false } },
    });
    expect(fallbackCalls).toBe(0);
  });

  it('fails closed before routing when distributed admission is unavailable', async () => {
    let planned = false;
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: routedApiKey }),
      },
      {
        plan: () => {
          planned = true;
          return { ok: false, reason: 'model_not_found' };
        },
      },
      new Map(),
      resilience({
        requestAdmission: {
          acquire: () =>
            Promise.resolve({
              ok: false,
              reason: 'coordination_unavailable',
            }),
        },
      }),
    );

    await expect(
      service.execute({
        credential: 'opaque',
        requestId: 'req_admission',
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: 'admission',
        reason: 'coordination_unavailable',
      },
    });
    expect(planned).toBe(false);
  });

  it('falls back when a stream fails before its first chunk', async () => {
    const primary: ProviderAdapter = {
      ...successfulProvider('primary'),
      streamChatCompletion: () =>
        Promise.resolve({
          ok: true,
          stream: {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                Promise.reject(
                  new ProviderStreamFailure({
                    class: 'unavailable',
                    code: 'provider_stream_interrupted',
                    retryable: true,
                  }),
                ),
            }),
          },
        }),
    };
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: routedApiKey }),
      },
      fallbackPlanner,
      new Map([
        ['primary', primary],
        ['fallback', successfulProvider('fallback')],
      ]),
      resilience(),
    );

    const result = await service.executeStream({
      credential: 'opaque',
      requestId: 'req_stream_fallback',
      request,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
      route: { providerRef: 'fallback' },
    });
  });

  it('never splices a fallback after the first stream chunk', async () => {
    let fallbackCalls = 0;
    const primary: ProviderAdapter = {
      ...successfulProvider('primary'),
      streamChatCompletion: () =>
        Promise.resolve({
          ok: true,
          stream: (async function* () {
            await Promise.resolve();
            yield {
              choice: { delta: { content: 'partial' }, finishReason: null },
            };
            throw new ProviderStreamFailure({
              class: 'unavailable',
              code: 'provider_stream_interrupted',
              retryable: true,
            });
          })(),
        }),
    };
    const fallback = {
      ...successfulProvider('fallback'),
      streamChatCompletion: () => {
        fallbackCalls += 1;
        return Promise.reject(new Error('must not be called'));
      },
    } satisfies ProviderAdapter;
    const service = new CreateChatCompletionService(
      {
        authenticate: () =>
          Promise.resolve({ authenticated: true, apiKey: routedApiKey }),
      },
      fallbackPlanner,
      new Map([
        ['primary', primary],
        ['fallback', fallback],
      ]),
      resilience(),
    );
    const result = await service.executeStream({
      credential: 'opaque',
      requestId: 'req_committed',
      request,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      route: { providerRef: 'primary' },
    });
    if (!result.ok) return;
    const iterator = result.stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { choice: { delta: { content: 'partial' } } },
    });
    await expect(iterator.next()).rejects.toBeInstanceOf(ProviderStreamFailure);
    expect(fallbackCalls).toBe(0);
  });
});
