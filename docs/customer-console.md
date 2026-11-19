# Customer Console

The hosted customer Console is the browser control plane accepted in ADR 0016.
It is separate from the operator-only `/admin` console and does not change the
public `/v1` data-plane contract.

## Lifecycle

1. A visitor submits `/console/register` with a work email and password.
2. The gateway creates a pending customer user, a disabled tenant, and bounded
   private-beta entitlements. No provider access is granted at this point.
3. The visitor verifies the email address using a one-time link.
4. An operator reviews the request in `/admin/` and either activates a bounded
   entitlement profile or leaves the account pending.
5. An active customer signs in, creates a tenant-scoped API key, and sees the
   credential once. Only a hash is persisted.
6. The customer can list and revoke their own keys. Provider credentials remain
   operator-managed and are never exposed in either console.

Registration and email verification are intentionally not equivalent to
service approval. This prevents an unreviewed account from creating provider
spend.

## Runtime configuration

Enable the Console only when all of these values are available:

```dotenv
RCG_CONSOLE_ENABLED=true
RCG_CONSOLE_ORIGIN=https://gateway.example.com
RCG_CONSOLE_SESSION_PEPPER=<independent-random-secret>
RCG_CONSOLE_SESSION_TTL_MS=28800000
RCG_CONSOLE_REGISTRATION_ENABLED=false
RCG_CONSOLE_MAIL_FROM='RAX Compute Gateway <console@example.com>'
RCG_CONSOLE_RESEND_API_KEY=<resend-api-key>
```

`RCG_CONSOLE_ORIGIN` is an exact origin, not a URL prefix. Production requires
HTTPS. The Console session pepper must be independent of API-key, admin, and
demo peppers. The current transactional-email adapter uses Resend and fails
closed when delivery is unavailable.

Keep public registration disabled until the sending domain is verified and the
complete lifecycle below has passed on the deployed host.

## Operator approval

The customer-account screen in `/admin/` lists pending and active accounts.
Activation publishes a bounded entitlement set including:

- allowed public model patterns;
- streaming and function-tool permissions;
- request, concurrency, input-token, and output-token ceilings;
- maximum active API keys and key lifetime.

Suspension prevents new self-service access. Operators should also revoke
existing keys when an immediate credential shutdown is required.

## Production acceptance check

Use a dedicated test address and low provider limits.

1. Register and confirm that no key can be created before approval.
2. Verify the email and confirm that the one-time link cannot be replayed.
3. Activate the account in `/admin/` with a minimal entitlement profile.
4. Sign in, create one API key, call `/v1/chat/completions`, and revoke the key.
5. Confirm the revoked key returns `401` and no credential appears in logs.
6. Request a password reset, complete it once, and confirm old sessions fail.
7. Suspend the account and verify customer mutations fail closed.
8. Submit a business inquiry and move it through the operator workflow.

Do not use real customer prompts, credentials, or personal data in deployment
evidence. The Console API is an internal control-plane contract and is excluded
from the public OpenAPI/SDK surface.

## Deferred capabilities

The first hosted release does not include automated subscription billing,
provider-key self-service, MFA, organization invitations, or multi-role teams.
Those require separate product and security decisions. Until billing is added,
the service is a manually approved private beta.
