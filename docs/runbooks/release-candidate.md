# Release-candidate validation

This runbook gathers evidence for an MVP release candidate. Passing it does not
publish or deploy a release; a maintainer still approves and creates the signed
tag described in [CI/CD](../ci-cd.md#release-flow).

## Preconditions

- candidate commit is reviewed and on the protected `main` branch;
- working tree is clean and `origin/main` is current;
- GitHub CI, Security, Container, and Kubernetes workflows are green;
- the `live-provider-smoke` environment has current model names and separately
  managed provider credentials;
- a staging database backup and restore exercise is current.

Never paste secret values into an issue, command transcript, benchmark output,
or release evidence.

## Deterministic gate

On Node.js 24 and pnpm 9, run:

```bash
pnpm install --frozen-lockfile
pnpm release:check
```

This checks formatting, lint, types, coverage, datastore tests, network stream
lifecycle, build output, OpenAPI generation/lint/compatibility, both SDKs, the
stored p95 threshold, documentation, and deployment policy. PostgreSQL/Redis
integration tests require `GENCHI_TEST_DATABASE_URL` and
`GENCHI_TEST_REDIS_URL`; a skipped datastore suite is not release evidence.

## Protected and deployment gates

1. Manually dispatch **Live provider smoke** after environment approval.
2. Confirm non-streaming and streaming calls pass for OpenAI, Anthropic, and
   Gemini without inspecting or recording model output.
3. Confirm **Kubernetes / server-validation** installed two ready replicas,
   returned ready over the Service, and completed its rolling upgrade.
4. Deploy the immutable candidate digest to staging, run empty-install or
   upgrade migrations, then repeat health, model-list, completion, streaming,
   client-disconnect, and graceful-shutdown smoke tests.
5. Compare error rate, p95 gateway overhead, provider outcome counts, active
   requests, and memory per stream with the accepted reference.

## Candidate decision

Record commit SHA, image digest, chart/API/SDK versions, migration versions,
workflow run links, benchmark result, reviewer, and UTC decision time. Any
failed or skipped required gate keeps the candidate blocked. Use the
[rollback runbook](rollback.md) for a failed staging rollout and the
[incident-response runbook](incident-response.md) for suspected exposure.

The first release has no previous-version migration fixture. Before accepting a
second schema migration, preserve the published `0.1` schema as an upgrade
fixture and require an automated upgrade test.
