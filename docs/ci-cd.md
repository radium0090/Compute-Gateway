# CI/CD

## Objectives

CI provides reproducible evidence that code, API, migrations, deployment
artifacts, security controls, and documentation are releasable. CD publishes
immutable artifacts; it does not silently deploy the open-source repository to
an operator's environment.

## Pull request pipeline

Required checks:

1. repository policy, formatting, linting, and type checking;
2. unit tests and repository coverage thresholds;
3. integration tests with PostgreSQL, Redis, and mock providers;
4. adapter conformance and OpenAI SDK compatibility tests;
5. OpenAPI generation, lint, and breaking-change comparison;
6. database empty-install and previous-version upgrade test;
7. Docker build and container smoke test;
8. Helm lint, schema/policy validation, and kind smoke test;
9. documentation links and code samples;
10. secret, dependency, license, and static security scans.

Untrusted fork workflows use no repository secrets and do not run live provider
tests. Expensive nightly jobs are supplemental, never a substitute for core PR
checks.

The deterministic performance check uses a stub provider and is safe for pull
requests. Live-provider tests use the protected `live-provider-smoke`
environment, run only by manual dispatch, and are never part of untrusted pull
request workflows. Until a previous release exists, migration CI verifies empty
installation and idempotency; the first upgrade fixture becomes mandatory
before the next schema migration is accepted.

## Test layers

| Layer | Scope | External dependency |
| --- | --- | --- |
| unit | domain rules, translation, validation | none |
| contract | adapters against fixtures/mock server | local only |
| integration | gateway + PostgreSQL/Redis | ephemeral containers |
| compatibility | OpenAI/Genchi SDK request behavior | local gateway |
| live smoke | minimal real provider request | protected scheduled/manual |
| performance | overhead, streams, resource saturation | isolated environment |

Tests use deterministic clocks/IDs and never assert against live provider text.

## Main branch

Merges to main validate a candidate image and publish test evidence. Main is
protected: pull request, passing required checks, current
review, resolved discussions, and CODEOWNERS approval for sensitive paths.

## Release flow

1. Maintainer opens a release pull request with version and changelog.
2. CI runs the full suite and compatibility matrix.
3. A signed annotated tag triggers artifact build once.
4. The workflow publishes the OCI image, chart, checksums, SBOM, provenance,
   OpenAPI artifact, and GitHub Release notes. SDK publication remains disabled
   until npm and PyPI ownership is verified.
5. A clean environment installs only published artifacts and runs smoke tests.
6. Maintainer promotes the release from pre-release after verification.

Artifacts are never rebuilt for promotion; digest identity is preserved.

## Versioning

Gateway, Helm chart, and SDKs use Semantic Versioning. Before 1.0, minor
versions may include documented breaking changes, but API compatibility checks
still require explicit approval and migration notes. Security releases may be
cut from supported maintenance branches.

## Rollback and revocation

An artifact is not overwritten. Faulty versions are deprecated and a new patch
is released. Compromised packages/images are revoked where registries support
it, advisories identify affected digests, and credentials are rotated.

## Performance gates

Nightly and release-candidate tests measure non-streaming overhead, connection
capacity, memory per stream, cancellation cleanup, and route/fallback behavior.
The loopback stub-provider scenario stores workload and the MVP p95 threshold in
`benchmarks/reference.json`. A failure blocks the candidate, but maintainers
confirm a regression on a second runner before changing code or the threshold.
Threshold changes require performance evidence and review; CI never rewrites
the reference.
