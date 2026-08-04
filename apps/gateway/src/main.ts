import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

import {
  CreateChatCompletionService,
  ListModelsService,
} from '@genchi/application';
import { ApiKeyAuthenticator } from '@genchi/auth';
import type { PolicyConfig, RuntimeConfig } from '@genchi/config';
import { createRedisCoordination } from '@genchi/coordination-redis';
import type {
  CircuitBreaker,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConcurrencyController,
  RequestAdmissionController,
  RoutingExecutionPolicy,
} from '@genchi/domain';
import {
  createLogger,
  createRoutingObserver,
  type MetricsRequestHandler,
} from '@genchi/observability';
import {
  PostgresApiKeyRepository,
  PostgresReadinessProbe,
  createPostgresPool,
  runMigrations,
} from '@genchi/persistence-postgres';
import { AnthropicAdapter } from '@genchi/provider-anthropic';
import { GeminiAdapter } from '@genchi/provider-gemini';
import { OpenAiAdapter } from '@genchi/provider-openai';
import {
  InMemoryCircuitBreaker,
  InMemoryCoordination,
  StaticModelCatalog,
  StaticPolicyRouter,
} from '@genchi/router';

import { buildGateway } from './app.js';
import type { ReadinessProbe } from './health.js';

interface CoordinationRuntime {
  readonly requestAdmission: RequestAdmissionController;
  readonly providerConcurrency: ProviderConcurrencyController;
  readonly circuitBreaker: CircuitBreaker;
  readonly readiness?: { check(): Promise<{ readonly ready: boolean }> };
  close(): Promise<void>;
}

function executionPolicy(
  config: RuntimeConfig,
  policy: PolicyConfig,
): RoutingExecutionPolicy {
  return {
    totalTimeoutMs: Math.min(
      config.totalTimeoutMs,
      policy.routing.total_timeout_ms,
    ),
    connectTimeoutMs:
      policy.routing.connect_timeout_ms ?? config.connectTimeoutMs,
    maxAttempts: policy.routing.max_attempts,
    sameRouteRetries: policy.routing.same_route_retries ?? 0,
    minimumAttemptBudgetMs: policy.routing.minimum_attempt_budget_ms ?? 2_000,
    globalMaxConcurrentCalls:
      policy.routing.global_max_concurrent_calls ?? 1_000,
    providerMaxConcurrentCalls:
      policy.routing.provider_max_concurrent_calls ?? 100,
    retryBaseDelayMs: policy.routing.retry_base_delay_ms ?? 100,
  };
}

async function coordinationRuntime(
  config: RuntimeConfig,
  policy: PolicyConfig,
): Promise<CoordinationRuntime> {
  const circuit = policy.routing.circuit ?? {
    failure_threshold: 5,
    rolling_window_ms: 30_000,
    open_duration_ms: 30_000,
    half_open_max_calls: 1,
  };
  if (config.redisUrl !== undefined) {
    const redis = await createRedisCoordination({
      redisUrl: config.redisUrl,
      connectTimeoutMs: config.connectTimeoutMs,
      circuit: {
        failureThreshold: circuit.failure_threshold,
        rollingWindowMs: circuit.rolling_window_ms,
        openDurationMs: circuit.open_duration_ms,
        halfOpenMaxCalls: circuit.half_open_max_calls,
      },
    });
    return {
      requestAdmission: redis,
      providerConcurrency: redis,
      circuitBreaker: redis,
      readiness: redis,
      close: () => redis.close(),
    };
  }
  const coordination = new InMemoryCoordination();
  return {
    requestAdmission: coordination,
    providerConcurrency: coordination,
    circuitBreaker: new InMemoryCircuitBreaker({
      failureThreshold: circuit.failure_threshold,
      rollingWindowMs: circuit.rolling_window_ms,
      openDurationMs: circuit.open_duration_ms,
      halfOpenMaxCalls: circuit.half_open_max_calls,
    }),
    close: () => Promise.resolve(),
  };
}

function readinessProbe(
  postgres: PostgresReadinessProbe,
  coordination: CoordinationRuntime,
): ReadinessProbe {
  return {
    check: async () => {
      const [database, redis] = await Promise.all([
        postgres.check(),
        coordination.readiness?.check(),
      ]);
      return {
        ready: database.ready && (redis?.ready ?? true),
        checks: {
          postgres: database.ready ? 'ok' : 'error',
          ...(redis === undefined
            ? {}
            : { redis: redis.ready ? ('ok' as const) : ('error' as const) }),
        },
      };
    },
  };
}

async function closeWithinGrace(
  app: FastifyInstance,
  graceMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Gateway shutdown grace period elapsed'));
    }, graceMs);
    timer.unref();
  });

  try {
    await Promise.race([app.close(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function modelCapabilities(
  capabilities: readonly ('chat' | 'streaming' | 'tools' | 'json_schema')[],
): ProviderCapabilities {
  return {
    chat: true,
    streaming: capabilities.includes('streaming'),
    tools: capabilities.includes('tools'),
    jsonObject: false,
    jsonSchema: capabilities.includes('json_schema'),
    systemMessages: true,
  };
}

export function buildProviderRegistry(
  policy: PolicyConfig,
  credentials: ReadonlyMap<string, string>,
): ReadonlyMap<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();
  for (const [providerRef, provider] of Object.entries(policy.providers)) {
    const apiKey = credentials.get(providerRef);
    if (apiKey === undefined) {
      throw new TypeError(
        `Validated provider ${providerRef} has no credential`,
      );
    }
    const models = Object.fromEntries(
      Object.entries(provider.models).map(([model, definition]) => [
        model,
        modelCapabilities(definition.capabilities),
      ]),
    );
    switch (provider.adapter) {
      case 'openai':
        adapters.set(
          providerRef,
          new OpenAiAdapter({
            id: providerRef,
            baseUrl: provider.base_url,
            apiKey,
            models,
          }),
        );
        break;
      case 'anthropic':
        adapters.set(
          providerRef,
          new AnthropicAdapter({
            id: providerRef,
            baseUrl: provider.base_url,
            apiKey,
            models,
          }),
        );
        break;
      case 'gemini':
        adapters.set(
          providerRef,
          new GeminiAdapter({
            id: providerRef,
            baseUrl: provider.base_url,
            apiKey,
            models,
          }),
        );
        break;
    }
  }
  return adapters;
}

/** Starts the gateway and owns all infrastructure lifecycle resources. */
export async function runGateway(
  config: RuntimeConfig,
  policy: PolicyConfig,
  credentials: ReadonlyMap<string, string>,
  metricsRequestHandler?: MetricsRequestHandler,
): Promise<void> {
  const logger = createLogger({
    environment: config.environment,
    level: config.logLevel,
  });
  const pool = createPostgresPool({
    databaseUrl: config.databaseUrl,
    connectTimeoutMs: config.connectTimeoutMs,
  });
  const authenticator = new ApiKeyAuthenticator(
    new PostgresApiKeyRepository(pool),
    config.keyHashPepper,
    config.environment,
    () => new Date(),
  );
  const runtime = await (async () => {
    let coordination: CoordinationRuntime | undefined;
    try {
      coordination = await coordinationRuntime(config, policy);
      const router = new StaticPolicyRouter(policy);
      const app = await buildGateway({
        config,
        logger,
        ...(metricsRequestHandler === undefined
          ? {}
          : { metricsRequestHandler }),
        readinessProbe: readinessProbe(
          new PostgresReadinessProbe(pool),
          coordination,
        ),
        chatCompletionService: new CreateChatCompletionService(
          authenticator,
          router,
          buildProviderRegistry(policy, credentials),
          {
            requestAdmission: coordination.requestAdmission,
            providerConcurrency: coordination.providerConcurrency,
            circuitBreaker: coordination.circuitBreaker,
            policy: executionPolicy(config, policy),
            observer: createRoutingObserver(),
          },
        ),
        listModelsService: new ListModelsService(
          authenticator,
          new StaticModelCatalog(policy),
        ),
      });
      return { coordination, app };
    } catch {
      await coordination?.close();
      await pool.end();
      logger.error(
        { event: 'gateway.start_failed' },
        'gateway failed to start',
      );
      throw new Error('Gateway startup failed');
    }
  })();
  const { coordination, app } = runtime;
  let shuttingDown = false;
  let finishShutdown: (() => void) | undefined;
  const shutdownCompleted = new Promise<void>((resolveShutdown) => {
    finishShutdown = resolveShutdown;
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ event: 'gateway.stopping', signal }, 'gateway stopping');
    try {
      await closeWithinGrace(app, config.shutdownGraceMs);
      logger.info({ event: 'gateway.stopped' }, 'gateway stopped');
    } catch {
      logger.error(
        { event: 'gateway.shutdown_failed' },
        'gateway shutdown failed',
      );
      process.exitCode = 1;
    } finally {
      await coordination.close();
      await pool.end();
      finishShutdown?.();
    }
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info(
      { event: 'gateway.started', host: config.host, port: config.port },
      'gateway started',
    );
    await shutdownCompleted;
  } catch {
    await coordination.close();
    await pool.end();
    logger.error({ event: 'gateway.start_failed' }, 'gateway failed to start');
    throw new Error('Gateway startup failed');
  }
}

/** Runs ordered migrations as a dedicated operator command. */
export async function runMigrationCommand(
  config: RuntimeConfig,
): Promise<void> {
  const logger = createLogger({
    environment: config.environment,
    level: config.logLevel,
  });
  const pool = createPostgresPool({
    databaseUrl: config.databaseUrl,
    connectTimeoutMs: config.connectTimeoutMs,
    maxConnections: 1,
  });
  try {
    const result = await runMigrations(pool, resolve('db/migrations'));
    logger.info(
      {
        event: 'database.migrations_completed',
        applied_count: result.appliedVersions.length,
      },
      'database migrations completed',
    );
  } finally {
    await pool.end();
  }
}
