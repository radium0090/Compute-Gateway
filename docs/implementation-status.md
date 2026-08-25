# Implementation status

This page records the code-to-specification review updated on 2026-08-25.
Accepted ADRs and the normative documents remain authoritative; this page is a
status snapshot, not a new architecture decision.

## Current state

The MVP implementation was published as signed
[`v0.1.0`](https://github.com/radium0090/Compute-Gateway/releases/tag/v0.1.0),
and the operator and evaluation additions are published as
[`v0.2.0`](https://github.com/radium0090/Compute-Gateway/releases/tag/v0.2.0).
The `v0.3.0` candidate adds the bounded Agent tool-calling contract governed by
ADR 0015. The public chat and model APIs, three providers,
streaming, authentication, deterministic routing, fallback, bounded retries,
rate/concurrency coordination, circuit breaking, PostgreSQL migrations,
OpenTelemetry, SDK previews, and Docker/Kubernetes delivery assets are present.

The protected live-provider workflow has passed non-streaming and streaming
requests for OpenAI, Anthropic, and Gemini. Real PostgreSQL and Redis tests,
the empty-install staging deployment, production backup/disposable restore
exercise, and protected staging provider/lifecycle verification have also
passed for the candidate commit. The protected staging observability comparison
passed with zero provider failures and HTTP 5xx responses, active requests
returning to zero, and concurrent-stream memory below the accepted threshold.
The signed multi-architecture image was deployed by digest, reverified on
staging, and published with checksums, SBOM, signature, and provenance.

ADR 0012 establishes RAX Digital as the operator and RAX Compute Gateway as the
neutral platform identity. Source, packages, API extensions, credentials,
telemetry, deployment assets, and SDKs use the new identity. The public
`https://api.rax-digital.com` endpoint, DNS, HTTPS, single-host operations,
backup/restore timers, monitoring, and protected AWS deployment are active. The
validated staging stack is stopped with its volume retained as a temporary
rollback target; the public production stack remains healthy.

## Specification mapping

| Requirement | Implementation status | Remaining evidence or limitation |
| --- | --- | --- |
| Chat completions and SSE | Implemented; contract, client-disconnect, and graceful-shutdown staging tests pass | Re-run lifecycle evidence after stream/runtime changes |
| Agent tools and structured output | Function tools, tool-result messages, streamed tool deltas, per-key permission, and capability-safe routing implemented for the three adapters | Protected live tool smoke and production promotion are required before the `v0.3.0` release |
| OpenAI, Anthropic, Gemini | Implemented; shared conformance and protected live smoke pass | Re-run when provider model/API configuration changes |
| API keys and model permissions | HMAC-backed keys, status/expiry/environment checks, model/stream permissions, conservative input ceilings, and provider output caps implemented | Provider-native tokenizer accounting and detailed cost reporting remain deferred |
| Routing and resilience | Stable weighted primary selection, ordered fallback, bounded retry, deadlines, concurrency and circuit state implemented | Deployment-region and operator-disabled route filtering described in `docs/router.md` has no policy field yet |
| PostgreSQL and Redis | Migration/repository and atomic Redis coordination implementations exist; the protected nightly suite passed against real services | Production remains a deliberate single-host PostgreSQL/Redis deployment until a managed-data-service migration is justified |
| Observability | Structured content-free logs, metrics, traces, build identity and shutdown flushing implemented; protected staging outcome, latency, active-request, and stream-memory evidence passes | No bundled production dashboard; custom routing child spans are not part of `0.1` |
| Docker and Kubernetes | Compose, hardened signed image, Helm chart, two-replica/rolling CI validation, immutable-digest staging deployment, and published `v0.1.0` artifacts pass | Promote the release digest to each operator environment through its controlled deployment process |
| SDKs and OpenAPI | TypeScript/Python clients, generated schemas, lint and compatibility gates implemented | Package registry publication is intentionally disabled for `0.1` |

## Known documentation-to-code gaps

These items require a scoped issue or ADR before behavior changes:

1. `docs/router.md` describes deployment-region filtering and an explicit
   operator-disabled route state. The version 1 policy schema currently has no
   region or enabled/disabled fields; open-circuit filtering happens during
   execution instead of static plan construction.
2. Runtime policy updates are described as atomic in `docs/router.md`, but the
   current process loads one validated policy at startup and does not hot
   reload it.
3. `docs/coding-standards.md` calls for property tests covering weighted
   routing, deadline budgets, and redaction. The current suite has deterministic
   examples and conformance tests for these paths, but no property-test harness.

## Release evidence

The completed first-release evidence, immutable digest, workflow links, and
operator decision are recorded in `docs/releases/0.1.0-rc.md` and the public
[`v0.1.0` release](https://github.com/radium0090/Compute-Gateway/releases/tag/v0.1.0).
Future releases repeat the same signed-tag, artifact, digest-deployment, and
protected-verification sequence rather than reusing this evidence.

## Intentionally deferred work

The `v0.2` operator console, browser authentication, tenant/API-key management,
and durable content-free audit events are implemented under ADR 0013. The
GitHub-authenticated, five-minute evaluation flow implemented under ADR 0014 is
enabled at `https://api.rax-digital.com/demo/`; its production claim-to-response
path was verified on 2026-08-15. General hosted signup/billing, permanent
end-user identity, MFA or federated operator identity, detailed token/cost
accounting, extra provider families, package publication, and additional
data-plane API surfaces remain deferred and require their own scope and
decision review.
