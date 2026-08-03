import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';

import type { ResolvedRoute } from '@genchi/domain';

import { createRoutingObserver } from './routing-telemetry.js';

const primary: ResolvedRoute = {
  providerRef: 'openai-primary',
  provider: 'openai',
  providerModel: 'model-a',
};

const fallback: ResolvedRoute = {
  providerRef: 'anthropic-fallback',
  provider: 'anthropic',
  providerModel: 'model-b',
};

describe('createRoutingObserver', () => {
  it('emits bounded routing metrics without request or credential labels', async () => {
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const provider = new MeterProvider({ readers: [reader] });
    const observer = createRoutingObserver(provider.getMeter('routing-test'));

    observer.plan({
      requestedModel: 'genchi/fast',
      candidateCount: 2,
      selected: primary,
      selectionReason: 'stable_weighted_primary',
    });
    observer.providerAttempt({
      route: primary,
      attempt: 1,
      outcome: 'failure',
      durationMs: 125,
    });
    observer.fallback({
      from: primary,
      to: fallback,
      reason: 'provider_unavailable',
    });
    observer.admissionRejected({
      scope: 'api_key',
      reason: 'rate_limited',
    });
    observer.circuitState(primary, 'open');
    observer.circuitSkipped(primary);

    await provider.forceFlush();
    const metrics = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics);
    expect(metrics.map((metric) => metric.descriptor.name)).toEqual(
      expect.arrayContaining([
        'genchi_provider_attempts_total',
        'genchi_provider_duration_seconds',
        'genchi_routing_decisions_total',
        'genchi_fallbacks_total',
        'genchi_rate_limit_rejections_total',
        'genchi_circuit_state',
      ]),
    );
    const attributes = metrics.flatMap((metric) =>
      metric.dataPoints.map((point) => point.attributes),
    );
    expect(JSON.stringify(attributes)).not.toMatch(
      /request_id|api_key_id|key_id|credential|authorization/i,
    );

    await provider.shutdown();
  });
});
