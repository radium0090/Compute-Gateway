# Agent failover acceptance report

Use this credential-free rehearsal before attempting a managed or self-hosted
pilot with Gemini primary and OpenAI backup. It exercises the real
`/v1/chat/completions` handler, API-key verification, routing and both provider
adapters. It replaces upstream HTTP responses with in-process fixtures. It
does not open a network listener, use PostgreSQL or Redis, read `.env`, or
send requests to either provider.

## Generate evidence

From a Node.js 24 checkout with locked dependencies installed:

```sh
corepack pnpm build
corepack pnpm --silent agent:failover-report > agent-failover-report.md
corepack pnpm --silent agent:failover-report --format json > agent-failover-report.json
```

The report uses a versioned schema. A passing run exits `0`; a failed check
still prints the report and exits `1`; invalid CLI arguments exit `2`. An
execution error exits `1` without printing a misleading report. On GitHub,
the quality workflow publishes both formats as the
`agent-failover-offline-report` artifact.

| Scenario | Expected behavior |
| --- | --- |
| Healthy primary | Gemini returns the required function call; OpenAI is not called. |
| Gemini returns 429 | RAX ignores the ineligible chat-only candidate, then calls OpenAI and verifies the same function contract. |
| JSON Schema with Gemini returning 429 | OpenAI receives the schema and its response is checked against the fixture contract. |
| No eligible route | RAX returns `503 no_healthy_route` and invokes neither provider. |
| Gemini disconnects after a tool delta | The HTTP stream has already started; it ends without `[DONE]`. RAX does not call OpenAI or splice the two outputs. |

The report contains fixture model names, the policy fingerprint used for each
case, provider order, attempt counts, fixture token usage, and assertion
results. It omits request IDs, credentials, prompts, results, and tool
arguments. The token counts are synthetic and are not cost or billing data.
Keep real customer content, credentials, and customer-specific findings out
of the public repository and public CI artifacts.

## Before accepting a real pilot

1. Agree with the customer on one integration, a synthetic or scrubbed sample,
   exact primary and backup model IDs, and how the client handles missing or
   partial responses. If the integration does not use tools or JSON Schema,
   define the actual response assertions instead of assuming these are needed.
2. On the isolated rehearsal deployment, create a verified, approved test
   tenant/key with the smallest request, concurrency, token and expiry limits
   needed. Don't use a public demo key. Configure only the providers approved
   for the customer's use and confirm applicable upstream terms and regional
   eligibility before enabling them.
3. Run one healthy call against each permitted provider separately. Verify the
   response contract, provider/model, and token metadata. Do not intentionally
   exhaust a provider quota or disrupt production to force a failure.
4. In an isolated rehearsal, use controlled failure fixtures for the cutover
   cases. Record controlled and live evidence separately. Follow the
   [XServer bootstrap and acceptance runbook](xserver-bootstrap.md) before
   routing real customer traffic.

An offline PASS is evidence about gateway behavior, not a certification of
live model quality, provider availability, customer data handling, or the
customer's integration. Do not execute partially streamed tool arguments.
