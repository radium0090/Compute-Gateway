# ADR 0002: OpenAI-Compatible Public API

- Status: Accepted
- Date: 2026-08-03

## Context

Developers need a low-friction migration path. A new proprietary schema would
require custom SDKs before users can evaluate Genchi. Provider APIs overlap but
are not identical.

## Decision

Expose an OpenAI-compatible `/v1/chat/completions` and `/v1/models` subset. Use
strict validation, documented capability checks, canonical errors, and a
namespaced `genchi` response extension. Do not claim fields that cannot be
represented consistently.

## Consequences

- Existing OpenAI clients can work through a base URL/key change.
- Compatibility is bounded and testable rather than a vague full-API claim.
- Provider-specific features need namespaced allowlisted options or future
  contract changes.
- Breaking public changes require a new API version.

## Alternatives rejected

- **Novel Genchi-only API:** maximizes purity but creates unnecessary adoption
  friction.
- **Blind pass-through:** cannot support multiple providers safely or normalize
  errors and capabilities.
- **Full emulation of every OpenAI endpoint:** far beyond the MVP and creates
  misleading compatibility expectations.

