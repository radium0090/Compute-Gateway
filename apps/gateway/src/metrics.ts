import type { FastifyInstance } from 'fastify';

import type { MetricsRequestHandler } from '@rax-digital/observability';

/** Exposes the process-local OpenTelemetry reader in Prometheus text format. */
export function registerMetricsRoute(
  app: FastifyInstance,
  handler: MetricsRequestHandler,
): void {
  app.get('/metrics', (request, reply) => {
    reply.hijack();
    handler(request.raw, reply.raw);
    return reply;
  });
}
