import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

import {
  CreateChatCompletionService,
  ListModelsService,
} from '@genchi/application';
import { ApiKeyAuthenticator } from '@genchi/auth';
import type { PolicyConfig, RuntimeConfig } from '@genchi/config';
import type { ProviderAdapter, ProviderCapabilities } from '@genchi/domain';
import { createLogger } from '@genchi/observability';
import {
  PostgresApiKeyRepository,
  PostgresReadinessProbe,
  createPostgresPool,
  runMigrations,
} from '@genchi/persistence-postgres';
import { AnthropicAdapter } from '@genchi/provider-anthropic';
import { GeminiAdapter } from '@genchi/provider-gemini';
import { OpenAiAdapter } from '@genchi/provider-openai';
import { StaticModelCatalog, StaticPolicyRouter } from '@genchi/router';

import { buildGateway } from './app.js';

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
  const app = await buildGateway({
    config,
    logger,
    readinessProbe: new PostgresReadinessProbe(pool),
    chatCompletionService: new CreateChatCompletionService(
      authenticator,
      new StaticPolicyRouter(policy),
      buildProviderRegistry(policy, credentials),
    ),
    listModelsService: new ListModelsService(
      authenticator,
      new StaticModelCatalog(policy),
    ),
  });
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
