import type { IncomingMessage, ServerResponse } from 'node:http';

import { FastifyOtelInstrumentation } from '@fastify/otel';
import {
  isSpanContextValid,
  metrics,
  trace,
  type Meter,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface TelemetryOptions {
  readonly environment: string;
  readonly serviceVersion: string;
  readonly commitSha: string;
  readonly otlpEndpoint?: string;
  readonly metricsEnabled: boolean;
}

export interface CorrelationContext {
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface BuildIdentity {
  readonly serviceVersion: string;
  readonly commitSha: string;
}

export type MetricsRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

function signalsEndpoint(
  baseUrl: string,
  signal: 'v1/traces' | 'v1/metrics',
): string {
  return `${baseUrl.replace(/\/$/, '')}/${signal}`;
}

/** Registers a constant gauge that lets operators match telemetry to a build. */
export function registerBuildInfo(meter: Meter, identity: BuildIdentity): void {
  const buildInfo = meter.createObservableGauge('rcg_build_info', {
    description: 'Build identity for the running gateway',
  });
  buildInfo.addCallback((result) => {
    result.observe(1, {
      version: identity.serviceVersion,
      commit: identity.commitSha,
    });
  });
}

/** Owns OpenTelemetry SDK startup and shutdown for one gateway process. */
export class TelemetryLifecycle {
  private readonly sdk: NodeSDK;
  private readonly prometheusExporter: PrometheusExporter | undefined;
  private readonly buildIdentity: BuildIdentity;
  private started = false;

  public constructor(options: TelemetryOptions) {
    this.buildIdentity = options;
    const traceExporter =
      options.otlpEndpoint === undefined
        ? undefined
        : new OTLPTraceExporter({
            url: signalsEndpoint(options.otlpEndpoint, 'v1/traces'),
          });
    const otlpMetricReader =
      options.otlpEndpoint === undefined || !options.metricsEnabled
        ? undefined
        : new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: signalsEndpoint(options.otlpEndpoint, 'v1/metrics'),
            }),
          });
    this.prometheusExporter = options.metricsEnabled
      ? new PrometheusExporter({
          preventServerStart: true,
          withoutScopeInfo: true,
          withoutTargetInfo: true,
        })
      : undefined;
    const metricReaders = [
      ...(this.prometheusExporter === undefined
        ? []
        : [this.prometheusExporter]),
      ...(otlpMetricReader === undefined ? [] : [otlpMetricReader]),
    ];

    this.sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'rax-compute-gateway',
        [ATTR_SERVICE_VERSION]: options.serviceVersion,
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
      }),
      instrumentations: [
        new HttpInstrumentation(),
        new FastifyOtelInstrumentation({ registerOnInitialization: true }),
      ],
      // An explicit empty list prevents NodeSDK from silently creating an
      // environment-derived exporter when RAX Compute Gateway telemetry is not configured.
      spanProcessors:
        traceExporter === undefined
          ? []
          : [new BatchSpanProcessor(traceExporter)],
      ...(metricReaders.length === 0 ? {} : { metricReaders }),
    });
  }

  public start(): void {
    this.sdk.start();
    if (!this.started) {
      registerBuildInfo(
        metrics.getMeter('rax-compute-gateway'),
        this.buildIdentity,
      );
      this.started = true;
    }
  }

  public async stop(): Promise<void> {
    await this.sdk.shutdown();
  }

  public metricsRequestHandler(): MetricsRequestHandler | undefined {
    const exporter = this.prometheusExporter;
    return exporter === undefined
      ? undefined
      : (request, response) => {
          exporter.getMetricsRequestHandler(request, response);
        };
  }
}

export function getCorrelationContext(): CorrelationContext {
  const context = trace.getActiveSpan()?.spanContext();
  return context === undefined || !isSpanContextValid(context)
    ? {}
    : { traceId: context.traceId, spanId: context.spanId };
}

export function getRaxComputeGatewayMeter() {
  return metrics.getMeter('rax-compute-gateway');
}
