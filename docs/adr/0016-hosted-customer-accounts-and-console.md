# ADR 0016: Hosted Customer Accounts and Self-Service Console

- Status: Accepted
- Date: 2026-11-19

## Context

RAX Compute Gateway already has an operator-only control plane and a bounded
GitHub-authenticated demo. RAX Digital now needs a public product site and a
long-lived customer experience where an organization can register, verify its
email address, sign in, inspect its tenant, and manage scoped client API keys.
The operator console cannot safely be reused because administrator identities
have cross-tenant privileges and a different audit and recovery lifecycle.

The first commercial deployment remains a deliberately low-cost single host.
Adding a separate identity service or JavaScript application runtime would add
operational cost before demand justifies it, but customer-facing functionality
must still preserve tenant isolation, the no-content-persistence rule, and the
existing data-plane contract.

## Decision

Add a disabled-by-default hosted customer surface under `/console` and
`/console/api`, composed by `apps/gateway` and served from the existing OCI
image. Serve the public RAX Compute Gateway product site from `/`. Customer
domain contracts, application services, cryptography, and PostgreSQL adapters
follow the existing dependency direction; HTTP handlers do not contain
business or database logic.

Customer identities are separate from administrator identities. An initial
account belongs to exactly one tenant. Email addresses are normalized and must
be verified before normal console access. Passwords use the same reviewed
scrypt format as administrator passwords, but customer sessions, verification
tokens, and password-reset tokens use a dedicated pepper and purpose-separated
hash inputs. Only keyed hashes are persisted. Browser sessions are opaque,
server-side, revocable, bounded, and delivered in a host-only `Secure`,
`HttpOnly`, `SameSite=Lax` cookie. State-changing requests require an exact
origin check and a per-session CSRF token.

Public registration creates a pending customer and a disabled tenant. It does
not create an API key or authorize provider spend. After email verification,
an operator must approve the tenant and assign bounded entitlements before the
customer can issue a key. The first release supports one customer owner per
tenant; invitations and additional organization roles require a later change.

The customer console may:

- show the current account, tenant status, and content-free key activity;
- create and revoke keys only for its own active tenant and only within
  operator-assigned model, streaming, tool, rate, concurrency, token, expiry,
  and key-count ceilings;
- display a newly created plaintext key exactly once;
- submit a business inquiry through a separately rate-limited public form.

Business inquiries store only the contact fields the visitor submits, consent
time, status, and bounded operational metadata. They are never mixed with
model request telemetry. Production deployments must publish privacy and
retention text and provide an operator deletion path.

Email delivery is represented by an application port. Production registration
and password recovery fail closed unless a configured mail adapter can deliver
the required one-time link. Development may use an explicit test adapter, but
production responses never return verification or reset tokens.

Hosted payment collection, automatic subscription renewal, tax calculation,
invoicing, encrypted customer BYOK storage, social login, MFA, and multi-user
organization roles are not part of this decision. Plan and approval state can
be administered manually until a payment-provider ADR is accepted.

## Consequences

- RAX Digital gains a real customer identity boundary without granting operator
  privileges or changing `/v1`.
- Public registration cannot create unbounded provider cost because tenant
  approval and entitlements remain operator-controlled.
- PostgreSQL stores additional account, session, token, entitlement, inquiry,
  and content-free audit metadata; prompt, completion, tool, and provider
  credential content remains excluded.
- Co-location keeps the first deployment inexpensive, but a gateway outage also
  makes the site and console unavailable. The customer surface can move to a
  separate service later without changing its domain ports.
- Password recovery and verified public registration require a transactional
  email provider before production enablement.

## Rejected alternatives

- **Reuse administrator accounts:** violates least privilege and tenant
  isolation.
- **Issue an unrestricted key immediately after signup:** permits automated
  provider-spend abuse.
- **Store browser tokens or API keys in plaintext:** expands breach impact and
  conflicts with ADR 0005 and ADR 0013.
- **Return verification tokens from production APIs:** turns email verification
  into a cosmetic control.
- **Build billing before customer identity and entitlements:** couples two high-
  risk lifecycles before the access boundary is proven.
