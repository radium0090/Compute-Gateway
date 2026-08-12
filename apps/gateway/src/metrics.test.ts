import { describe, expect, it } from 'vitest';

import { loadConfig } from '@rax-digital/config';
import { createLogger, TelemetryLifecycle } from '@rax-digital/observability';

import { buildGateway } from './app.js';

const config = loadConfig({
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://rcg:fake@localhost:5432/compute_gateway',
  RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});

describe('metrics endpoint', () => {
  it('serves process-local OpenTelemetry metrics without secret fields', async () => {
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
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('rcg_build_info');
      expect(response.body).toContain('test-version');
      expect(response.body).not.toContain('authorization');
    } finally {
      await app.close();
      await telemetry.stop();
    }
  });

  it('does not expose the route when metrics are disabled', async () => {
    const app = await buildGateway({
      config,
      logger: createLogger({ environment: 'test', level: 'error' }),
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
    });
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
