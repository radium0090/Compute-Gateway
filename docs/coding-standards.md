# Coding Standards

## Language baseline

Use TypeScript in strict mode targeting Node.js 22. Avoid `any`; use `unknown`
at trust boundaries and narrow it through schemas. Public functions, exported
types, and domain decisions require concise documentation.

## Design rules

- Keep domain logic free from web framework, database, telemetry, and provider
  SDK types.
- Parse and validate once at trust boundaries.
- Make illegal states hard to represent with tagged unions and branded IDs.
- Pass clock, ID generator, and external clients as dependencies.
- Use explicit result/error types for expected failures; reserve thrown errors
  for programmer or infrastructure failures as defined by the package contract.
- Avoid global mutable state and hidden environment reads outside config.
- Keep retries, timeouts, and logging out of individual handlers.
- Prefer small modules and composition over inheritance.

## Async and resources

Every provider call accepts an `AbortSignal`. Promise rejections are handled.
Streams close upstream resources on completion, error, timeout, shutdown, and
client disconnect. Background queues are bounded and expose dropped-work
metrics. No fire-and-forget work without lifecycle ownership.

## Errors and logging

Internal errors carry stable machine codes, safe public messages, causal error,
and retry classification. Never build client messages from raw provider or
database errors. Use the structured logger and approved fields; `console.log`
is prohibited in runtime packages.

## Testing

- Unit tests use behavior names and assert outputs, not private implementation.
- Property tests cover weighted routing, deadline budgets, and redaction.
- Integration tests use isolated databases and mock provider servers.
- Every bug fix adds a test that fails before the fix.
- Tests cannot depend on order, wall-clock timing, public network, or developer
  credentials unless explicitly tagged as live tests.
- Snapshots are acceptable for stable schemas/fixtures, not opaque large output.

## Formatting and linting

The repository pins formatter and linter versions. Formatting is automatic and
not debated in review. Lint rules enforce dependency direction, no floating
promises, exhaustive tagged-union checks, secure random APIs, and no secret
field names in telemetry.

## SQL and migrations

Use parameterized SQL and explicit selected columns. Transactions are short and
do not wrap provider calls. Migrations are immutable after merge, safe for
rolling deployment, and tested from empty/previous schemas.

## Documentation

Public behavior changes update Markdown, examples, OpenAPI, changelog, and ADRs
in the same pull request. Code samples are executable in CI where practical.
Use inclusive, precise language and avoid claims not enforced by tests.

## Commit and pull request conventions

Use focused commits with imperative summaries. Conventional Commit prefixes are
recommended (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `security`). A
pull request explains the problem, approach, contract/security/migration impact,
tests, and rollback. Generated changes are committed separately when helpful.

## Review checklist

Reviewers verify public compatibility, tenant isolation, secret/content safety,
deadline/cancellation paths, resource bounds, telemetry cardinality, database
rollout, tests, and documentation—not only the happy path.

