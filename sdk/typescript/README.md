# Genchi TypeScript SDK preview

```ts
import { Genchi } from '@genchi-ai/sdk';

const client = new Genchi({
  apiKey: process.env.GENCHI_API_KEY,
  baseUrl: 'http://localhost:8080/v1',
});

const completion = await client.chat.completions.create({
  model: 'genchi/fast',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Generated transport types live in `src/generated`; the handwritten client owns
timeouts, conservative pre-response retries, canonical errors, and SSE cleanup.
