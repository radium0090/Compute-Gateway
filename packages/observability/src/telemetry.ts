import { FastifyOtelInstrumentation } from '@fastify/otel';
import { isSpanContextValid, metrics, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
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
  readonly otlpEndpoint?: string;
  readonly metricsEnabled: boolean;
}

export interface CorrelationContext {
  readonly traceId?: string;
  readonly spanId?: string;
}

function signalsEndpoint(
  baseUrl: string,
  signal: 'v1/traces' | 'v1/metrics',
): string {
  return `${baseUrl.replace(/\/$/, '')}/${signal}`;
}

/** Owns OpenTelemetry SDK startup and shutdown for one gateway process. */
export class TelemetryLifecycle {
  private readonly sdk: NodeSDK;

  public constructor(options: TelemetryOptions) {
    const traceExporter =
      options.otlpEndpoint === undefined
        ? undefined
        : new OTLPTraceExporter({
            url: signalsEndpoint(options.otlpEndpoint, 'v1/traces'),
          });
    const metricReader =
      options.otlpEndpoint === undefined || !options.metricsEnabled
        ? undefined
        : new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: signalsEndpoint(options.otlpEndpoint, 'v1/metrics'),
            }),
          });

    this.sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'genchi-gateway',
        [ATTR_SERVICE_VERSION]: options.serviceVersion,
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
      }),
      instrumentations: [
        new HttpInstrumentation(),
        new FastifyOtelInstrumentation({ registerOnInitialization: true }),
      ],
      // An explicit empty list prevents NodeSDK from silently creating an
      // environment-derived exporter when Genchi telemetry is not configured.
      spanProcessors:
        traceExporter === undefined
          ? []
          : [new BatchSpanProcessor(traceExporter)],
      ...(metricReader === undefined ? {} : { metricReader }),
    });
  }

  public start(): void {
    this.sdk.start();
  }

  public async stop(): Promise<void> {
    await this.sdk.shutdown();
  }
}

export function getCorrelationContext(): CorrelationContext {
  const context = trace.getActiveSpan()?.spanContext();
  return context === undefined || !isSpanContextValid(context)
    ? {}
    : { traceId: context.traceId, spanId: context.spanId };
}

export function getGenchiMeter() {
  return metrics.getMeter('genchi-gateway');
}
