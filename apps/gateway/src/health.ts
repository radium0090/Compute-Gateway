import type { FastifyInstance } from 'fastify';

import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
  type LivenessResponse,
  type ReadinessResponse,
} from '@genchi/api-contract';

export interface ReadinessProbe {
  check(): Promise<{
    readonly ready: boolean;
    readonly checks?: {
      readonly postgres: 'ok' | 'error';
      readonly redis?: 'ok' | 'error';
    };
  }>;
}

/** Registers orchestration health signals without application business logic. */
export function registerHealthRoutes(
  app: FastifyInstance,
  readinessProbe: ReadinessProbe,
): void {
  app.get<{ Reply: LivenessResponse }>(
    '/health/live',
    {
      schema: {
        response: { 200: LivenessResponseSchema },
      },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      return { status: 'ok' };
    },
  );

  app.get<{ Reply: ReadinessResponse }>(
    '/health/ready',
    {
      schema: {
        response: {
          200: ReadinessResponseSchema,
          503: ReadinessResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      reply.header('cache-control', 'no-store');
      const result = await readinessProbe.check();
      if (!result.ready) {
        reply.code(503);
        return {
          status: 'not_ready',
          checks: result.checks ?? { postgres: 'error' },
        };
      }
      return {
        status: 'ready',
        checks: result.checks ?? { postgres: 'ok' },
      };
    },
  );
}
