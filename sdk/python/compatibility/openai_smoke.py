import json

import httpx
from openai import OpenAI


def handler(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/v1/models":
        return httpx.Response(
            200,
            json={"object": "list", "data": [{"id": "genchi/fast", "object": "model"}]},
        )
    if request.url.path != "/v1/chat/completions":
        return httpx.Response(404, json={"error": {"message": "not found"}})
    body = json.loads(request.content)
    if body.get("stream"):
        event = {
            "id": "chatcmpl_gch_compat",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": "genchi/fast",
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop",
                }
            ],
            "genchi": {
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
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl_gch_compat",
            "object": "chat.completion",
            "created": 1,
            "model": "genchi/fast",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "ok"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
            },
            "genchi": {
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
        base_url="http://genchi.test/v1",
        http_client=transport,
        max_retries=0,
    )
    completion = client.chat.completions.create(
        model="genchi/fast", messages=[{"role": "user", "content": "hello"}]
    )
    assert completion.choices[0].message.content == "ok"

    stream = client.chat.completions.create(
        model="genchi/fast",
        messages=[{"role": "user", "content": "hello"}],
        stream=True,
    )
    assert "".join(chunk.choices[0].delta.content or "" for chunk in stream) == "ok"
    assert [model.id for model in client.models.list().data] == ["genchi/fast"]

print("OpenAI Python SDK compatibility passed")
