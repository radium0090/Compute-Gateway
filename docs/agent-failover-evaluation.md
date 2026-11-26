# Agent failover evaluation

## Product focus

Evaluate one real agent workflow before migrating the rest: confirm that a
provider failure does not silently change the response contract the agent
depends on. The same OpenAI-compatible request and model alias can be used
against a self-hosted or managed RAX deployment. Route rules and provider
credentials are configured by the deployment operator.

This is a proposed onboarding focus, not a claim that other gateways cannot
implement the same behavior. The homepage lab is an illustration; it does not
run against the visitor's providers. A generated, customer-specific failover
report is a possible follow-up, not an existing feature.

## Competitive snapshot

Official documentation reviewed on 2026-11-26; not an independent performance,
availability, or feature-completeness benchmark.

| Service | Published capabilities | Implication for RAX |
| --- | --- | --- |
| OpenRouter | [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks), [provider routing and parameter requirements](https://openrouter.ai/docs/guides/routing/provider-selection), [USDC payments](https://openrouter.ai/support/) | An API, automatic fallback, and crypto payment are not unique. |
| LiteLLM | [Self-hosted proxy](https://docs.litellm.ai/docs/), [ordered fallbacks](https://docs.litellm.ai/docs/router/learn/reliability), [routing playground](https://docs.litellm.ai/router-playground), [spend tracking](https://docs.litellm.ai/docs/proxy/cost_tracking) | Neither self-hosting nor an interactive routing demo is a moat. Focus on validating the agent's actual tool or output schema. |
| Portkey | [Open-source gateway](https://github.com/Portkey-AI/gateway) and [configurable fallbacks](https://portkey.ai/docs/product/ai-gateway/fallbacks) | An open-source gateway with ordered backups is already available elsewhere. |
| Cloudflare AI Gateway | [Model aliases and dynamic routes](https://developers.cloudflare.com/ai-gateway/features/routing/) | A stable alias alone is not a compelling reason to migrate. |
| MixRoute | [USDT, BTC, and ETH top-ups](https://mixroute.ai/blog/pay-for-ai-apis-with-crypto/) | The proposed coin list is a payment option, not a defensible differentiator. |

## Pilot acceptance checklist

Use a test key, an isolated environment, and synthetic inputs. Use controlled
test adapters or an isolated stub to produce failures; do not cause failures
in production or assume a sandbox provider will produce a chosen error.
Validate one capability at a time using the [agent integration guide](agents.md).

| Scenario | Expected result |
| --- | --- |
| Healthy primary | Same response alias; expected tool name and argument schema (or expected JSON schema); primary in `rax.provider` and `rax.provider_model`. |
| Primary returns a retryable 429 before output | With same-route retries disabled and one compatible backup, the same alias returns a valid tool call or JSON; the response identifies the backup and reports `rax.attempts: 2`. |
| A configured candidate cannot satisfy the request's capabilities | The candidate is not invoked; if no eligible route remains, the request fails rather than silently dropping the requirement. |
| Upstream disconnects after a tool-call delta | No second provider is invoked and no normal `[DONE]` terminator is emitted for the interrupted stream. The caller must not execute partially streamed arguments. |

Record the policy revision, synthetic test case, winning provider/model,
attempt count, and schema assertion outcome. Keep credentials, prompts, and
tool arguments out of the report. Capability filtering relies on declared
model support; it does not guarantee identical provider behavior, which is
why acceptance tests should verify the output itself.

Run the existing credential-free routing and stream fixtures from the
repository root:

```sh
corepack pnpm exec vitest run \
  packages/router/src/policy-router.test.ts \
  packages/application/src/create-chat-completion.test.ts \
  apps/gateway/src/chat-completion.test.ts
```

These tests check RAX behavior with controlled providers. They are not a live
certification of a customer's model selection, settings, or client.
