import json

import httpx
from openai import OpenAI


def handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/v1/models":
        return httpx.Response(
            200,
            json={"object": "list", "data": [{"id": "rax/fast", "object": "model"}]},
        )
    if request.url.path != "/v1/chat/completions":
        return httpx.Response(404, json={"error": {"message": "not found"}})
    body = json.loads(request.content)
    if body.get("stream"):
        tool_delta = None
        if body.get("tools"):
            tool_delta = {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_compat",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": '{"id":42}'},
                    }
                ]
            }
        event = {
            "id": "chatcmpl_rcg_compat",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "rax/fast",
            "choices": [
                {
                    "index": 0,
                    "delta": tool_delta
                    or {"role": "assistant", "content": "ok"},
                    "finish_reason": "tool_calls" if tool_delta else "stop",
                }
            ],
            "rax": {
                "request_id": "req_compat",
                "provider": "openai",
                "provider_model": "test-model",
                "attempts": 1,
            },
        }
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=f"data: {json.dumps(event)}\n\ndata: [DONE]\n\n".encode(),
        )
    tool_calls = None
    if body.get("tools"):
        tool_calls = [
            {
                "id": "call_compat",
                "type": "function",
                "function": {"name": "lookup", "arguments": '{"id":42}'},
            }
        ]
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl_rcg_compat",
            "object": "chat.completion",
            "created": 1,
            "model": "rax/fast",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None if tool_calls else "ok",
                        **({"tool_calls": tool_calls} if tool_calls else {}),
                    },
                    "finish_reason": "tool_calls" if tool_calls else "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
            },
            "rax": {
                "request_id": "req_compat",
                "provider": "openai",
                "provider_model": "test-model",
                "attempts": 1,
            },
        },
    )


with httpx.Client(transport=httpx.MockTransport(handler)) as transport:
    client = OpenAI(
        api_key="compatibility-placeholder",
        base_url="http://rax-compute-gateway.test/v1",
        http_client=transport,
        max_retries=0,
    )
    completion = client.chat.completions.create(
        model="rax/fast", messages=[{"role": "user", "content": "hello"}]
    )
    assert completion.choices[0].message.content == "ok"

    agent_completion = client.chat.completions.create(
        model="rax/agent",
        messages=[{"role": "user", "content": "look up 42"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "lookup",
                    "parameters": {"type": "object"},
                },
            }
        ],
    )
    call = agent_completion.choices[0].message.tool_calls[0]
    assert call.function.name == "lookup"
    assert json.loads(call.function.arguments) == {"id": 42}

    stream = client.chat.completions.create(
        model="rax/fast",
        messages=[{"role": "user", "content": "hello"}],
        stream=True,
    )
    assert "".join(chunk.choices[0].delta.content or "" for chunk in stream) == "ok"

    tool_stream = client.chat.completions.create(
        model="rax/agent",
        messages=[{"role": "user", "content": "look up 42"}],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "lookup",
                    "parameters": {"type": "object"},
                },
            }
        ],
        stream=True,
    )
    fragments = []
    for chunk in tool_stream:
        for delta in chunk.choices[0].delta.tool_calls or []:
            if delta.function and delta.function.arguments:
                fragments.append(delta.function.arguments)
    assert json.loads("".join(fragments)) == {"id": 42}
    assert [model.id for model in client.models.list().data] == ["rax/fast"]

print("OpenAI Python SDK compatibility passed")
