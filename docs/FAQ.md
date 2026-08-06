# Frequently Asked Questions

## What is Genchi?

Genchi is a self-hostable gateway that exposes one OpenAI-compatible API for
multiple AI model providers and centralizes routing, credentials, reliability,
limits, and telemetry.

## Is Genchi a reverse proxy?

It proxies requests, but it also validates a canonical contract, translates
provider protocols, applies authorization and routing policy, normalizes errors
and usage, and emits provider-neutral telemetry.

## Does it host models or GPUs?

No. The MVP calls external provider APIs. Local models and GPU scheduling are
future possibilities, not part of the first release.

## Can I use the OpenAI SDK?

Yes, for the supported Chat Completions subset. Change the base URL to Genchi
and use a Genchi API key. Unsupported OpenAI fields return explicit errors.

## Which providers are supported first?

OpenAI, Anthropic, and Gemini. Models are operator-configured because provider
catalogs and capabilities change independently of Genchi releases.

## Does `genchi/fast` always use the same model?

Not necessarily. It is a public alias whose ordered candidates are controlled
by operator policy. The response extension and telemetry identify the physical
route used.

## Does fallback combine two providers' streaming output?

No. Genchi may fall back before response commitment. After streaming begins, a
failure ends that stream; output from a second model is never spliced in.

## Does Genchi store prompts or completions?

Not in the MVP. Content is processed in memory and excluded from normal logs,
traces, and metrics. Providers may have their own retention, so operators must
review provider terms and controls.

## How are API keys stored?

Genchi keys are high-entropy credentials stored as a keyed one-way hash. The
full key is displayed only once. Provider credentials come from an external
secret source and are not returned to clients.

## Is Redis required?

Not for a simple single-node evaluation. Redis is required when exact
distributed rate limits and shared short-lived circuit state are enabled across
multiple replicas.

## Why PostgreSQL if the gateway is stateless?

Gateway request execution is stateless, but durable API key metadata, policy,
tenant boundaries, and schema versions need consistent storage. Provider and
alias policy remains in versioned YAML for `0.1`.

## Does Genchi guarantee lower cost or better answers?

No. Deterministic routing makes policy enforceable and observable, but quality,
latency, price, and provider availability vary. Automated optimization is not an
MVP claim.

## Can clients send their own provider key per request?

No. Per-request provider credentials create serious leakage, tenancy, logging,
and support risks. Operators configure provider credentials centrally.

## How do I add a provider?

Implement the provider adapter interface, declare per-model capabilities, map
errors, pass the shared conformance suite, and register it at the composition
root. See [providers.md](providers.md#adding-a-provider).

## Is a hosted service required?

No. The open-source deployment works without a Genchi account. A future hosted
service may provide managed operations and commercial features.

## What is the license?

The project is licensed under Apache-2.0 and includes `LICENSE` and `NOTICE`;
see [licensing.md](licensing.md).
