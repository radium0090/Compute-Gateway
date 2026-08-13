# Changelog

All notable changes to RAX Compute Gateway are documented in this file. The project follows
Semantic Versioning and keeps release dates in UTC.

## Unreleased

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
