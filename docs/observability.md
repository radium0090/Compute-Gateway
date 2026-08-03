# Observability

## Goals

An operator should answer: Was the gateway healthy? Which route was selected?
Where was time spent? Was a failure caused by caller, gateway, or provider?
No answer should require collecting prompt or completion content.

## Correlation

Every request has a Genchi request ID and W3C trace context. The request ID is
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
  "model_alias": "genchi/fast",
  "provider": "openai",
  "provider_model": "gpt-5-mini",
  "attempts": 1,
  "status_code": 200,
  "duration_ms": 843
}
```

Tenant/key identifiers are internal IDs, not secrets. Prompt, response, tool
arguments, authorization, cookies, provider keys, database URLs, and raw end-
user IDs are forbidden log fields. Debug level does not relax this rule.

## Metrics

Metric names use a `genchi_` prefix. Recommended baseline:

- `genchi_http_requests_total{route,method,status_class}`
- `genchi_http_request_duration_seconds{route}`
- `genchi_active_requests{route,streaming}`
- `genchi_provider_attempts_total{provider,model,outcome}`
- `genchi_provider_duration_seconds{provider,model,outcome}`
- `genchi_routing_decisions_total{alias,provider,reason}`
- `genchi_fallbacks_total{from_provider,to_provider,reason}`
- `genchi_rate_limit_rejections_total{scope}`
- `genchi_circuit_state{provider,model,state}`
- `genchi_usage_events_dropped_total{reason}`
- `genchi_build_info{version,commit}`

Do not label metrics with request, tenant, key, user, or provider request IDs.
Model labels are bounded to configured models to control cardinality.

The routing implementation currently emits provider attempts and duration,
route decisions, fallbacks, admission rejections, and observed circuit state.
It records only configured alias/provider/model names and bounded reason codes;
request IDs, API key IDs, credentials, prompts, and completions are excluded
from metric labels.

## Traces

One server span encloses child spans for auth, policy, routing, each provider
attempt, and usage recording. Attributes follow OpenTelemetry semantic
conventions where applicable. Span events record retry/fallback reason codes,
not error bodies. Trace sampling is head-based by default with optional
tail-based sampling at the Collector for failures; sampled traces still exclude
content.

## Service objectives

Initial SLOs for the gateway layer, excluding model correctness:

- 99.9% monthly availability for requests with at least one healthy configured
  provider route;
- p95 added gateway latency under 50 ms for non-streaming requests;
- 99.9% of accepted streams terminate or are cancelled without leaked work;
- key revocation visible within 30 seconds.

Provider availability and end-to-end latency are reported separately so a
provider incident is visible rather than hidden in gateway aggregates.

## Alerts

Alert on sustained gateway 5xx, absence of healthy routes for a public alias,
readiness loss, high event-loop lag, connection-pool exhaustion, unexpected
fallback surge, dropped usage events, Redis/database errors, and SLO burn rate.
Avoid paging on a single transient provider failure.

## Dashboards

The reference dashboard shows traffic, success/error classification, gateway
overhead, provider latency and errors, route distribution, fallback rate,
active streams, circuit state, saturation, and deployment version markers.
