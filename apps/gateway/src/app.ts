import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
} from 'fastify';

import type { RuntimeConfig } from '@genchi/config';

import { registerHealthRoutes, type ReadinessProbe } from './health.js';
import { registerRequestTelemetry } from './request-telemetry.js';

export interface GatewayDependencies {
  readonly config: RuntimeConfig;
  readonly logger: FastifyBaseLogger;
  readonly readinessProbe: ReadinessProbe;
}

function requestId(request: IncomingMessage): string {
  const supplied = request.headers['x-request-id'];
  if (
    typeof supplied === 'string' &&
    /^[A-Za-z0-9._-]{8,128}$/.test(supplied)
  ) {
    return supplied;
  }
  return `req_${randomUUID().replaceAll('-', '')}`;
}

/** Builds the Fastify composition root for one gateway process. */
export async function buildGateway(
  dependencies: GatewayDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: dependencies.logger,
    bodyLimit: dependencies.config.requestBodyLimitBytes,
    trustProxy: dependencies.config.trustProxy,
    genReqId: requestId,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerRequestTelemetry(app);
  registerHealthRoutes(app, dependencies.readinessProbe);
  return app;
}
