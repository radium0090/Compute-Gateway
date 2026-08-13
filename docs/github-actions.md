# GitHub Actions

## Workflow map

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `ci.yml` | pull request, main push | format, lint, types, coverage, contracts, PostgreSQL/Redis integration |
| `security.yml` | PR, main, schedule | CodeQL, secrets, dependency/license/IaC scans |
| `container.yml` | PR, main | image build, scan, smoke test |
| `kubernetes.yml` | PR, main | Helm and kind verification |
| `nightly.yml` | schedule/manual | full deterministic and datastore integration suites |
| `live-provider.yml` | manual | protected OpenAI/Anthropic/Gemini smoke through OpenAI SDK |
| `aws-staging.yml` | manual | protected AWS OIDC, EC2, and SSM connectivity evidence |
| `aws-staging-bootstrap.yml` | manual | approved, idempotent staging host prerequisite installation |
| `aws-staging-deploy.yml` | manual | approved deployment of the exact protected `main` commit |
| `aws-staging-verify.yml` | manual | approved real-provider, streaming, disconnect, and restart verification |
| `release.yml` | signed `v*` tag | publish signed artifacts and create a draft release |

The CI workflow also verifies both SDK previews, OpenAPI compatibility, network
stream cancellation, and the stored p95 performance threshold. SDK publication
is deliberately not enabled until registry ownership is verified.

## Security defaults

Every workflow starts with:

```yaml
permissions:
  contents: read
```

Jobs add only required scopes. Third-party actions are pinned to full commit
SHAs with a comment naming the reviewed version. Workflows use `pull_request`,
not `pull_request_target`, for untrusted code. Secrets are available only to
protected environment jobs after approval.

## Reproducibility and caching

- Setup uses the repository's pinned Node and pnpm versions.
- Install uses `pnpm install --frozen-lockfile`.
- Cache keys include OS, architecture, runtime, and lockfile hash.
- Build artifacts passed between jobs have short retention and checksums.
- Service containers use pinned major/minor image versions or digests.
- Concurrency cancels stale PR runs but never an active release.

## Example job skeleton

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<full-reviewed-sha>
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@<full-reviewed-sha>
      - uses: actions/setup-node@<full-reviewed-sha>
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:coverage
```

Placeholders MUST be replaced with reviewed SHAs before merging.

## Release identity

Release workflows verify that the tag commit is on the protected branch, the
version matches manifests, generated files are current, and the tag is signed
according to project policy. GitHub OIDC is preferred over long-lived cloud or
registry credentials. Artifact attestations include source commit and workflow.

## Dependabot

Dependabot groups development-package and GitHub Actions updates and separately
tracks Docker and npm ecosystems. Lockfile/workflow changes receive CODEOWNERS
review. Automated dependency pull requests run the same test suite and are not
auto-merged initially.

## Operational rules

Workflow logs are public for a public repository; commands must not print
environment variables or configuration. Failed release jobs are resumable only
when doing so cannot overwrite an already published version. All jobs have
timeouts and artifact retention limits.

The `live-provider-smoke` environment must require maintainer approval. It holds
the three provider secrets and non-secret current model names. Its workflow
checks only that values are non-empty, never prints them, caps each request at
eight output tokens, and cannot run on pull requests.

The `aws-staging` environment is restricted to `main` and requires maintainer
approval. It stores only non-secret resource identifiers as environment
variables. GitHub obtains short-lived AWS credentials through OIDC; long-lived
AWS access keys and SSH private keys are not stored in GitHub. The connectivity
job can send the approved read-only probe only to the configured staging
instance through Systems Manager. The EC2 instance role, not the GitHub role,
is responsible for reading the staging runtime secret.

The separate bootstrap workflow is also protected by `aws-staging`. It installs
Docker Engine, the Compose plugin, Git, `jq`, and AWS CLI v2 through SSM, then
uses the EC2 instance role to validate that the configured Secrets Manager value
is a JSON object. Bootstrap output contains package versions and sorted secret
field names only; secret values never leave the instance. Re-running bootstrap
is supported and does not deploy the application or remove persistent data.

The deployment workflow checks out the exact approved `main` commit into a
commit-addressed release directory on the instance. The instance materializes a
mode-`0600` Compose environment from Secrets Manager, builds the gateway with
the commit as image metadata, applies forward-only migrations, starts the
single-host staging stack, and runs live/readiness plus temporary API Key
authentication checks. The PostgreSQL volume is preserved between deployments;
the `current` symlink changes only after every deployment check passes.

The verification workflow runs separately against the current validated
deployment. It creates a disposable staging API Key, exercises non-streaming
and streaming requests through the OpenAI, Anthropic, and Gemini aliases,
checks recovery after a client disconnect, and restarts the gateway with
`SIGTERM` to verify graceful shutdown and post-restart authentication. It
deletes the temporary API Key at exit. Public workflow output contains only
named pass/fail markers; provider credentials, the temporary key, prompts, and
model responses remain on the instance.
