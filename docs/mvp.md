# MVP Specification

## Objective

Release a self-hostable gateway that lets a developer call OpenAI, Anthropic,
and Gemini through one OpenAI-compatible chat completions API with production-
grade authentication, routing, failure handling, and telemetry.

## Personas

- **Application developer:** wants one client and stable model aliases.
- **Platform engineer:** wants centralized keys, policies, and observability.
- **Operator:** wants safe deployment, health signals, and bounded failures.
- **Contributor:** wants a clear adapter contract and deterministic tests.

## Required scope

| Area | Requirement |
| --- | --- |
| API | `POST /v1/chat/completions`, non-streaming and SSE streaming |
| Models | `GET /v1/models` returns models allowed for the caller |
| Providers | OpenAI, Anthropic, Gemini |
| Routing | aliases, ordered candidates, health filtering, fallback |
| Auth | hashed RAX Compute Gateway API keys; provider credentials from server configuration |
| Limits | request size, concurrency, per-key rate limits, provider timeout |
| Storage | PostgreSQL for identities/config metadata; Redis optional for distributed limits |
| Operations | liveness, readiness, metrics, traces, structured logs |
| Delivery | Docker image, Compose stack, Kubernetes/Helm baseline |
| SDK | TypeScript and Python clients generated or wrapped from OpenAPI |

## Explicit non-goals

- hosted signup, subscriptions, invoices, or payment processing;
- a web dashboard or organization administration UI;
- embeddings, image, audio, batch, assistant, or realtime APIs;
- semantic caching or prompt-response storage;
- automatic quality judging or LLM-based routing;
- end-user OAuth and browser sessions;
- user-supplied provider keys on individual API requests;
- guaranteed token-perfect equivalence across providers.

## User stories

1. As a developer, I can point the OpenAI SDK at RAX Compute Gateway and receive a standard
   chat completion.
2. As a platform engineer, I can map `rax/fast` to an ordered list of models
   without changing application code.
3. As an operator, I can see which provider was selected and why without
   capturing prompt or completion content.
4. As a developer, I receive one documented error envelope even when provider
   errors differ.
5. As an operator, I can rotate RAX Compute Gateway and provider credentials without
   rebuilding the image.
6. As a contributor, I can validate an adapter with a shared conformance suite.

## Acceptance criteria

The MVP is releasable when all of the following are true:

- OpenAI SDK smoke tests pass against all three providers.
- Streaming preserves event order, terminates with `[DONE]`, and disconnects
  upstream when the client disconnects.
- No retry occurs after response bytes reach the client.
- A configured fallback is attempted only for documented retryable failures.
- API keys are stored as one-way hashes and are never returned after creation.
- Logs and traces pass automated secret and prompt-content redaction tests.
- A migration from an empty database and from the previous release passes.
- Two replicas pass readiness and rolling-upgrade tests.
- The p95 gateway overhead is below 50 ms for non-streaming requests under the
  documented reference load, excluding provider time.
- Documentation links, examples, OpenAPI validation, and container scans pass.

## Delivery milestones

1. **Foundation:** repository, configuration, database, auth, health endpoints.
2. **Vertical slice:** OpenAI adapter and non-streaming completion.
3. **Compatibility:** streaming, errors, model list, SDK smoke tests.
4. **Multi-provider:** Anthropic and Gemini conformance.
5. **Routing:** aliases, fallback, rate limits, circuit state.
6. **Operations:** telemetry, Docker, Kubernetes, CI and release automation.
7. **Release candidate:** security review, load test, docs verification.

## Definition of done for a feature

A feature is done only when its contract, validation, unit tests, integration
tests, telemetry, failure modes, configuration, migration impact, and user
documentation are included in the same pull request or explicitly linked.

