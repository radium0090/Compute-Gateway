# ADR 0001: TypeScript and Node.js Gateway Runtime

- Status: Accepted
- Date: 2026-08-03

## Context

The MVP needs rapid development, shared schemas with a TypeScript SDK, mature
HTTP streaming, strong validation, and a large contributor pool. The data plane
is primarily network-bound rather than CPU-bound.

## Decision

Build the gateway on Node.js 22 LTS with TypeScript strict mode, Fastify, and
pnpm workspaces. Domain packages remain framework-independent. CPU-heavy work
must not run synchronously on the event loop.

## Consequences

- API schemas and TypeScript types can share one source.
- Streaming and provider SDK integrations are practical.
- Event-loop lag, memory, cancellation, and socket limits require explicit
  production observability and load testing.
- The project may later add services in other languages, but the MVP does not
  introduce a polyglot build.

## Alternatives rejected

- **Go:** excellent deployment and concurrency characteristics, but less reuse
  with TypeScript contracts and slower initial product iteration for this MVP.
- **Python:** strong AI ecosystem, but less suitable for this gateway's chosen
  type-sharing and high-concurrency streaming baseline.
- **Multiple runtimes initially:** increases release and contributor complexity
  before clear component boundaries justify it.

