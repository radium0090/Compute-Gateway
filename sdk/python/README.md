# RAX Compute Gateway Python SDK

Thin, typed Python client for RAX Compute Gateway's OpenAI-compatible API.

```python
from rax_compute_gateway import RaxComputeGateway

client = RaxComputeGateway(api_key="local-development-key", base_url="http://localhost:8080/v1")
response = client.chat.completions.create(
    model="rax/fast",
    messages=[{"role": "user", "content": "Hello"}],
)
```

Streaming iterators close their HTTP response when the iterator completes or is
closed early:

```python
stream = client.chat.completions.stream(
    model="rax/fast",
    messages=[{"role": "user", "content": "Count to three"}],
)
try:
    for event in stream:
        print(event["choices"][0]["delta"].get("content", ""), end="")
finally:
    stream.close()
```

`RCG_API_KEY`, `RCG_BASE_URL`, `RCG_TIMEOUT_SECONDS`, and
`RCG_MAX_RETRIES` provide environment defaults. Constructor arguments take
precedence.
