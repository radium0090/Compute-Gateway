# Architecture Decision Records

ADRs record decisions that materially constrain Genchi architecture or public
behavior. Accepted ADRs are normative and take precedence over general design
documents.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-typescript-node-runtime.md) | TypeScript and Node.js gateway runtime | Accepted |
| [0002](0002-openai-compatible-api.md) | OpenAI-compatible public API | Accepted |
| [0003](0003-canonical-provider-adapters.md) | Canonical domain and provider adapters | Accepted |
| [0004](0004-deterministic-policy-routing.md) | Deterministic policy routing | Accepted |
| [0005](0005-api-key-and-byok-auth.md) | Genchi keys and centrally managed BYOK | Accepted |
| [0006](0006-postgres-and-optional-redis.md) | PostgreSQL plus optional Redis | Accepted |
| [0007](0007-opentelemetry-observability.md) | OpenTelemetry-first observability | Accepted |
| [0008](0008-stateless-oci-kubernetes-deployment.md) | Stateless OCI/Kubernetes deployment | Accepted |
| [0009](0009-no-content-persistence-by-default.md) | No content persistence by default | Accepted |
| [0010](0010-apache-2-license.md) | Apache-2.0 licensing intent | Accepted |

## Format and lifecycle

Each record contains status, date, context, decision, consequences, and rejected
alternatives. Status is one of Proposed, Accepted, Deprecated, or Superseded.
Accepted records are immutable except for typo/link corrections. Change a
decision by adding a new ADR and marking the old one Superseded with a link.

New ADR filenames use the next four-digit number and a short kebab-case title.
Pull requests include implementation and documentation links once available.

