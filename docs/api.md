# API Contract

## Compatibility target

The MVP implements the OpenAI Chat Completions shape for the documented subset.
Compatibility means supported fields have the same wire shape; it does not mean
every provider behaves identically. Unsupported fields return a validation
error instead of being silently discarded.

Base URL: `https://<host>/v1`

All JSON uses UTF-8. Clients send `Authorization: Bearer <genchi-api-key>`.
Request bodies are limited to 2 MiB by default.

## Endpoints

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/chat/completions` | API key | Create or stream a completion |
| `GET` | `/v1/models` | API key | List models permitted for the key |
| `GET` | `/health/live` | none | Process liveness only |
| `GET` | `/health/ready` | none | Dependency readiness, no secret detail |
| `GET` | `/metrics` | operator policy | Prometheus metrics |

Administrative key creation is a CLI/database bootstrap workflow in the MVP;
there is no public admin HTTP API.

## Chat completions

### Request

```json
{
  "model": "genchi/fast",
  "messages": [
    {"role": "system", "content": "Be concise."},
    {"role": "user", "content": "Explain retries."}
  ],
  "temperature": 0.2,
  "max_tokens": 300,
  "stream": false,
  "user": "opaque-end-user-id"
}
```

Supported MVP fields:

| Field | Rule |
| --- | --- |
| `model` | required stable alias or allowed provider-qualified model |
| `messages` | required, 1..1024 items; system/user/assistant roles |
| `temperature` | optional, 0..2; capability-validated per candidate |
| `top_p` | optional, 0..1 |
| `max_tokens` | optional positive integer; mapped to provider output limit |
| `stop` | optional string or up to four strings |
| `stream` | optional boolean, default false |
| `n` | optional; only the value `1` is accepted |
| `user` | optional opaque identifier; not emitted in normal telemetry |

Tool calls, `response_format`, `logprobs`, `seed`, audio, modalities,
prediction, provider-specific options, and provider beta fields are outside the
`0.1` contract. Unknown fields return `invalid_request_error` instead of being
silently discarded.

### Response

```json
{
  "id": "chatcmpl_gch_01J...",
  "object": "chat.completion",
  "created": 1770000000,
  "model": "genchi/fast",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "..."},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 18,
    "total_tokens": 42
  },
  "genchi": {
    "request_id": "req_01J...",
    "provider": "openai",
    "provider_model": "gpt-5-mini",
    "attempts": 1
  }
}
```

`model` echoes the requested public model. Physical routing information is in
the `genchi` extension. Provider request IDs MAY be returned there when safe.

## Streaming

Streaming uses `Content-Type: text/event-stream`. Each event is `data: <json>`
followed by a blank line. The stream ends with `data: [DONE]`.

Rules:

- the gateway sends headers only after an upstream connection is established;
- no retry or fallback occurs after the first downstream byte;
- client disconnect cancels the provider request;
- normalized chunks use `chat.completion.chunk` and monotonic choice order;
- an upstream failure after commitment closes the stream and emits telemetry;
- optional SSE keepalive comments contain no application data.

## Models

`GET /v1/models` returns configured public aliases and explicitly exposed
provider models. It does not proxy the full provider catalog.

```json
{
  "object": "list",
  "data": [{
    "id": "genchi/fast",
    "object": "model",
    "created": 1770000000,
    "owned_by": "genchi"
  }]
}
```

## Errors

Every JSON error uses one stable envelope:

```json
{
  "error": {
    "message": "The requested model is not available.",
    "type": "model_unavailable_error",
    "code": "no_healthy_route",
    "param": "model"
  },
  "genchi": {"request_id": "req_01J...", "retryable": true}
}
```

| HTTP | Type | Example code | Retryable |
| --- | --- | --- | --- |
| 400 | `invalid_request_error` | `unsupported_parameter` | no |
| 401 | `authentication_error` | `invalid_api_key` | no |
| 403 | `permission_error` | `model_not_allowed` | no |
| 404 | `not_found_error` | `model_not_found` | no |
| 408 | `timeout_error` | `request_deadline_exceeded` | yes |
| 413 | `invalid_request_error` | `request_too_large` | no |
| 429 | `rate_limit_error` | `key_rate_limit_exceeded` | yes |
| 502 | `provider_error` | `provider_invalid_response` | depends |
| 503 | `model_unavailable_error` | `no_healthy_route` | yes |
| 504 | `timeout_error` | `provider_timeout` | yes |

Provider messages are sanitized. Raw response bodies MUST NOT be returned.
When `Retry-After` is known it is returned in seconds.

## Headers and idempotency

- `x-request-id`: caller-supplied value is accepted only when 1..128 safe ASCII
  characters; otherwise Genchi generates one. It is echoed on every response.
- `traceparent`: accepted and propagated according to W3C Trace Context.
- `Idempotency-Key`: reserved; it is not honored for chat completions in MVP.
- `x-genchi-timeout-ms`: not accepted from untrusted clients. Deadlines come
  from server policy.

## Versioning

Breaking wire changes require a new URL version. Additive optional fields and
new error codes may ship within `/v1`. Alias target changes are operational
configuration changes, but alias capability reductions require release notes.
