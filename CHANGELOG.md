# Changelog

All notable changes to RAX Compute Gateway are documented in this file. The project follows
Semantic Versioning and keeps release dates in UTC.

## Unreleased

## 0.3.0 - 2026-08-25

### Added

- Bounded OpenAI-compatible function tools, tool choice, assistant tool calls,
  tool-result messages, and streamed indexed tool-call deltas.
- Provider-neutral tool translation for OpenAI, Anthropic, and Gemini.
- `text`, `json_object`, and `json_schema` response-format negotiation through
  explicit model capabilities.
- The capability-safe `rax/agent` alias, per-key Agent tool permission in the
  operator console, protected live-provider tool smoke, and Agent integration
  documentation.

### Security

- Tool definitions, arguments, results, and structured output remain
  non-persistent content and are excluded from logs and telemetry.
- Tool permission remains deny-by-default, and streamed requests never retry or
  fall back after the first tool/text delta is committed.

## 0.2.0 - 2026-08-15

### Added

- A compact, responsive operator console at `/admin/` for service health,
  tenant management, and API Key creation, listing, and revocation.
- PostgreSQL administrator identities, bounded server-side sessions, and
  content-free operator audit events through backward-compatible migration
  `0002`.
- Salted memory-hard administrator password hashing, forced temporary-password
  replacement, account lockout, anonymous login throttling, exact-origin and
  per-session CSRF checks, and hardened host-only cookies.
- An `admins create` operator command that reads the temporary password only
  from standard input.
- A one-command Docker quickstart that generates local gateway secrets,
  provisions a client key, and sends the first provider request.
- An optional GitHub-authenticated `/demo` flow that issues a unique,
  five-minute, tightly scoped API key and ready-to-run `curl` without persisting
  OAuth tokens or plaintext credentials.
- PostgreSQL OAuth-state and pseudonymous claim-ledger tables through migration
  `0003`, with transactional per-account cooldown and global daily claim caps.

### Changed

- API-key request ceilings now use a conservative tokenizer-independent input
  bound, and output ceilings are capped before provider dispatch.
- The low-cost AWS single-host production deployment enables the embedded
  administrative control plane without adding another runtime service.

## 0.1.0 - 2026-08-13

### Changed

- Renamed the platform to RAX Compute Gateway under RAX Digital ownership,
  separating the neutral product identity from customer tenant names.

### Added

- OpenAI-compatible chat completions, streaming, and model listing.
- OpenAI, Anthropic, and Gemini provider adapters with shared conformance tests.
- Deterministic aliases, fallback, bounded retries, deadlines, concurrency
  limits, and circuit state.
- Hashed RAX Compute Gateway API keys, model permissions, and operator key commands.
- PostgreSQL metadata persistence and optional Redis coordination.
- OpenTelemetry metrics, traces, and structured redacted logging.
- Docker Compose, hardened OCI image, Kubernetes manifests, and Helm chart.
- Preview TypeScript and Python SDKs generated from the OpenAPI contract.
- Repeatable release-candidate, security, compatibility, and performance gates.
- An isolated fresh-clone Compose bootstrap smoke test.

### Fixed

- Request deadline, readiness, and client-disconnect handling.
- PostgreSQL API-key round trips and last-used timestamp updates.
- Non-root Kubernetes dependency startup and release-candidate validation.
- Quickstart command sequencing, client-key capture, and release documentation.
- Runtime documentation and configuration that overstated planned cache,
  database, and audit capabilities.
- Admission and active-request metric labels that could mislead operators.
- Runtime and TypeScript SDK packages containing compiled tests or TypeScript
  incremental-build metadata.
