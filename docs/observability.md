# Observability

## Goals

An operator should answer: Was the gateway healthy? Which route was selected?
Where was time spent? Was a failure caused by caller, gateway, or provider?
No answer should require collecting prompt or completion content.

## Correlation

Every request has a RAX Compute Gateway request ID and W3C trace context. The request ID is
returned in `x-request-id` and error metadata. Provider request IDs are recorded
as protected, bounded attributes when available.

## Structured logs

Logs are JSON in production with fields such as:

```json
{
  "timestamp": "2026-08-03T00:00:00.000Z",
  "level": "info",
  "event": "request.completed",
  "request_id": "req_01J...",
  "trace_id": "...",
  "tenant_id": "tnt_...",
  "model_alias": "rax/fast",
  "provider": "openai",
  "provider_model": "gpt-5-mini",
  "attempts": 1,
  "status_code": 200,
  "duration_ms": 843
}
```

Tenant/key identifiers are internal IDs, not secrets. Prompt and response
content, authorization, cookies, provider keys, database URLs, and raw end-user
IDs are forbidden log fields. Debug level does not relax this rule.

## Metrics

Metric names use a `rcg_` prefix. Recommended baseline:

- `rcg_http_requests_total{route,method,status_class}`
- `rcg_http_request_duration_seconds{route}`
- `rcg_active_requests{route}`
- `rcg_provider_attempts_total{provider,model,outcome}`
- `rcg_provider_duration_seconds{provider,model,outcome}`
- `rcg_routing_decisions_total{alias,provider,reason}`
- `rcg_fallbacks_total{from_provider,to_provider,reason}`
- `rcg_admission_rejections_total{scope,reason}`
- `rcg_circuit_state{provider,model,state}`
- `rcg_build_info{version,commit}`

Do not label metrics with request, tenant, key, user, or provider request IDs.
Model labels are bounded to configured models to control cardinality.

The routing implementation currently emits provider attempts and duration,
route decisions, fallbacks, admission rejections, and observed circuit state.
It records only configured alias/provider/model names and bounded reason codes;
request IDs, API key IDs, credentials, prompts, and completions are excluded
from metric labels.

When `RCG_METRICS_ENABLED=true`, `GET /metrics` exposes the same process-local
OpenTelemetry instruments in Prometheus text format. It is unauthenticated at
the application layer and MUST remain on a private Service/ingress policy. When
metrics are disabled, the route is not registered. OTLP export may run at the
same time without duplicating instrumentation.

Release builds also register `rcg_build_info` from
`RCG_SERVICE_VERSION` and `RCG_COMMIT_SHA`. The Docker build sets both
from release identity; operators can use them as deployment markers without
adding unbounded labels.

The reference Compose Collector enables health checking, memory limiting, and
batching before exporting OTLP. Production deployments should keep the
Collector separate from the gateway and add vendor authentication only through
the platform secret system.

## Traces

OpenTelemetry HTTP and Fastify instrumentation creates inbound server and
outbound provider HTTP spans. Routing, fallback, admission, and circuit details
are currently emitted through bounded metrics and structured log events rather
than custom child spans. Sampled traces exclude request and response content.

## Service objectives

Initial SLOs for the gateway layer, excluding model correctness:

- 99.9% monthly availability for requests with at least one healthy configured
  provider route;
- p95 added gateway latency under 50 ms for non-streaming requests;
- 99.9% of accepted streams terminate or are cancelled without leaked work;
- key revocation enforced on the next database-backed authentication attempt.

Provider availability and end-to-end latency are reported separately so a
provider incident is visible rather than hidden in gateway aggregates.

## Alerts

Alert on sustained gateway 5xx, absence of healthy routes for a public alias,
readiness loss, connection-pool exhaustion, unexpected fallback surge,
Redis/database errors, and SLO burn rate. Avoid paging on a single transient
provider failure.

## Dashboards

A production dashboard should show traffic, success/error classification,
gateway overhead, provider latency and errors, route distribution, fallback
rate, active requests, circuit state, saturation, and deployment version
markers. A dashboard bundle is not included in `0.1`.
