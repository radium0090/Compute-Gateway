import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  getCorrelationContext,
  getRaxComputeGatewayMeter,
} from '@rax-digital/observability';

/** Registers bounded, content-free HTTP metrics and completion events. */
export function registerRequestTelemetry(app: FastifyInstance): void {
  const meter = getRaxComputeGatewayMeter();
  const requestCount = meter.createCounter('rcg_http_requests_total', {
    description: 'Completed gateway HTTP requests',
  });
  const requestDuration = meter.createHistogram(
    'rcg_http_request_duration_seconds',
    {
      description: 'Gateway HTTP request duration in seconds',
      unit: 's',
    },
  );
  const activeRequests = meter.createUpDownCounter('rcg_active_requests', {
    description: 'Currently active gateway HTTP requests',
  });
  const active = new WeakMap<FastifyRequest, () => void>();

  app.addHook('onRequest', (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    let counted = true;
    const finish = (): void => {
      if (!counted) return;
      counted = false;
      activeRequests.add(-1, { route });
    };
    active.set(request, finish);
    activeRequests.add(1, { route });
    // onResponse is not guaranteed after a downstream disconnect. Tracking
    // the raw lifecycle keeps the gauge accurate without counting twice.
    request.raw.once('aborted', finish);
    reply.raw.once('close', finish);
    return Promise.resolve();
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const statusClass = `${String(Math.floor(reply.statusCode / 100))}xx`;
    const durationSeconds = reply.elapsedTime / 1_000;
    const labels = { route, method: request.method, status_class: statusClass };

    active.get(request)?.();
    active.delete(request);
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
