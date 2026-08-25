# Authentication and Authorization

## Two credential layers

1. **RAX Compute Gateway API keys** authenticate applications to the gateway.
2. **Provider credentials** authenticate the gateway to model providers.

They are never interchangeable. Clients never receive provider credentials.

## RAX Compute Gateway API keys

Keys use this form:

```text
rcg_<environment>_<public-id>_<secret>
```

Only the public ID is searchable. The secret contains at least 256 bits of
cryptographically random entropy. The full key is shown once at creation.

Database storage includes:

- public ID and human-readable name;
- keyed hash of the full credential using a server-side pepper;
- tenant ID, environment, status, creation and expiration times;
- allowed model patterns and rate/concurrency policy;
- last-used timestamp updated asynchronously at coarse resolution.

The key hash uses HMAC-SHA-256 with `RCG_KEY_HASH_PEPPER`. Verification is
constant-time. The pepper comes from a secret manager and is not stored in the
database. Key values MUST NOT be logged, traced, or placed in URLs.

## Request authentication

```http
Authorization: Bearer rcg_prod_...
```

Missing or invalid credentials return the same 401 shape to prevent key
enumeration. Disabled, revoked, expired, or wrong-environment keys are invalid.
Successful verification updates `last_used_at` at coarse resolution without
blocking authentication when that metadata-only update fails.

## Authorization

Authorization is deny-by-default. A key policy can allow:

- public aliases or qualified models;
- streaming;
- Agent function tools (disabled unless explicitly granted);
- requests per minute and concurrent requests;
- maximum request/output tokens where enforceable.

The application enforces `maxRequestTokens` with a tokenizer-independent,
conservative UTF-8 upper bound before admission or routing. This can reject
some valid prompts earlier than a provider tokenizer would, but cannot silently
expand the configured cost boundary. `maxOutputTokens` is always forwarded as
the lower of the caller request and key policy; when omitted by the caller, the
key ceiling is supplied to the provider.

Authentication success does not imply access to every configured model.
`GET /v1/models` returns only authorized models.

## Provider credentials

MVP provider credentials are referenced by environment variable or mounted
secret file. Configuration stores only a logical credential reference.

- Different environments use different provider credentials.
- A credential can be bound to specific provider/model routes.
- Rotation supports an overlap window with two references when the provider
  permits it.
- Provider keys MUST NOT be accepted in public request headers or bodies.

Future encrypted database storage requires a separate ADR and external KMS.

## Bootstrap and rotation

The release includes an operator CLI:

```bash
rax-compute-gateway keys create --tenant-id 123e4567-e89b-42d3-a456-426614174000 \
  --name local-agent --environment dev --models 'rax/*' \
  --allow-streaming --allow-tools
rax-compute-gateway keys revoke --id 223e4567-e89b-42d3-a456-426614174000
```

Key commands require `RCG_MASTER_KEY`, direct PostgreSQL connectivity, an
applied schema, and an existing tenant UUID. The master key is only an operator
command gate; it is never sent to PostgreSQL or the public HTTP service. In
production, execute the command as a short-lived approved job and remove the
master key from normal gateway pods after bootstrap. The CLI never accepts a
plaintext credential for storage.

The CLI prints a new key exactly once. Rotation means create, deploy to client,
verify traffic, then revoke the old key. Revocation is enforced by the next
database-backed authentication attempt.

## Network controls

Production deployments SHOULD terminate TLS at a trusted ingress and use TLS to
the gateway where the network is not trusted. `/metrics` and future operator
endpoints MUST be private or separately authenticated. Forwarded headers are
trusted only from configured proxies.

## Administrator sessions

The optional `v0.2` operator console uses separate administrator identities;
gateway API keys and the master key can never log in to the browser. Passwords
are stored as salted `scrypt` hashes. Opaque session and CSRF values are shown
only to the browser and stored in PostgreSQL as keyed hashes using the dedicated
`RCG_ADMIN_SESSION_PEPPER`.

The session cookie is host-only, `Secure`, `HttpOnly`, and `SameSite=Strict`.
Every mutation also verifies the exact `RCG_ADMIN_ORIGIN` and a per-session CSRF
header. Sessions expire after the configured bounded lifetime, repeated login
failures cause temporary account lockout, and anonymous password work is rate
limited. Initial administrators are created with `admins create` using a
temporary password supplied on standard input and must change it after login.

## Hosted demo identity

The optional `/demo` surface uses a dedicated no-scope GitHub OAuth App only to
prove a stable account identity and minimum account age. It is not accepted on
`/v1`, does not create a permanent user account, and does not grant access to
the operator console. OAuth state is one-time and PKCE-bound. GitHub access
tokens are discarded after `/user`; only a domain-separated HMAC pseudonym is
retained for cooldown enforcement. See [hosted demo](demo.md) and ADR 0014.

## Audit integration

The `0.1` gateway emits content-free structured request and routing telemetry.
Durable operator audit events are planned for the hardening phase; production
operators should record short-lived key jobs and configuration changes in their
deployment audit system meanwhile.
