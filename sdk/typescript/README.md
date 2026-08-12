# RAX Compute Gateway TypeScript SDK preview

```ts
import { RAX Compute Gateway } from '@rax-digital/compute-gateway-sdk';

const client = new RaxComputeGateway({
  apiKey: process.env.RCG_API_KEY,
  baseUrl: 'http://localhost:8080/v1',
});

const completion = await client.chat.completions.create({
  model: 'rax/fast',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Generated transport types live in `src/generated`; the handwritten client owns
timeouts, conservative pre-response retries, canonical errors, and SSE cleanup.
