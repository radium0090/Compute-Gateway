import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
} from 'fastify';

import type { RuntimeConfig } from '@rax-digital/config';
import type {
  CreateChatCompletionService,
  ListModelsService,
} from '@rax-digital/application';
import type { MetricsRequestHandler } from '@rax-digital/observability';

import { registerChatCompletionRoute } from './chat-completion.js';
import { registerAdminRoutes, type AdminRouteService } from './admin-routes.js';
import { registerErrorHandling } from './error-handling.js';
import { registerHealthRoutes, type ReadinessProbe } from './health.js';
import { registerMetricsRoute } from './metrics.js';
import { registerModelsRoute } from './models.js';
import { registerRequestTelemetry } from './request-telemetry.js';

export interface GatewayDependencies {
  readonly config: RuntimeConfig;
  readonly logger: FastifyBaseLogger;
  readonly readinessProbe: ReadinessProbe;
  readonly chatCompletionService?: Pick<
    CreateChatCompletionService,
    'execute' | 'executeStream'
  >;
  readonly listModelsService?: Pick<ListModelsService, 'execute'>;
  readonly metricsRequestHandler?: MetricsRequestHandler;
  readonly requestTimeoutSignalFactory?: (timeoutMs: number) => AbortSignal;
  readonly admin?: {
    readonly service: AdminRouteService;
    readonly origin: string;
    readonly sessionTtlMs: number;
  };
}

function requestId(request: IncomingMessage): string {
  const supplied = request.headers['x-request-id'];
  if (
    typeof supplied === 'string' &&
    /^[A-Za-z0-9._-]{1,128}$/.test(supplied)
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
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  registerRequestTelemetry(app);
  registerErrorHandling(app);
  registerHealthRoutes(app, dependencies.readinessProbe);
  if (dependencies.metricsRequestHandler !== undefined) {
    registerMetricsRoute(app, dependencies.metricsRequestHandler);
  }
  if (dependencies.chatCompletionService !== undefined) {
    registerChatCompletionRoute(app, {
      service: dependencies.chatCompletionService,
      totalTimeoutMs: dependencies.config.totalTimeoutMs,
      ...(dependencies.requestTimeoutSignalFactory === undefined
        ? {}
        : {
            timeoutSignalFactory: dependencies.requestTimeoutSignalFactory,
          }),
    });
  }
  if (dependencies.listModelsService !== undefined) {
    registerModelsRoute(app, { service: dependencies.listModelsService });
  }
  if (dependencies.admin !== undefined) {
    await registerAdminRoutes(app, {
      ...dependencies.admin,
      readinessProbe: dependencies.readinessProbe,
    });
  }
  return app;
}
