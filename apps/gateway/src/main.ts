import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { RuntimeConfig } from '@genchi/config';
import { createLogger } from '@genchi/observability';
import {
  PostgresReadinessProbe,
  createPostgresPool,
  runMigrations,
} from '@genchi/persistence-postgres';

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

/** Starts the gateway and owns all infrastructure lifecycle resources. */
export async function runGateway(config: RuntimeConfig): Promise<void> {
  const logger = createLogger({
    environment: config.environment,
    level: config.logLevel,
  });
  const pool = createPostgresPool({
    databaseUrl: config.databaseUrl,
    connectTimeoutMs: config.connectTimeoutMs,
  });
  const app = await buildGateway({
    config,
    logger,
    readinessProbe: new PostgresReadinessProbe(pool),
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
