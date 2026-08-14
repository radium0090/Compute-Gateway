# ADR 0014: GitHub-Authenticated Ephemeral Demo Claims

- Status: Accepted
- Date: 2026-08-14

## Context

RAX Compute Gateway is self-hostable, but evaluating a fresh deployment still
requires Docker, an upstream provider credential, database bootstrap, and a
client API key. RAX Digital also wants an optional hosted evaluation path that
lets a developer obtain one successful response in about sixty seconds without
publishing a shared credential.

A shared key in documentation would be copied by crawlers, would not provide an
individual five-minute lifetime, and could expose provider spend to unbounded
abuse. An anonymous claim endpoint protected only by an IP address is also a
weak control behind proxies and can be bypassed with distributed clients. The
MVP specification excluded hosted signup and end-user OAuth, so this optional
post-MVP behavior requires an explicit decision.

## Decision

Add a disabled-by-default hosted demo surface under `/demo`. When enabled, it
uses GitHub OAuth only to establish a developer identity for trial eligibility.
It requests no email or repository scopes, discards the GitHub access token
immediately after reading the numeric account ID and creation time, and stores
only a domain-separated HMAC of that ID.

Each successful claim creates a new RAX Compute Gateway API key through the
existing provisioning path. The plaintext key is displayed once, expires no
later than five minutes after creation, allows one configured public model,
disallows streaming and tools, permits one concurrent request, and carries
small request-rate and token limits. The callback displays a ready-to-copy curl
command and never places the key in a URL, cookie, log, trace, or database.

PostgreSQL stores short-lived OAuth state hashes and content-free claim records.
Claim creation is transactional and enforces both a per-GitHub-account cooldown
and an operator-configured global daily claim cap. The global cap and the
per-key policy together form a deterministic upper bound on trial traffic.
Provider content remains subject to ADR 0009 and is never persisted.

The demo surface has a separate origin, hash pepper, OAuth client secret, tenant,
configuration, security headers, rate limits, and telemetry events. Production
requires HTTPS and complete demo configuration before it can be enabled.
Failure of GitHub OAuth or the claim store fails closed and does not affect the
authenticated `/v1` data plane. The demo API is not part of the OpenAI-compatible
contract or generated SDKs.

## Consequences

- Developers can try the hosted gateway without receiving a shared public key.
- RAX Digital must create and rotate a GitHub OAuth App credential and disclose
  the limited identity metadata used for abuse prevention.
- GitHub availability is required only for new claims, not for issued keys or
  normal gateway traffic.
- The daily cap can make the demo temporarily unavailable; this is preferable
  to unbounded provider spend.
- Hosted subscriptions, billing, general signup, long-lived user accounts, and
  reusable OAuth sessions remain out of scope.

## Rejected alternatives

- **Publish a five-minute shared API key:** its lifetime is global rather than
  per developer and automated crawlers can consume it immediately.
- **Anonymous claim endpoint with IP throttling only:** proxy trust is
  deployment-specific and distributed abuse bypasses the limit.
- **Store GitHub access tokens or profile data:** unnecessary for eligibility
  and increases privacy and breach impact.
- **Issue a normal unrestricted tenant key:** provides no deterministic cost
  bound and weakens tenant isolation.
- **Build a full hosted account system:** conflicts with the focused evaluation
  goal and introduces billing, recovery, and identity lifecycle obligations.
