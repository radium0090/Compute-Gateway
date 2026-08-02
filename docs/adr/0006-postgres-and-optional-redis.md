# ADR 0006: PostgreSQL Plus Optional Redis

- Status: Accepted
- Date: 2026-08-03

## Context

Durable keys, policies, aliases, audits, and usage metadata require transactional
storage. Multi-replica rate limits and short-lived circuit coordination need
low-latency shared state, while a local single-node deployment should remain
simple.

## Decision

Use PostgreSQL 16 as the system of record. Use Redis 7 only for distributed rate
limits, coordination, and ephemeral circuit state. Redis is optional for local
single-node mode and required when enabled production features depend on it.

## Consequences

- Operators get a well-understood durable store with transactional migrations.
- Redis loss cannot lose durable policy or credentials.
- Production failure behavior must state whether a Redis-dependent control fails
  open or closed; rate limits fail closed by default.
- Two operational dependencies are required for fully coordinated deployments.

## Alternatives rejected

- **Redis as system of record:** weaker fit for relational/audit metadata and
  durable migrations.
- **PostgreSQL for every rate-limit operation:** possible but risks database load
  and contention in a high-volume data path.
- **In-memory only:** inconsistent across replicas and lost on restart.
- **Multiple database options initially:** multiplies migration and test burden.

