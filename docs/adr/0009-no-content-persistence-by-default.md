# ADR 0009: No Content Persistence by Default

- Status: Accepted
- Date: 2026-08-03

## Context

Prompts, completions, tool arguments, and end-user identifiers may be highly
sensitive. Storing them makes analytics convenient but increases breach impact,
compliance scope, retention obligations, and contributor testing risk.

## Decision

Process model content in memory and do not persist it in the MVP. Exclude
content from logs, traces, metrics, usage events, and audit events. Store only
bounded operational metadata and token counts. Any future content capture must
be explicit opt-in with a separate threat model and ADR.

## Consequences

- Default deployment has a smaller privacy and security footprint.
- Operators cannot inspect historical prompts through Genchi for debugging or
  analytics.
- Debugging relies on metadata, reproducible test cases, and client-owned logs.
- Provider-side processing and retention remain outside Genchi and must be
  disclosed by operators.

## Alternatives rejected

- **Store content by default:** disproportionate risk for MVP value.
- **Log content only at debug level:** debug modes are frequently enabled during
  incidents and logs spread widely.
- **Hash content:** hashes can still reveal low-entropy inputs and provide little
  diagnostic value.

