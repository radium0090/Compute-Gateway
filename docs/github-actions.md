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
| `release.yml` | signed `v*` tag | publish signed release artifacts |

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
