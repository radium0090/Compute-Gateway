# ADR 0004: Deterministic Policy Routing

- Status: Accepted
- Date: 2026-08-03

## Context

Routing must balance provider choice and fallback without making behavior opaque
or unpredictable. Cost/quality scoring data is incomplete in an early project,
and an LLM router adds latency, expense, and new failure modes.

## Decision

Use operator-defined aliases with ordered candidates, capability/permission
filters, stable weighted hashing for primary selection, and bounded pre-commit
fallback. One total deadline and maximum-attempt budget covers the request.
Never splice streams or retry after downstream commitment.

## Consequences

- Decisions can be reproduced from request ID, policy version, and health state.
- Operators control rollout and fallback explicitly.
- Routing is not automatically optimal for quality or price.
- Future adaptive policies can be added behind explicit modes after reliable
  measurements and a new ADR.

## Alternatives rejected

- **Random selection:** harder to reproduce and debug.
- **LLM/semantic router:** opaque, expensive, and premature for MVP evidence.
- **Always cheapest/fastest:** provider metadata is dynamic and simplistic rules
  can violate capability and reliability requirements.
- **Retry after streaming begins:** risks duplicated or incoherent output.

