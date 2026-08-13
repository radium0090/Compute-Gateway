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
ghcr.io/radium0090/compute-gateway:v0.1.0@sha256:<digest>
```

The `release.yml` workflow accepts an annotated signed `v*.*.*` tag whose
commit is on `main` and whose version matches the chart `appVersion`. It refuses
an existing registry tag, publishes a multi-architecture image and chart,
generates checksums and SPDX SBOMs, and attaches keyless image signature and
provenance. It creates a draft GitHub Release so the published digest can be
verified before the release becomes public. Environment deployment and final
release publication remain operator-controlled actions.

## Deployment sequence

1. Read release notes and schema compatibility requirements.
2. Back up the database and verify recent restore evidence.
3. Run the migration job with the release migration image/command.
4. Validate configuration with `rax-compute-gateway --check-config`.
5. Deploy a canary with no more than 5% of traffic.
6. Compare error rate, gateway latency, provider outcomes, and resource use.
7. Roll out with readiness gates and `maxUnavailable: 0` where capacity allows.
8. Run API and streaming smoke tests.
9. Record release, configuration version, image digest, and migration version.

## AWS single-host staging

The protected `AWS staging deploy` workflow is the supported rehearsal path for
the project staging EC2 instance. It deploys the exact `main` commit through
OIDC and Systems Manager without SSH. Runtime secret values are read only by the
EC2 role and written to `/opt/rax-compute-gateway/shared/staging.env` with mode `0600`.
Commit-addressed checkouts live below `/opt/rax-compute-gateway/releases`, while
`/opt/rax-compute-gateway/current` identifies the last fully validated deployment.

This mode is for staging and single-host evaluation. It binds the gateway and
datastores to loopback and is not the production topology described above.

After deployment, run the protected `AWS staging verify` workflow. It verifies
all three provider aliases in normal and streaming modes, cancellation recovery,
graceful gateway restart, and API Key authentication after restart. The workflow
uses a disposable key and reports only status markers. A successful deployment
does not substitute for this provider and lifecycle verification.

For release-candidate promotion, dispatch `AWS staging deploy` from `main` with
the published `sha256:...` digest. The workflow derives the semantic image tag
from the chart, pulls that exact immutable GHCR reference instead of rebuilding
it, and records both the digest reference and local image ID. Leave the digest
input empty for the normal commit-built staging rehearsal.

## AWS single-host production edge

The protected `AWS production deploy` workflow supports the deliberately
low-cost, single-host deployment at `api.rax-digital.com`. It deploys through
GitHub OIDC and Systems Manager without SSH, starts an independently named
production Compose project, and places Caddy in front of the gateway. Caddy
terminates TLS, renews the public certificate automatically, preserves streamed
responses, and keeps `/metrics` off the public route. PostgreSQL, Redis, the
Collector, and the gateway publish no host ports in this mode.

Required AWS/GitHub controls:

- a protected `aws-production` GitHub environment restricted to `main`;
- a production-only Secrets Manager secret below
  `rax/compute-gateway/production/runtime-*`;
- environment variables for the AWS role/instance, deployment path, secret ARN,
  public hostname, and private backup bucket;
- an Elastic IP associated with the EC2 instance and an `A` record for the
  public hostname;
- inbound TCP 80/443 only, with administration through Systems Manager.

This is an availability and cost tradeoff, not the multi-replica production
topology above. The EC2 instance, Docker daemon, and local PostgreSQL volume are
single points of failure. The repository automates encrypted six-hourly database
backups, weekly disposable restore verification, and five-minute readiness and
disk metrics. The monitor also reports the age of the latest successful restore
verification so weekly evidence can be alarmed without sparse-metric false
positives. Operators still need tested whole-instance recovery, host security
updates, and an external notification recipient. See the
`aws-single-host-recovery` runbook for evidence and recovery commands.

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
