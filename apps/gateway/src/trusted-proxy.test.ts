import { describe, expect, it } from 'vitest';

import { loadConfig } from '@rax-digital/config';
import { createLogger } from '@rax-digital/observability';

import { buildGateway } from './app.js';

describe('production proxy trust', () => {
  it('uses the forwarded address from Caddy, but not an untrusted peer', async () => {
    const app = await buildGateway({
      config: loadConfig({
        RCG_ENVIRONMENT: 'production',
        RCG_DATABASE_URL:
          'postgresql://rcg:fake@postgres.invalid:5432/compute_gateway',
        RCG_REDIS_URL: 'redis://redis:6379',
        RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
        RCG_TRUST_PROXY_CIDRS: '10.249.254.2/32',
      }),
      logger: createLogger({ environment: 'test', level: 'error' }),
      readinessProbe: { check: () => Promise.resolve({ ready: true }) },
    });
    app.get('/test/client-ip', (request) => ({ ip: request.ip }));
    try {
      const inject = (remoteAddress: string) =>
        app.inject({
          url: '/test/client-ip',
          remoteAddress,
          headers: { 'x-forwarded-for': '198.51.100.27' },
        });
      const trusted = await inject('10.249.254.2');
      const untrusted = await inject('10.249.254.3');
      expect(trusted.statusCode).toBe(200);
      expect(trusted.json()).toEqual({ ip: '198.51.100.27' });
      expect(untrusted.statusCode).toBe(200);
      expect(untrusted.json()).toEqual({ ip: '10.249.254.3' });
    } finally {
      await app.close();
    }
  });
});
