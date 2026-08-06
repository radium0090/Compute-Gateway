import type { FastifyInstance } from 'fastify';

import { getCorrelationContext, getGenchiMeter } from '@genchi/observability';

/** Registers bounded, content-free HTTP metrics and completion events. */
export function registerRequestTelemetry(app: FastifyInstance): void {
  const meter = getGenchiMeter();
  const requestCount = meter.createCounter('genchi_http_requests_total', {
    description: 'Completed gateway HTTP requests',
  });
  const requestDuration = meter.createHistogram(
    'genchi_http_request_duration_seconds',
    {
      description: 'Gateway HTTP request duration in seconds',
      unit: 's',
    },
  );
  const activeRequests = meter.createUpDownCounter('genchi_active_requests', {
    description: 'Currently active gateway HTTP requests',
  });

  app.addHook('onRequest', (request) => {
    activeRequests.add(1, {
      route: request.routeOptions.url ?? 'unmatched',
    });
    return Promise.resolve();
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const statusClass = `${String(Math.floor(reply.statusCode / 100))}xx`;
    const durationSeconds = reply.elapsedTime / 1_000;
    const labels = { route, method: request.method, status_class: statusClass };

    activeRequests.add(-1, { route });
    requestCount.add(1, labels);
    requestDuration.record(durationSeconds, { route });

    const correlation = getCorrelationContext();
    request.log.info(
      {
        event: 'request.completed',
        request_id: request.id,
        ...(correlation.traceId === undefined
          ? {}
          : { trace_id: correlation.traceId }),
        route,
        method: request.method,
        status_code: reply.statusCode,
        duration_ms: reply.elapsedTime,
      },
      'request completed',
    );
  });
}
