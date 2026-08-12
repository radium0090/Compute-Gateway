import { RaxComputeGateway } from '../../sdk/typescript/dist/index.js';

const client = new RaxComputeGateway();
const completion = await client.chat.completions.create({
  model: 'rax/fast',
  messages: [{ role: 'user', content: 'Hello from Node.js' }],
});

process.stdout.write(`${completion.choices[0]?.message.content ?? ''}\n`);

const stream = await client.chat.completions.stream({
  model: 'rax/fast',
  messages: [{ role: 'user', content: 'Count to three' }],
});
const iterator = stream[Symbol.asyncIterator]();
try {
  for (;;) {
    const event = await iterator.next();
    if (event.done) break;
    process.stdout.write(event.value.choices[0]?.delta.content ?? '');
  }
  process.stdout.write('\n');
} finally {
  await iterator.return?.();
}
