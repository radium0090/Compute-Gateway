# Agent and Harness Integration

## Responsibility boundary

RAX Compute Gateway is the model connectivity and governance layer. An Agent
or harness owns its loop, prompts, memory, tools, execution sandbox, and user
channels.

```text
User -> Agent/harness -> RAX Compute Gateway -> OpenAI | Anthropic | Gemini
              |
              +-> shell | browser | MCP | application tools
```

The gateway validates and translates tool descriptions, model tool calls, and
tool results. It never executes a tool or grants a model access to the gateway
host.

## Compatibility target

`v0.3.0` targets frameworks that can use the OpenAI-compatible
`POST /v1/chat/completions` function-calling shape. This includes common
configurations of Hermes Agent, LangChain/LangGraph, CrewAI, AutoGen, and custom
Agent harnesses. Exact framework releases can change their default protocol,
so pin versions and run the integration smoke below before production use.

Frameworks that require `/v1/responses`, Assistants, Realtime, multimodal
message parts, hosted tools, or provider-specific beta fields need a future RAX
contract or a framework adapter. OpenAI-compatible does not mean every OpenAI
endpoint is implemented.

## Hermes Agent

Hermes supports named custom OpenAI-compatible Chat Completions providers. Keep
the credential in an environment variable rather than the configuration file:

```yaml
model:
  provider: rax
  default: rax/agent

providers:
  rax:
    base_url: https://api.rax-digital.com/v1
    api_mode: chat_completions
    key_env: RCG_API_KEY
```

```bash
export RCG_API_KEY='rcg_replace_with_your_key'
hermes
```

Configuration field names are tied to the installed Hermes release; compare
them with that release's `cli-config.yaml.example` when upgrading.

## OpenAI SDK smoke

The simplest framework-independent compatibility check uses the OpenAI SDK:

```python
import json
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["RCG_API_KEY"],
    base_url="https://api.rax-digital.com/v1",
)

response = client.chat.completions.create(
    model="rax/agent",
    messages=[{"role": "user", "content": "Look up order 42"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "lookup_order",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "integer"}},
                "required": ["id"],
                "additionalProperties": False,
            },
        },
    }],
    tool_choice="auto",
)

call = response.choices[0].message.tool_calls[0]
arguments = json.loads(call.function.arguments)
print(call.function.name, arguments)
```

The application executes `lookup_order`, appends the assistant message and a
`tool` message with the matching `tool_call_id`, then sends the next completion
request. Never execute a model-selected function without an allowlist, schema
validation, authorization, timeout, and sandbox appropriate to that tool.

## Key and model policy

- Tool permission is deny-by-default per API key.
- Use the operator console checkbox or `keys create --allow-tools`.
- Prefer `rax/agent`, whose alias requires `tools`.
- Structured output requests additionally require `json_object` or
  `json_schema` on the selected model.
- The hosted five-minute demo intentionally rejects tools.

## Streaming

`delta.tool_calls` follows the OpenAI indexed-fragment shape. Assemble
`function.arguments` by `index` and in arrival order. Do not parse or execute an
argument string until the choice finishes with `tool_calls`. A stream is never
retried or moved to another provider after its first emitted delta.
