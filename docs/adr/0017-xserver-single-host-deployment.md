# ADR 0017: XServer Single-Host Deployment

- Status: Accepted
- Date: 2026-11-19

## Context

The first hosted deployment was validated on AWS, but its fixed operating cost
is disproportionate to current traffic. RAX Digital needs an inexpensive
always-on Japanese deployment that preserves the existing OCI image, Docker
Compose workflow, PostgreSQL system of record, Redis coordination, TLS, and
release auditability.

XServer VPS provides a fixed-price Ubuntu host with sufficient CPU, memory,
NVMe storage, and public networking for the current single-node workload. The
deployment must not turn host-specific behavior into application logic or
remove the portable Kubernetes and AWS assets used by self-hosters.

## Decision

Add an XServer production profile for a single Ubuntu 24.04 VPS with at least
4 GiB memory. Run Caddy, one gateway container, PostgreSQL 16, Redis 7, and the
OpenTelemetry Collector through Docker Compose. PostgreSQL and Caddy use named
volumes; Redis stores coordination state only and remains disposable. The
gateway continues to use the same immutable non-root OCI image and migration
command used by other deployment targets.

Expose only TCP 80 and 443 publicly. SSH uses key authentication, a dedicated
deployment account, disabled password login, and host firewall rules. Database,
Redis, metrics, and gateway container ports remain on the private Compose
network. Caddy terminates TLS for the configured public host. Cloudflare may be
used for DNS, WAF, and edge rate limiting, but it is not required for gateway
correctness.

GitHub Actions deploys an explicitly selected immutable release image through a
protected environment. XServer connection values and the deployment SSH key
remain GitHub environment secrets; the pinned SSH host key is a non-secret
environment variable. Runtime/provider secrets live only in a root-readable
host environment file and are never copied into the repository, workflow log,
or container image.

Deployment uploads only versioned operational assets, pulls the requested
image, runs migrations as a one-shot container, starts the stack, and verifies
liveness/readiness over HTTPS. The previously running image reference is kept
for rollback. A failed migration or readiness check stops promotion and does
not delete existing volumes.

The initial backup policy may remain minimal while the service contains no
material customer data, but the repository still provides a local PostgreSQL
dump command and restore instructions. Before storing paid-customer identity,
inquiry, or billing data, the operator must enable encrypted off-host backups
and verify a restore.

AWS, Helm, and generic Compose assets remain supported deployment options. This
ADR adds a low-cost production target; it does not supersede the stateless OCI
or external-state decisions in ADR 0008.

## Consequences

- The hosted service can remain continuously available at a predictable low
  fixed cost while reusing existing images and application behavior.
- Gateway, PostgreSQL, Redis, site, and console share one failure domain and do
  not provide a high-availability SLA.
- Host administration, operating-system updates, disk monitoring, and restore
  readiness become RAX Digital responsibilities.
- Scaling later requires moving durable state off-host or adding a replication
  and failover design; no application rewrite is required.

## Rejected alternatives

- **Retain the oversized AWS instance:** preserves existing automation but does
  not meet the current cost objective.
- **Rewrite for a provider-specific serverless database/runtime:** changes
  PostgreSQL, Redis, streaming, and deployment semantics unnecessarily.
- **Expose PostgreSQL or Redis publicly:** creates an avoidable credential and
  network attack surface.
- **Deploy mutable image tags:** prevents reliable rollback and provenance
  verification.
