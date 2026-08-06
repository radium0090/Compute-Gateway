# SDKs

## Strategy

Genchi first-class SDKs are thin, typed clients for the public API. The gateway
also supports existing OpenAI SDKs by changing the base URL. SDKs MUST not hide
routing decisions or implement gateway retry logic by default.

MVP languages:

- TypeScript (`@genchi-ai/sdk`)
- Python (`genchi-ai`)

Package names are provisional until registry ownership is verified.

The preview implementations live in `sdk/typescript` and `sdk/python`. The
TypeScript preview follows the repository's Node.js 24 runtime and the Python
package supports Python 3.10+. They are not published until package ownership
and the release candidate are approved.

## TypeScript example

```ts
import { Genchi } from "@genchi-ai/sdk";

const genchi = new Genchi({
  apiKey: process.env.GENCHI_API_KEY!,
  baseUrl: "http://localhost:8080/v1",
});

const response = await genchi.chat.completions.create({
  model: "genchi/fast",
  messages: [{ role: "user", content: "Hello" }],
});
```

## Python example

```python
import os
from genchi import Genchi

client = Genchi(
    api_key=os.environ["GENCHI_API_KEY"],
    base_url="http://localhost:8080/v1",
)

response = client.chat.completions.create(
    model="genchi/fast",
    messages=[{"role": "user", "content": "Hello"}],
)
```

## Streaming

Both SDKs expose streaming as an iterator/async iterator and close the network
connection when iteration is cancelled. Examples MUST demonstrate cleanup.

```ts
const stream = await genchi.chat.completions.stream({
  model: "genchi/fast",
  messages: [{ role: "user", content: "Count to three" }],
});

for await (const event of stream) {
  process.stdout.write(event.choices[0]?.delta?.content ?? "");
}
```

## Generation and handwritten code

OpenAPI generates the tracked TypeScript and Python model types. Handwritten
layers provide transport, configuration, streaming ergonomics, errors, and
documentation. Generated code is reproducible and MUST NOT be manually edited.

The release pipeline fails when generation changes tracked output.

## Configuration

Constructor arguments override environment variables:

| Setting | Environment | Default |
| --- | --- | --- |
| API key | `GENCHI_API_KEY` | required |
| Base URL | `GENCHI_BASE_URL` | `http://localhost:8080/v1` |
| Timeout | `GENCHI_TIMEOUT_SECONDS` | 60 |
| Max network retries | `GENCHI_MAX_RETRIES` | 1 for connection/429/5xx only |

SDK retries are conservative because the gateway already applies policy.
Streaming requests are never retried after bytes are received. Users can
disable SDK retry with `maxRetries: 0`.

## Error surface

SDKs map the public envelope to typed errors while preserving HTTP status,
Genchi code, request ID, and retryable flag. They never expose provider secrets
or depend on provider SDK error classes.

## Versioning

SDKs follow Semantic Versioning independently from the gateway. A supported
gateway declares the OpenAPI contract version it implements. The preview CI
tests the tracked SDK version against the current gateway contract.

## Contributor checks

```bash
pnpm sdk:generate
pnpm sdk:check
pnpm sdk:test
```

`sdk:check` regenerates both tracked type surfaces from OpenAPI and rejects a
diff. TypeScript uses `openapi-typescript`; Python's deterministic generator is
kept in `scripts/generate-python-sdk.ts`. Generated files are never hand-edited.

## OpenAI SDK compatibility

Compatibility examples are maintained for current supported OpenAI Python and
JavaScript SDK majors. Those third-party SDK versions are test inputs, not
Genchi runtime dependencies.

The deterministic suite exercises pinned current OpenAI Node and Python SDKs.
A protected, manual workflow sends bounded completion and streaming requests
through the Node SDK to each real provider adapter; the provider-independent
wire format is also parsed by the Python SDK fixture.
