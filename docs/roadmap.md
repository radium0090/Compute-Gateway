# Roadmap

This roadmap communicates direction, not guaranteed dates. GitHub milestones
and accepted issues are the source for committed release scope.

## Phase 0: Specification and foundation

- public contract, ADRs, repository governance, threat model;
- monorepo, typed configuration, database migrations, health endpoints;
- local development and CI foundations.

Exit: vertical architecture compiles, test infrastructure runs, and all binding
decisions are documented.

## Phase 1: MVP (`0.1`)

- OpenAI-compatible chat completions and model list;
- OpenAI, Anthropic, Gemini adapters;
- streaming, tools, canonical errors and usage;
- API keys, model permissions, limits;
- deterministic aliases, fallback, circuit state;
- PostgreSQL/Redis and OpenTelemetry;
- Docker Compose, OCI image, Helm baseline;
- TypeScript/Python SDK preview.

Exit: all [MVP acceptance criteria](mvp.md#acceptance-criteria) pass.

## Phase 2: Hardening (`0.2`–`0.4`)

- additional provider adapters based on community demand;
- configuration publication and operator CLI improvements;
- stronger cost/token budgets and provider quota awareness;
- performance, chaos, recovery, and compatibility testing;
- stable SDK packaging and broader examples;
- security assessment and operational runbooks.

## Phase 3: Stable gateway (`1.0`)

- stability commitment for `/v1` and provider contract;
- documented upgrade/deprecation policy and support matrix;
- audited security and incident process;
- proven multi-replica operation and release provenance;
- mature contributor and adapter governance.

## Future exploration

Subject to evidence and separate ADRs:

- embeddings, image/audio, realtime, and batch APIs;
- local/OpenAI-compatible endpoints and GPU routing;
- latency, price, region, and capacity-aware policies;
- semantic cache with explicit privacy boundaries;
- policy-as-code and enterprise identity/control integrations;
- hosted Genchi Cloud for managed teams, analytics, and billing;
- compute scheduling and portable compute credits.

## Prioritization criteria

Work is prioritized by user pain, reliability/security risk, adoption impact,
maintainability, provider neutrality, and verifiable evidence. A high star count
alone does not outweigh unsafe or contract-breaking design.

## Out of scope promises

The roadmap does not promise provider uptime, equal output across models,
automatic cost savings, model correctness, or availability of a hosted service.

