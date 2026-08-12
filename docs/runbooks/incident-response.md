# Incident response

## Priorities

Protect tenants and credentials, contain provider/network abuse, preserve safe
evidence, restore known-good service, and communicate verified facts. Model
content is sensitive even when it is not persisted by RAX Compute Gateway.

## Triage and containment

1. Assign an incident lead, severity, UTC start time, and private coordination
   channel. Security reports follow `SECURITY.md`, never a public issue.
2. Identify affected tenants, key public IDs, provider routes, versions,
   regions, and time window using metadata only.
3. Disable or revoke affected RAX Compute Gateway keys. Rotate provider credentials through
   the secret manager and restart/roll workloads so stale environment values
   disappear.
4. Restrict ingress/egress or remove affected provider routes when active abuse
   continues. Preserve at least one healthy route only when policy permits it.
5. Roll back by immutable digest when a new application/configuration caused
   the incident and schema compatibility is proven.

## Evidence rules

Collect request IDs, timestamps, normalized error codes, deployment/config
identities, audit events, aggregate metrics, and redacted traces. Do not add
authorization headers, plaintext API keys, provider response bodies, prompts,
tool arguments, database URLs, environment dumps, heap dumps, or core dumps to
the incident record. If content capture becomes essential, obtain explicit
security/privacy approval, encrypt it, minimize access, and set deletion time.

## Recovery

- confirm live and ready across at least two replicas;
- verify key revocation and replacement-key authentication;
- run bounded non-streaming, streaming, cancellation, and affected-provider
  smoke tests;
- check database/Redis health, connection counts, error rates, latency, and
  telemetry delivery;
- keep heightened monitoring through an agreed observation window.

## Follow-up

Document impact, timeline, root cause, contributing controls, recovery proof,
and corrective owners without including sensitive content. Publish an advisory
when users must rotate or upgrade. Add a regression test or operational control,
review retention/deletion, and hold a blameless exercise before closing the
incident.
