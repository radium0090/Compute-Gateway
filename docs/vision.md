# Vision

## Mission

Build the open compute layer that lets developers use the best available AI
models without coupling their applications to a single vendor.

## The problem

Every provider exposes different authentication, request formats, streaming
events, error semantics, quotas, and model names. Direct integrations multiply
operational work and make switching providers risky. Existing proxies often
hide these differences without defining predictable failure, security, or
observability behavior.

## The RAX Compute Gateway promise

An application integrates once with a stable API. RAX Compute Gateway translates requests,
selects an allowed route, invokes the provider, normalizes the response, and
emits the operational evidence needed to understand the decision.

RAX Compute Gateway should be:

- **Open:** self-hostable with inspectable routing and portable data.
- **Predictable:** explicit policies take priority over opaque automation.
- **Compatible:** existing OpenAI clients work with a base URL change.
- **Provider-neutral:** provider-specific capabilities remain accessible without
  making the common path provider-specific.
- **Safe by default:** secrets and prompt content are not logged, and metadata
  retention is minimal.
- **Operable:** every request has a correlation ID, route explanation, metrics,
  and bounded failure behavior.

## Product boundaries

RAX Compute Gateway is a gateway and control plane, not a model host. The open-source core
owns protocol compatibility, provider adapters, routing, policies, and
telemetry. A future hosted service may add managed operations, teams, billing,
analytics, and enterprise support without making the core unusable alone.

## Long-term direction

The architecture may later support more inference providers, regional and
capacity-aware routing, batch workloads, local models, GPU endpoints, compute
credits, and workload scheduling. Those ideas are directional, not promises in
the MVP contract.

## Success measures

The project succeeds when:

- a developer completes a first request in under five minutes;
- an OpenAI-compatible application switches with configuration only;
- adding a provider does not modify the public handler;
- route selection and fallback are reproducible from policy and telemetry;
- a single gateway node can fail without losing durable configuration;
- the open-source deployment works without a RAX Compute Gateway Cloud account.

## Principles for decisions

1. Preserve the public contract before provider convenience.
2. Prefer deterministic, explainable behavior before intelligent automation.
3. Make the secure path the easy path.
4. Keep the request data plane stateless wherever possible.
5. Add abstraction only after at least two implementations need it.
6. Measure reliability before optimizing cost or latency.

