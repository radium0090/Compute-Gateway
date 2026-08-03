# Deployment

## Supported modes

| Mode | Intended use | Components |
| --- | --- | --- |
| local process | contributor iteration | gateway + local PostgreSQL |
| Docker Compose | evaluation/single host | gateway, PostgreSQL, Redis, Collector |
| Kubernetes | production | replicas, managed PostgreSQL/Redis, ingress, telemetry |

Serverless runtimes with hard streaming limits or unstable outbound connection
behavior are not an MVP support target.

## Production topology

Deploy at least two gateway replicas across failure domains behind an ingress or
load balancer. Use managed PostgreSQL with backups and optional managed Redis.
Send OTLP to a Collector rather than directly to a vendor. Restrict provider
egress and keep operator endpoints off the public route.

## Release artifact

Each release publishes a multi-architecture OCI image by immutable semantic tag
and digest. Images run as a non-root UID, have a read-only root filesystem, and
contain no shell, source map with secrets, build tools, or provider keys.

Deploy by digest in production:

```text
ghcr.io/<owner>/genchi:v0.1.0@sha256:<digest>
```

The `release.yml` workflow accepts an annotated signed `v*.*.*` tag whose
commit is on `main` and whose version matches the chart `appVersion`. It refuses
an existing registry tag, publishes a multi-architecture image and chart,
generates checksums and SPDX SBOMs, and attaches keyless image signature and
provenance. It publishes artifacts only; environment deployment remains an
operator-controlled action.

## Deployment sequence

1. Read release notes and schema compatibility requirements.
2. Back up the database and verify recent restore evidence.
3. Run the migration job with the release migration image/command.
4. Validate configuration with `genchi --check-config`.
5. Deploy a canary with no more than 5% of traffic.
6. Compare error rate, gateway latency, provider outcomes, and resource use.
7. Roll out with readiness gates and `maxUnavailable: 0` where capacity allows.
8. Run API and streaming smoke tests.
9. Record release, configuration version, image digest, and migration version.

## Health semantics

- `/health/live` returns success when the event loop/process can serve; it does
  not query dependencies.
- `/health/ready` checks validated configuration, database connectivity, and
  mandatory coordination dependencies with short timeouts.
- Provider reachability is reflected in route health and metrics, not global
  readiness; one failed provider must not remove healthy routes.

Health responses reveal only status and generic reason codes.

## Capacity

Size gateway replicas primarily by concurrent streaming connections, outbound
sockets, memory per request, and telemetry volume. Set explicit CPU/memory
requests and limits, keep HTTP connection pools bounded, and load test using
realistic stream duration. Autoscaling SHOULD use CPU plus active requests or
event-loop lag, not CPU alone.

## Rollback

Application rollback is permitted only while the database schema remains
backward-compatible. If a canary exceeds error or latency thresholds, stop the
rollout and restore the prior image/configuration. Never automatically reverse
a destructive data migration. Provider alias rollback is a separately audited
configuration publication.

## Environments

Development, staging, and production use separate databases, API key prefixes,
provider credentials, and telemetry destinations. Staging mirrors production
topology without using production user traffic or secrets.
