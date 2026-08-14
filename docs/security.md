# Security

## Security objectives

Protect credentials and model content, prevent cross-tenant access, constrain
provider/network abuse, preserve auditability, and minimize data retained by
the gateway.

## Trust boundaries

```text
Untrusted client | ingress | RAX Compute Gateway | PostgreSQL/Redis | external providers
```

Client input, forwarded headers, model names, and provider responses are
untrusted. Provider APIs are external data processors and may have different
retention policies.

## Threat baseline

| Threat | Primary controls |
| --- | --- |
| stolen RAX Compute Gateway key | high entropy, one-way hash, expiration, scope, rate limit, rotation |
| provider key disclosure | secret manager, redaction, no client exposure, restricted egress |
| SSRF through base URL | operator-only configuration, HTTPS, allowlist/egress policy |
| prompt leakage in telemetry | content-free schema, automated redaction tests |
| tenant/model privilege bypass | deny-by-default policy and integration tests |
| denial of service | body/token limits, timeouts, concurrency/rate limits, backpressure |
| dependency compromise | lockfile, review, scanning, SBOM, signed artifacts |
| malicious provider payload | schema validation, size limits, safe parsing, no evaluation |
| forwarded-header spoofing | forwarded-header trust disabled in production |
| timing/key enumeration | constant-time verification and uniform auth failures |
| public-demo cost abuse | GitHub identity proof, account age/cooldown, global budget, five-minute scoped keys, provider spend alarms |

## Data handling

Message content exists in memory only for request execution and is not persisted
by default. Normal logs, traces, and metrics exclude content. Future usage,
audit, and tool-call support must preserve this rule. Crash dumps and heap
snapshots are disabled in production unless a controlled incident procedure
protects and deletes them.

Operators MUST document provider-side data processing and configure provider
retention controls separately. Self-hosting RAX Compute Gateway does not eliminate provider
data transfer.

## Input and output safety

- Validate request and provider response structures and maximum sizes.
- Bound message count, string length, and SSE frame size.
- Avoid dynamic code evaluation and shell execution.
- Serialize JSON with standard libraries.
- Treat model output as untrusted; RAX Compute Gateway does not claim to sanitize it for an
  application's HTML, SQL, shell, or tool environment.
- Do not follow provider-supplied URLs.

## Cryptography and transport

Use maintained platform cryptography. TLS 1.2+ is required on public and
untrusted internal links. API key hashing uses HMAC-SHA-256 with a separately
managed high-entropy pepper. No custom encryption schemes are permitted.

The hosted-demo identity HMAC uses a separate pepper and purpose-separated
messages from API-key and administrator-session hashing. OAuth uses state,
PKCE, an exact callback URI, short-lived Secure/HttpOnly cookies, and a
no-scope GitHub app. OAuth tokens and plaintext trial keys are never persisted.

## Vulnerability management

Publish `SECURITY.md` with a private reporting channel, supported versions, and
response expectations before public release. Do not request zero-day details in
public Issues. Triage severity using exploitability and data exposure, patch
supported branches, rotate affected secrets, publish an advisory, and credit
reporters when permitted.

## Supply chain

- Pin GitHub Actions to full commit SHAs.
- Use least-privilege workflow permissions and protected environments.
- Prevent secrets from running in forked pull requests.
- Generate SBOM and provenance for release artifacts.
- Scan dependencies, image layers, licenses, and repository secrets.
- Require review for lockfile, workflows, auth, routing, and release changes.

## Security release gate

Before v1.0, complete threat-model review, authz matrix tests, secret scanning,
fuzz/property tests for parsers and routing, dependency/image scans, external
penetration testing or equivalent independent review, and an incident-response
exercise.
