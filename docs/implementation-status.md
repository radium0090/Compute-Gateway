# Implementation status

This page records the code-to-specification review performed on 2026-08-09.
Accepted ADRs and the normative documents remain authoritative; this page is a
status snapshot, not a new architecture decision.

## Current state

The MVP implementation is feature-complete enough for infrastructure and
release-candidate validation. The public chat and model APIs, three providers,
streaming, authentication, deterministic routing, fallback, bounded retries,
rate/concurrency coordination, circuit breaking, PostgreSQL migrations,
OpenTelemetry, SDK previews, and Docker/Kubernetes delivery assets are present.

The protected live-provider workflow has passed non-streaming and streaming
requests for OpenAI, Anthropic, and Gemini. This does not replace datastore,
staging, backup/restore, or immutable-image validation.

## Specification mapping

| Requirement | Implementation status | Remaining evidence or limitation |
| --- | --- | --- |
| Chat completions and SSE | Implemented and covered by contract/lifecycle tests | Repeat client-disconnect and graceful-shutdown tests on staging |
| OpenAI, Anthropic, Gemini | Implemented; shared conformance and protected live smoke pass | Re-run when provider model/API configuration changes |
| API keys and model permissions | HMAC-backed keys, status/expiry/environment checks, model allow-list and streaming permission implemented | Per-key `maxRequestTokens` and `maxOutputTokens` are stored but not enforced |
| Routing and resilience | Stable weighted primary selection, ordered fallback, bounded retry, deadlines, concurrency and circuit state implemented | Deployment-region and operator-disabled route filtering described in `docs/router.md` has no policy field yet |
| PostgreSQL and Redis | Migration/repository and atomic Redis coordination implementations exist | Real PostgreSQL/Redis CI or server evidence must be recorded; production requires Redis |
| Observability | Structured content-free logs, metrics, traces, build identity and shutdown flushing implemented | No bundled production dashboard; custom routing child spans are not part of `0.1` |
| Docker and Kubernetes | Compose, hardened image, Helm chart, two-replica/rolling CI validation implemented | Deploy an immutable candidate digest to the target server/staging environment |
| SDKs and OpenAPI | TypeScript/Python clients, generated schemas, lint and compatibility gates implemented | Package registry publication is intentionally disabled for `0.1` |

## Known documentation-to-code gaps

These items require a scoped issue or ADR before behavior changes:

1. `docs/router.md` describes deployment-region filtering and an explicit
   operator-disabled route state. The version 1 policy schema currently has no
   region or enabled/disabled fields; open-circuit filtering happens during
   execution instead of static plan construction.
2. API-key token ceilings are accepted by the operator command and persisted,
   but the application service does not enforce them. Input-token enforcement
   needs an agreed tokenizer/estimation rule; output ceilings need a documented
   reject-versus-cap rule.
3. The provider capability domain supports `jsonObject`, `systemMessages`, and
   model token limits, while policy version 1 exposes only `chat`, `streaming`,
   `tools`, and `json_schema`. Tool and structured-output request fields remain
   explicit MVP non-goals.
4. Runtime policy updates are described as atomic in `docs/router.md`, but the
   current process loads one validated policy at startup and does not hot
   reload it.
5. `docs/coding-standards.md` calls for property tests covering weighted
   routing, deadline budgets, and redaction. The current suite has deterministic
   examples and conformance tests for these paths, but no property-test harness.

## Release blockers

The repository must not be presented as a completed `v0.1.0` release until the
evidence template in `docs/releases/0.1.0-rc.md` is complete. In particular:

- run PostgreSQL and Redis integration tests against real services;
- record CI, security, container/SBOM, Kubernetes, nightly datastore, and p95
  benchmark evidence for the immutable candidate commit;
- verify backup/restore and both empty-install and staging migrations;
- deploy by image digest and run health, models, completion, streaming,
  disconnect, graceful-shutdown, and rollback checks;
- complete the security and operator review before signing the release tag.

## Intentionally deferred work

The web dashboard, hosted signup/billing, durable audit events, extra provider
families, stronger cost/token budgets, package publication, and additional API
surfaces belong to later roadmap phases. They are not missing `0.1` provider or
routing logic and should not be added without the corresponding scope and ADR
review.
