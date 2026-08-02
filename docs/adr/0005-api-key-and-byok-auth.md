# ADR 0005: Genchi API Keys and Centrally Managed BYOK

- Status: Accepted
- Date: 2026-08-03

## Context

The gateway needs client identity, model authorization, and central provider
credentials. Passing provider keys through each request risks leakage and makes
policy enforcement inconsistent.

## Decision

Authenticate clients with high-entropy Genchi API keys stored as HMAC-SHA-256
hashes using an external pepper. Operators configure provider credentials from
environment or mounted secret sources and bind references to routes. Do not
accept per-request provider credentials in the MVP.

## Consequences

- Provider keys remain hidden from applications and centralized for rotation.
- Genchi keys can carry independent scope and limits.
- Database compromise alone does not reveal usable API keys if the pepper stays
  separate.
- Teams that require end-user BYOK need a future encrypted credential design.

## Alternatives rejected

- **Store plaintext keys:** unacceptable breach impact.
- **Fast hash without pepper:** high-entropy keys reduce risk, but a separate
  pepper adds defense in depth and supports efficient lookup verification.
- **Per-request provider key headers:** too easy to leak through edge systems,
  telemetry, and support tooling.
- **OAuth for MVP:** adds identity infrastructure unnecessary for server clients.

