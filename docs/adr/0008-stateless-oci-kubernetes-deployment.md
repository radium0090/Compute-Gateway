# ADR 0008: Stateless OCI and Kubernetes Deployment

- Status: Accepted
- Date: 2026-08-03

## Context

The gateway needs repeatable self-hosting, horizontal scaling, graceful stream
handling, and portable release artifacts. Local evaluation must also be simple.

## Decision

Publish a non-root OCI image. Keep gateway replicas stateless and externalize
durable/coordination state. Support Docker Compose for evaluation and Helm on
Kubernetes for production. Publish immutable semantic tags and digests.

## Consequences

- Replicas can scale and roll independently when schema/config are compatible.
- Operators must supply production PostgreSQL, Redis when required, secrets,
  ingress, and telemetry infrastructure.
- Streaming deadlines and termination grace must be aligned at every network
  layer.
- Serverless platforms are not guaranteed in the MVP.

## Alternatives rejected

- **Embedded database in the gateway image:** prevents safe scaling and durable
  upgrades.
- **Kubernetes-only:** too heavy for local evaluation.
- **Mutable `latest` deployments:** not auditable or safely rollable.
- **Hosted-only product:** conflicts with the open-source self-hosting goal.

