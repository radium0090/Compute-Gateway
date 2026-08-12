# Provider Adapters

## Supported providers

The MVP includes OpenAI, Anthropic, and Gemini. A provider is enabled only when
its adapter configuration and credential reference validate successfully.

## Canonical model

The API layer converts requests to a provider-neutral canonical representation.
Adapters translate that representation but MUST NOT decide routing, caller
permissions, or global retry policy.

Required adapter behavior:

- non-streaming and streaming chat completion;
- cancellation via `AbortSignal`;
- provider deadline and connection timeout;
- usage and finish-reason normalization;
- safe error classification;
- provider request ID extraction;
- no logging of request/response content or authorization headers.

## Capability declaration

```ts
type ProviderCapabilities = {
  chat: true;
  streaming: boolean;
  tools: boolean;
  jsonObject: boolean;
  jsonSchema: boolean;
  systemMessages: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};
```

Capabilities are declared per configured provider model, not just per adapter.
They are deployment configuration validated against adapter-supported features.
Provider catalog discovery may assist configuration but MUST NOT silently add a
model to the public API.

## Translation rules

- Preserve message order.
- Map system instructions using the native system channel where available.
- Reject a role or content type that cannot be represented safely.
- Never drop an unsupported parameter without an explicit compatibility rule.
- Preserve provider token counts when supplied; mark estimates as estimates.
- Normalize finish reasons to `stop`, `length`, `tool_calls`,
  `content_filter`, or `null`.
- Generate RAX Compute Gateway response IDs; retain provider IDs only in protected metadata.

## Error classification

Adapters return typed errors rather than HTTP responses:

| Class | Examples | Default retry |
| --- | --- | --- |
| `ProviderAuthenticationError` | invalid server provider key | no; route unhealthy |
| `ProviderRateLimitError` | upstream 429 | yes, pre-commit |
| `ProviderTimeoutError` | deadline exceeded | yes, pre-commit |
| `ProviderUnavailableError` | 5xx, connection failure | yes, pre-commit |
| `ProviderRequestError` | context length, invalid field | no |
| `ProviderPolicyError` | safety/content refusal | no |
| `ProviderProtocolError` | malformed response | limited fallback |

Raw upstream bodies may appear only in bounded, access-controlled debug capture
that is disabled by default; they never enter normal logs or client errors.

## Conformance suite

Every adapter ships fixtures and passes the same tests:

1. canonical request translation;
2. text response normalization;
3. SSE/chunk ordering and terminal chunk behavior;
4. cancellation and timeout propagation;
5. error classification for representative status codes;
6. redaction of keys, prompt text, and response text;
7. unsupported capability rejection;
8. client disconnect cleanup;
9. usage normalization;
10. malformed provider response handling.

Contract tests use local mock servers. Live provider tests are opt-in, run with
strict spend limits, and never run for untrusted pull requests.

## Adding a provider

1. Create `packages/provider-<id>` and implement the domain port.
2. Declare configuration and model capabilities.
3. Map provider errors to canonical errors.
4. Add adapter conformance fixtures and optional live smoke tests.
5. Register through the composition root without changing the API handler.
6. Document provider-specific setup, limitations, and data-processing behavior.
7. Add an ADR if the canonical domain contract must change.

Provider SDK versions are pinned through the lockfile. Direct HTTP clients MAY
be preferred when an official SDK prevents cancellation, redaction, or stable
error handling.

## Current chat compatibility rules

- Anthropic and Gemini map only leading `system` messages to their native
  system-instruction field. A system message after conversation turns is
  rejected rather than reordered.
- Anthropic maps `user` to `metadata.user_id`; Gemini treats `user` as gateway
  metadata and does not send it upstream.
- Anthropic temperatures above `1` are rejected because the native API cannot
  represent them without changing their meaning.
- Tool calls and structured outputs remain later work even where a provider has
  a native feature; the public `0.1` schema rejects those request fields.
