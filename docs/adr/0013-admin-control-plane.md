# ADR 0013: Embedded Administrative Control Plane

- Status: Accepted
- Date: 2026-08-13

## Context

RAX Compute Gateway `v0.1.0` deliberately shipped without a browser dashboard,
operator HTTP API, durable operator audit log, or browser session model. RAX
Digital now needs a small management surface for its hosted service so an
operator can inspect service state, manage tenants, and issue or revoke client
API keys without running SQL or short-lived container commands.

The first hosted deployment is a deliberately low-cost single EC2 host. A
second service, load balancer, or managed identity product would increase cost
and operational work before usage justifies it. At the same time, control-plane
code must not leak into provider adapters or weaken the stable `/v1` data-plane
contract.

## Decision

Add an authenticated administrative control plane in `v0.2.0` under `/admin`
and `/admin/api`. It is composed by `apps/gateway` and runs in the same Node.js
process and OCI image as the data plane for the single-host deployment. Its
domain contracts, application services, cryptography, and PostgreSQL adapters
remain separated by the existing dependency direction. This is a deployment
co-location decision, not permission for HTTP handlers to contain business or
database logic.

The initial control plane supports:

- administrator login, logout, forced first-login password change, and bounded
  server-side sessions;
- service/readiness summary and content-free API-key activity counts;
- tenant creation and listing;
- API-key creation, one-time credential display, listing, and revocation;
- durable content-free audit events for authentication and mutations.

Administrator identities and opaque session records are stored in PostgreSQL.
Passwords are salted and hashed with the Node.js platform `scrypt`
implementation using an OWASP-listed memory-hard parameter set. Session and
CSRF tokens use cryptographically secure random bytes; only keyed hashes are
stored. The browser receives the session identifier only in a host-only,
`Secure`, `HttpOnly`, `SameSite=Strict` cookie. Mutations also require an
origin check and a per-session CSRF token. Login attempts are rate limited and
accounts are temporarily locked after repeated failures. Initial administrators
are created only through a password-on-standard-input operator command and must
change the temporary password after first login.

The control plane is disabled unless explicitly configured. Production startup
requires an HTTPS administrative origin and a dedicated session-hash pepper.
The UI and API never expose provider credentials, password hashes, session
tokens, API-key hashes, prompts, completions, or raw provider responses. A newly
created API key is returned once and is not recoverable afterward, preserving
ADR 0005. Dashboard activity is derived from bounded metadata such as
`last_used_at`; ADR 0009 continues to prohibit content persistence.

The administrative API is versioned independently from the OpenAI-compatible
`/v1` data-plane API and is not included in generated client SDKs in `v0.2.0`.
Running it as a separate process, adding federated identity or MFA, exposing
hosted signup, and adding billing remain future decisions.

## Consequences

- The current hosted service gains a usable control plane without another
  billable runtime component.
- A gateway-process failure also makes the control plane unavailable, and
  expensive administrative work shares one event loop. Administrative routes
  therefore use small bounded payloads, slow password work runs asynchronously,
  and the data plane remains independently testable.
- PostgreSQL becomes the authoritative administrator, session, and audit store;
  migrations remain backward compatible with `v0.1.0`.
- Public exposure of `/admin` increases the security surface and requires TLS,
  strict response headers, login throttling, session expiry, CSRF enforcement,
  secret-safe tests, and protected deployment verification.
- The UI is intentionally small and framework-free. A future richer console can
  replace it without changing domain or persistence ports.

## Rejected alternatives

- **A second admin service immediately:** gives stronger runtime isolation but
  adds image, health, deployment, and capacity complexity without reducing the
  current single-host failure domain.
- **Database administration or the existing master key in a browser:** exposes
  excessive privilege and creates unsafe secret handling.
- **Stateless signed browser tokens:** makes immediate revocation, forced logout,
  and bounded server-side session control harder.
- **Store plaintext API keys for later display:** violates ADR 0005 and expands
  breach impact.
- **Persist request content for analytics:** violates ADR 0009 and is unnecessary
  for the initial operational dashboard.
