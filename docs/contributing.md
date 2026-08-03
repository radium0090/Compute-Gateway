# Contributing

Thank you for helping build Genchi. Contributions are welcome as issues,
documentation, tests, provider adapters, fixes, and focused features.

## Before coding

For small fixes, open a pull request directly. For public API changes, routing
semantics, new persistent data, provider abstraction changes, or large features,
open a design discussion first and write an ADR when requested. Security issues
must follow the private process in `SECURITY.md`, not a public issue.

## Development setup

Prerequisites: Node.js 24, pnpm 9, Docker 26+, and Git.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres redis otel-collector
pnpm migrate
pnpm dev
```

Use fake/local provider configuration or mock servers for normal development.
Real provider credentials are optional and must never be committed.

## Checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm test:integration
pnpm openapi:check
pnpm docs:check
pnpm operations:check
pnpm build
```

Integration tests skip unless `GENCHI_TEST_DATABASE_URL` and/or
`GENCHI_TEST_REDIS_URL` are set. Container and kind checks run in CI and should
also be run locally when those tools are available and their assets change.

## Pull requests

A pull request should:

- solve one coherent problem and link its issue/design;
- include tests for success and failure paths;
- update API/docs/configuration/migrations as needed;
- disclose security, privacy, compatibility, and performance impact;
- avoid unrelated formatting or dependency changes;
- pass all required checks and address review comments;
- include a release-note entry for user-visible changes.

Maintainers may ask to split changes. Approval is not guaranteed merely because
an implementation works; long-term contract and maintenance cost matter.

## Provider contributions

New adapters must pass the shared conformance suite, document supported
capabilities and provider data behavior, use cancellation, normalize errors, and
avoid modifying common API handlers. Live credentials are never required for
reviewing an untrusted contribution.

## Sign-off and conduct

Contributors certify they have the right to submit the work under Apache-2.0 by
adding a Developer Certificate of Origin sign-off:

```text
Signed-off-by: Name <email@example.com>
```

All participation follows the repository `CODE_OF_CONDUCT.md`. Be specific,
respectful, and assume good intent while reviewing technical claims critically.

## AI-assisted contributions

AI assistance is allowed, but the human contributor remains responsible for
license provenance, correctness, tests, security, and understanding the code.
Do not submit secrets, proprietary source, or unreviewed bulk-generated changes.
