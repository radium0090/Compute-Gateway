import type { RoutingObserver } from '@genchi/domain';
import type { Meter } from '@opentelemetry/api';

import { getGenchiMeter } from './telemetry.js';

/** Creates bounded, content-free routing and resilience metrics. */
export function createRoutingObserver(
  meter: Meter = getGenchiMeter(),
): RoutingObserver {
  const attempts = meter.createCounter('genchi_provider_attempts_total');
  const duration = meter.createHistogram('genchi_provider_duration_seconds', {
    unit: 's',
  });
  const decisions = meter.createCounter('genchi_routing_decisions_total');
  const fallbacks = meter.createCounter('genchi_fallbacks_total');
  const rejections = meter.createCounter('genchi_rate_limit_rejections_total');
  const circuitStates = new Map<
    string,
    {
      readonly provider: string;
      readonly model: string;
      state: 'closed' | 'open' | 'half_open';
    }
  >();
  meter.createObservableGauge('genchi_circuit_state').addCallback((result) => {
    for (const circuit of circuitStates.values()) {
      result.observe(1, {
        provider: circuit.provider,
        model: circuit.model,
        state: circuit.state,
      });
    }
  });

  return {
    plan: (input) => {
      decisions.add(1, {
        alias: input.requestedModel,
        provider: input.selected.provider,
        model: input.selected.providerModel,
        reason: input.selectionReason,
        candidate_count: input.candidateCount,
      });
    },
    providerAttempt: (input) => {
      const labels = {
        provider: input.route.provider,
        model: input.route.providerModel,
        outcome: input.outcome,
      };
      attempts.add(1, labels);
      duration.record(input.durationMs / 1_000, labels);
    },
    fallback: (input) => {
      fallbacks.add(1, {
        from_provider: input.from.provider,
        to_provider: input.to.provider,
        reason: input.reason,
      });
    },
    admissionRejected: (input) => {
      rejections.add(1, { scope: input.scope, reason: input.reason });
    },
    circuitState: (route, state) => {
      circuitStates.set(`${route.providerRef}\u0000${route.providerModel}`, {
        provider: route.provider,
        model: route.providerModel,
        state,
      });
    },
    circuitSkipped: (route) => {
      decisions.add(1, {
        alias: 'configured',
        provider: route.provider,
        model: route.providerModel,
        reason: 'circuit_open',
      });
    },
  };
}
