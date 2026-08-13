import { describe, expect, it } from 'vitest';

import { loadConfig } from '@rax-digital/config';
import { createLogger, TelemetryLifecycle } from '@rax-digital/observability';

import { buildGateway } from './app.js';

const config = loadConfig({
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://rcg:fake@localhost:5432/compute_gateway',
  RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met');
}

describe('request telemetry lifecycle', () => {
  it('decrements active requests when a streaming client disconnects', async () => {
    const telemetry = new TelemetryLifecycle({
      environment: 'test',
      serviceVersion: 'test-version',
      commitSha: 'test-commit',
      metricsEnabled: true,
    });
    telemetry.start();
    const metricsRequestHandler = telemetry.metricsRequestHandler();
    expect(metricsRequestHandler).toBeDefined();
    const app = await buildGateway({
      config,
      logger: createLogger({ environment: 'test', level: 'error' }),
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
      ...(metricsRequestHandler === undefined ? {} : { metricsRequestHandler }),
      chatCompletionService: {
        execute: () => Promise.reject(new Error('not used')),
        executeStream: ({ signal }) =>
          Promise.resolve({
            ok: true,
            stream: (async function* () {
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
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Gateway did not expose a TCP address');
      }
      const baseUrl = `http://127.0.0.1:${String(address.port)}`;
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer fake-client-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'rax/fast',
          messages: [{ role: 'user', content: 'disconnect test' }],
          stream: true,
        }),
        signal: controller.signal,
      });
      await response.body?.getReader().read();
      controller.abort();

      await eventually(async () => {
        const metrics = await fetch(`${baseUrl}/metrics`).then(async (result) =>
          result.text(),
        );
        return metrics.includes(
          'rcg_active_requests{route="/v1/chat/completions"} 0',
        );
      });
    } finally {
      await app.close();
      await telemetry.stop();
    }
  });
});
