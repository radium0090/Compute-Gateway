import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '@genchi/config';
import { createLogger } from '@genchi/observability';

import { buildGateway } from './app.js';

const config = loadConfig({
  GENCHI_ENVIRONMENT: 'test',
  GENCHI_DATABASE_URL: 'postgresql://genchi:fake@localhost:5432/genchi',
  GENCHI_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function addressFor(app: Awaited<ReturnType<typeof buildGateway>>) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gateway did not expose a TCP address');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for stream cleanup');
}

describe('network streaming lifecycle', () => {
  it('preserves event order and emits one terminal marker', async () => {
    const app = await buildGateway({
      config,
      logger: createLogger({ environment: 'test', level: 'error' }),
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
      chatCompletionService: {
        execute: () => Promise.reject(new Error('not used')),
        executeStream: () =>
          Promise.resolve({
            ok: true,
            stream: (async function* () {
              await Promise.resolve();
              yield {
                choice: { delta: { content: 'first' }, finishReason: null },
              };
              yield {
                choice: { delta: { content: 'second' }, finishReason: 'stop' },
              };
            })(),
            route: {
              providerRef: 'test',
              provider: 'openai',
              providerModel: 'test-model',
            },
            attempts: 1,
          }),
      },
    });
    apps.push(app);
    const response = await fetch(
      `${await addressFor(app)}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer fake-client-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'genchi/fast',
          messages: [{ role: 'user', content: 'stream order test' }],
          stream: true,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.indexOf('first')).toBeLessThan(body.indexOf('second'));
    expect(body.match(/data: \[DONE\]/gu)).toHaveLength(1);
  });

  it('propagates a client disconnect and closes the provider iterator', async () => {
    let providerSignal: AbortSignal | undefined;
    let iteratorClosed = false;
    const app = await buildGateway({
      config,
      logger: createLogger({ environment: 'test', level: 'error' }),
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
      chatCompletionService: {
        execute: () => Promise.reject(new Error('not used')),
        executeStream: ({ signal }) => {
          providerSignal = signal;
          return Promise.resolve({
            ok: true,
            stream: (async function* () {
              try {
                yield {
                  choice: { delta: { content: 'first' }, finishReason: null },
                };
                await new Promise<void>((resolve) => {
                  if (signal.aborted) resolve();
                  else
                    signal.addEventListener(
                      'abort',
                      () => {
                        resolve();
                      },
                      { once: true },
                    );
                });
              } finally {
                iteratorClosed = true;
              }
            })(),
            route: {
              providerRef: 'test',
              provider: 'openai',
              providerModel: 'test-model',
            },
            attempts: 1,
          });
        },
      },
    });
    apps.push(app);
    const controller = new AbortController();
    const response = await fetch(
      `${await addressFor(app)}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer fake-client-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'genchi/fast',
          messages: [{ role: 'user', content: 'disconnect test' }],
          stream: true,
        }),
        signal: controller.signal,
      },
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    controller.abort();
    await eventually(() => providerSignal?.aborted === true && iteratorClosed);
    expect(providerSignal?.aborted).toBe(true);
    expect(iteratorClosed).toBe(true);
  });
});
