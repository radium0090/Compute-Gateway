# Hosted five-minute demo

The optional `/demo` flow lets a developer prove the public API contract before
installing the gateway. It is an evaluation surface, not anonymous signup,
billing, or a permanent credential service. The feature is disabled by default
and does not change the `/v1` API contract.

Starting with `v0.3.0`, the page also points developers to the Agent integration
guide and the `rax/agent` alias. The claimed public key deliberately remains
text-only: tool permission must be granted explicitly to a normal customer key
or a self-hosted key. This preserves ADR 0015's deny-by-default public boundary.

## User flow

1. The developer opens `/demo` and chooses **Claim a five-minute key**.
2. The gateway starts GitHub OAuth with PKCE and a short-lived, one-time state.
3. GitHub returns the browser to `/demo/callback`.
4. The gateway verifies the state and account eligibility, then creates a
   unique RAX API key.
5. The result page displays the credential exactly once inside a ready-to-run
   `curl`. The key expires no later than five minutes after issuance.

No OAuth access token is persisted. The claim ledger stores only a
domain-separated HMAC of GitHub's numeric account ID. The account creation time
is checked but not stored. Prompt and completion content remain subject to the
gateway's existing no-storage rule.

## Safeguards

- GitHub account age minimum, default 7 days;
- one successful claim per account per cooldown window, default 24 hours;
- global successful-claim cap, default 50 per UTC day;
- process-level OAuth-start flood guard before database work;
- one model, no streaming, no tools, one concurrent request;
- two requests per minute by default;
- conservative request-size enforcement and capped provider output;
- HTTPS-only origin in production, PKCE, state binding, Secure/HttpOnly cookies;
- API credentials appear only in the callback response body, never URLs,
  cookies, redirects, logs, OAuth state, or repository files.

The global and per-account claim checks and API-key insertion execute in one
PostgreSQL transaction. Multiple replicas therefore cannot race past the
configured successful-claim budget. This controls ordinary public evaluation
cost; it is not a substitute for provider-side spend alerts and hard quotas.

## Operator setup

Create a dedicated GitHub OAuth App with:

- homepage URL: `https://api.example.com/demo`;
- authorization callback URL: `https://api.example.com/demo/callback`.

The app does not request repository, email, or organization scopes. Configure
all `RCG_DEMO_*` settings listed in [configuration](config.md), create the
dedicated active tenant named by `RCG_DEMO_TENANT_ID`, run database migrations,
and only then set `RCG_DEMO_ENABLED=true`.

Use a separate random value for `RCG_DEMO_HASH_PEPPER`; do not reuse the API-key
or administrator-session peppers. Rotate the GitHub client secret and demo
pepper through the normal secret-management workflow. Pepper rotation makes
old identity pseudonyms unlinkable and therefore resets cooldown history; plan
it together with a temporary reduction of the global daily budget.

For the low-cost AWS Compose deployment, the production Secrets Manager JSON
may include the following fields. The deployment creates or reactivates the
dedicated demo tenant after migrations.

```json
{
  "RCG_DEMO_ENABLED": "true",
  "RCG_DEMO_GITHUB_CLIENT_ID": "replace-with-oauth-app-client-id",
  "RCG_DEMO_GITHUB_CLIENT_SECRET": "replace-with-oauth-app-secret",
  "RCG_DEMO_HASH_PEPPER": "replace-with-at-least-32-random-characters",
  "RCG_DEMO_TENANT_ID": "replace-with-a-dedicated-uuid"
}
```

Never add these values to GitHub variables, workflow logs, Compose files, or
the repository. Disable claims immediately by setting `RCG_DEMO_ENABLED` to
`false` and redeploying; already issued keys still expire within five minutes.

The decision and its architectural boundaries are recorded in
[ADR 0014](adr/0014-github-authenticated-demo-claims.md).
