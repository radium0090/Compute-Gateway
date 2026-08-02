import { describe, expect, it } from 'vitest';

import { loadConfig } from '@genchi/config';
import { createLogger } from '@genchi/observability';

import { buildGateway } from './app.js';

const config = loadConfig({
  GENCHI_ENVIRONMENT: 'test',
  GENCHI_DATABASE_URL: 'postgresql://genchi:fake@localhost:5432/genchi',
  GENCHI_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});

const logger = createLogger({ environment: 'test', level: 'error' });

describe('health routes', () => {
  it('reports liveness independently of dependencies', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe: { check: () => Promise.resolve({ ready: false }) },
    });

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toMatch(/^req_/);
    await app.close();
  });

  it('reports ready only when PostgreSQL is reachable', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { postgres: 'ok' },
    });
    await app.close();
  });

  it('returns a safe 503 without infrastructure details when unready', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe: { check: () => Promise.resolve({ ready: false }) },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      checks: { postgres: 'error' },
    });
    expect(response.body).not.toContain('postgresql://');
    await app.close();
  });

  it('accepts only bounded request IDs from callers', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
    });

    const accepted = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'request_12345' },
    });
    const replaced = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'contains spaces and is invalid' },
    });

    expect(accepted.headers['x-request-id']).toBe('request_12345');
    expect(replaced.headers['x-request-id']).toMatch(/^req_/);
    await app.close();
  });

  it('accepts a one-character safe request ID', async () => {
    const app = await buildGateway({
      config,
      logger,
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'a' },
    });
    expect(response.headers['x-request-id']).toBe('a');
    await app.close();
  });
});
