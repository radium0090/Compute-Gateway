# ADR 0015: Bounded Agent Tool-Calling Compatibility

- Status: Accepted
- Date: 2026-08-25

## Context

Agent runtimes such as Hermes Agent, LangChain/LangGraph, CrewAI, and AutoGen
need more than text chat. They send function definitions, receive model-selected
tool calls, execute those tools outside the model gateway, and return tool
results in a later request. RAX Compute Gateway already exposes a bounded
OpenAI-compatible Chat Completions API and provider capability filtering, but
its public request and canonical domain did not carry tool calls or structured
output requirements.

Blindly forwarding provider JSON would violate ADR 0002 and ADR 0003. Executing
tools inside the gateway would also combine model access with an unrelated and
substantially more privileged runtime security boundary.

## Decision

RAX Compute Gateway `v0.3.0` adds a bounded OpenAI-compatible function-tool
subset to `/v1/chat/completions`: `tools`, `tool_choice`,
`parallel_tool_calls`, assistant `tool_calls`, and `tool` messages. Streaming
responses carry indexed tool-call deltas without buffering or assembling the
JSON argument string. The contract also adds `response_format` for `text`,
`json_object`, and `json_schema` modes.

The provider-neutral canonical domain represents tool definitions, opaque JSON
argument strings, tool-result correlation IDs, response formats, and streamed
tool-call deltas. OpenAI, Anthropic, and Gemini adapters translate only the
declared intersection. A request adds `tools`, `json_object`, or `json_schema`
to the router's required capabilities, so an incapable candidate is removed
before provider invocation. API keys continue to deny tools by default and
must set `allowTools`; hosted demo keys never receive that permission.

The gateway never executes a tool, parses tool arguments for business logic,
or persists message/tool content. Tool definitions, arguments, results, and
structured model output remain content under ADR 0009 and are excluded from
logs, traces, metrics, audits, and error messages.

Retries and fallback remain pre-commit only. A successful non-streaming tool
call is a committed result. For streaming, the first emitted role, text, or
tool-call delta commits the route; no other provider may continue that stream.
Adapters reject provider-specific combinations that cannot be represented
rather than silently changing their meaning.

This decision does not add `/v1/responses`, hosted tool execution, MCP hosting,
computer-use execution, multimodal message parts, or a general agent runtime.
Those require separate contracts and security decisions.

## Consequences

- Chat Completions based agents can use one RAX endpoint while retaining their
  own harness, tools, permissions, memory, and sandbox.
- Operators can expose a dedicated capability-safe alias such as `rax/agent`
  and independently grant tool permission per API key.
- Provider translation and streaming conformance tests expand to include tool
  calls and tool-result round trips.
- Structured output availability remains model/candidate specific and is
  selected through explicit capability metadata.
- Agent frameworks that require the OpenAI Responses API or provider-specific
  extensions are not yet compatible merely because tool calling is supported.

## Rejected alternatives

- **Blind OpenAI JSON pass-through:** loses provider neutrality, validation,
  redaction guarantees, and deterministic capability routing.
- **Execute tools in the gateway:** creates remote-code, credential, network,
  and tenant-isolation risks outside the model data-plane responsibility.
- **Advertise tools without route filtering:** produces runtime failures or
  silently dropped behavior when fallback candidates have different features.
- **Buffer streaming arguments into one synthetic chunk:** increases latency
  and differs from the event behavior expected by existing agent SDKs.
