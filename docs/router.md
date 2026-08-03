# Routing

## Goals

Routing MUST be deterministic, policy-driven, observable, and bounded by one
request deadline. The MVP does not use an LLM or opaque scoring model to choose
a route.

## Model identifiers

- Public alias: `genchi/fast`
- Provider-qualified model: `openai/gpt-5-mini`
- Bare provider model names are rejected to avoid ambiguity.

An alias resolves to ordered candidates:

```yaml
aliases:
  genchi/fast:
    candidates:
      - provider: openai
        model: gpt-5-mini
        weight: 100
      - provider: gemini
        model: gemini-2.5-flash
        weight: 0
    required_capabilities: [chat, streaming, tools]
```

A zero-weight candidate is fallback-only. Model names are examples and MUST be
configured; code must not assume provider catalogs remain static.

## Selection algorithm

For each request:

1. Authenticate and load the key policy.
2. Resolve the requested alias or qualified model.
3. Reject candidates not allowed for the key or deployment region.
4. Reject candidates missing request-required capabilities.
5. Reject disabled or open-circuit candidates.
6. Partition primary (`weight > 0`) and fallback-only candidates.
7. Select a primary using a stable weighted hash of request ID and alias.
8. Invoke it under the remaining total deadline.
9. On a retryable pre-commit failure, select the next eligible candidate in
   configured order, without revisiting an attempted route.
10. Return the normalized result or the most useful terminal error.

Stable hashing provides reproducible weighted distribution without storing
session state. It is not sticky across alias configuration versions.

## Retry and fallback

Retry means repeating the same provider/model; fallback means choosing a new
candidate. Default budgets:

```yaml
routing:
  total_timeout_ms: 60000
  connect_timeout_ms: 5000
  max_attempts: 2
  same_route_retries: 0
  minimum_attempt_budget_ms: 2000
  retry_base_delay_ms: 100
  global_max_concurrent_calls: 1000
  provider_max_concurrent_calls: 100
  circuit:
    failure_threshold: 5
    rolling_window_ms: 30000
    open_duration_ms: 30000
    half_open_max_calls: 1
```

Retryable pre-commit failures include connection reset, connection timeout,
provider 429, provider 5xx, and explicitly classified transient errors.
Authentication failures, invalid requests, content-policy decisions, context
length errors, and unsupported capabilities are not retryable.

The retry delay uses bounded exponential backoff with full jitter and respects
`Retry-After`, but it MUST NOT consume the minimum budget needed for another
attempt. `max_attempts` includes the first attempt.

## Streaming commitment

Before the first chunk, the router may fail over. Once headers or any chunk are
sent downstream, route selection is final. Mid-stream provider failure closes
the client stream; it MUST NOT splice content from another model.

## Circuit state

Circuit breaking is per provider/model/credential reference. The initial
implementation uses rolling error counts and states `closed`, `open`, and
`half_open`. Only classified provider/system failures affect the circuit;
caller errors do not. Thresholds are configuration, metrics expose state, and
operators can disable a route without waiting for the circuit.

## Rate and concurrency limits

Limits are evaluated before route selection:

- per API key request rate;
- per API key concurrent requests;
- global/provider concurrent calls;
- optional provider/model token budget when reliable usage estimates exist.

Multi-replica exact limits require Redis. When Redis is required and
unavailable, production mode fails closed with a 503 or 429 as configured.
The reference implementation uses atomic Redis scripts and expiring,
token-addressed concurrency leases. Development without Redis uses equivalent
process-local coordination; its counts and circuit state are not shared across
replicas.

Admission failures map to `429` for rate or concurrency saturation and `503`
when required coordination is unavailable. Responses may include a bounded
`Retry-After` value; raw API key IDs are not used as Redis keys or telemetry
labels.

## Route explanation

Telemetry records alias, policy version, candidate count, chosen provider/model,
attempt number, selection reason, skipped-candidate reason codes, and terminal
classification. It MUST NOT record message content or raw credentials.

## Configuration validation

Startup fails when an alias has no candidates, references an unknown provider,
uses negative weights, duplicates a route, or claims required capabilities that
no candidate supports. Runtime configuration updates are applied atomically.
