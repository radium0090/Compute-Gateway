# Architecture

## Context

```text
                     Control/configuration path
                 +-------------------------------+
                 | PostgreSQL      Secret source |
                 +--------+---------------+------+
                          |               |
Client -> Load balancer -> Genchi Gateway replicas -> Provider APIs
                          |       |
                          |       +-> Redis (optional coordination)
                          +----------> OpenTelemetry Collector
```

The gateway data plane is stateless. PostgreSQL stores durable metadata and
policy. Redis coordinates distributed rate limits and short-lived circuit
state when more than one replica is used. Provider credentials come from
environment variables or an external secret manager, never from PostgreSQL in
the MVP.

## Runtime modules

| Module | Responsibility |
| --- | --- |
| HTTP edge | TLS termination integration, request IDs, body limits, CORS, auth |
| API service | OpenAI-compatible validation and response serialization |
| Policy service | tenant/key permissions, model aliases, quotas |
| Router | candidate resolution, health filtering, selection, fallback budget |
| Provider registry | adapter discovery and capability declaration |
| Adapters | provider-specific translation, invocation, and error normalization |
| Resilience | deadlines, bounded retries, concurrency, circuit state |
| Telemetry | metrics, spans, structured redacted events |
| Persistence | typed repositories and transactional migrations |

## Request lifecycle

1. The edge assigns or validates `x-request-id`, enforces the body limit, and
   authenticates the Genchi key.
2. The API service validates the request against the public schema.
3. Policy resolves the requested alias/model and caller permissions.
4. The router builds an ordered candidate set and removes unavailable routes.
5. The chosen adapter translates the request and applies a deadline.
6. Resilience may retry or fall back only before downstream response commitment.
7. The adapter normalizes usage, finish reasons, responses, or errors.
8. Telemetry records route metadata and timings without prompt content.
9. A compact usage event is written asynchronously; failure to write it does
   not corrupt an otherwise valid client response.

## Dependency direction

```text
HTTP/API -> application services -> domain contracts <- provider adapters
                                      ^
                                      |
                              persistence/telemetry
```

Domain contracts MUST NOT import Fastify, a provider SDK, database clients, or
OpenTelemetry types. Adapters implement ports defined in the domain package.

## Provider contract

```ts
interface ProviderAdapter {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  listConfiguredModels(ctx: RequestContext): Promise<ProviderModel[]>;
  createChatCompletion(
    request: CanonicalChatRequest,
    ctx: ProviderCallContext,
  ): Promise<CanonicalChatResponse>;
  streamChatCompletion(
    request: CanonicalChatRequest,
    ctx: ProviderCallContext,
  ): AsyncIterable<CanonicalChatChunk>;
}
```

Every adapter MUST support cancellation, deadlines, error normalization,
redaction, and the shared conformance suite. Capability gaps MUST be rejected
before provider invocation rather than silently ignored.

## Availability model

- Gateway replicas are interchangeable and may be added horizontally.
- Readiness is false when required configuration or PostgreSQL is unavailable.
- Redis failure degrades only features declared as Redis-dependent; production
  defaults fail closed for distributed rate limiting.
- Provider failure affects only routes using that provider.
- Each request has one total deadline shared across attempts.
- Graceful shutdown stops accepting requests, drains in-flight work up to the
  configured grace period, and cancels remaining provider calls.

## Consistency

Policy and key revocation use bounded-staleness caches. Revocation MUST become
effective within `AUTH_CACHE_TTL_SECONDS` (default 30 seconds). Alias changes
MUST become visible within `CONFIG_CACHE_TTL_SECONDS` (default 15 seconds).
Database writes are strongly consistent; data-plane reads may use these caches.

## Technology baseline

- Node.js 24 LTS, TypeScript 5.x, pnpm workspaces
- Fastify with JSON Schema/TypeBox validation
- PostgreSQL 16, Redis 7 (optional locally, required for multi-replica limits)
- OpenTelemetry SDK and Collector
- Vitest, Testcontainers, and provider mock servers
- OCI images built from a pinned, minimal non-root runtime image

See the [ADRs](adr/README.md) for the rationale behind binding decisions.
