# Genchi Python SDK

Thin, typed Python client for Genchi's OpenAI-compatible API.

```python
from genchi import Genchi

client = Genchi(api_key="local-development-key", base_url="http://localhost:8080/v1")
response = client.chat.completions.create(
    model="genchi/fast",
    messages=[{"role": "user", "content": "Hello"}],
)
```

Streaming iterators close their HTTP response when the iterator completes or is
closed early:

```python
stream = client.chat.completions.stream(
    model="genchi/fast",
    messages=[{"role": "user", "content": "Count to three"}],
)
try:
    for event in stream:
        print(event["choices"][0]["delta"].get("content", ""), end="")
finally:
    stream.close()
```

`GENCHI_API_KEY`, `GENCHI_BASE_URL`, `GENCHI_TIMEOUT_SECONDS`, and
`GENCHI_MAX_RETRIES` provide environment defaults. Constructor arguments take
precedence.
