# ADR 0003: Canonical Domain and Provider Adapters

- Status: Accepted
- Date: 2026-08-03

## Context

Provider request types, streams, errors, tools, and usage differ. Provider logic
inside HTTP handlers would couple the public API to vendor SDKs and make shared
reliability tests difficult.

## Decision

Define provider-neutral canonical request, chunk, response, capability, and
error types in the domain package. Each provider implements one adapter port and
passes a shared conformance suite. Routing and global resilience remain outside
adapters.

## Consequences

- Adding a provider does not change public handlers.
- Capability gaps are explicit and testable.
- The canonical model is intentionally the supported intersection plus explicit
  extensions; it must not grow into a union of every provider field.
- Changes to the provider port require careful migration and usually an ADR.

## Alternatives rejected

- **Use one provider SDK's types as canonical:** makes that provider privileged
  and leaks its versioning into the domain.
- **Provider branching in handlers:** produces coupling and duplicated policy.
- **Universal untyped JSON:** loses validation and makes silent data loss likely.

