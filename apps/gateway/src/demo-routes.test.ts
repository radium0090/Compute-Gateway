import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { DemoClaimError } from '@rax-digital/application';

import {
  DemoStartLimiter,
  registerDemoRoutes,
  type DemoRouteService,
} from './demo-routes.js';

const origin = 'https://api.example.com';
const expiresAt = new Date(Date.now() + 300_000);

function service(): DemoRouteService {
  return {
    begin: vi.fn(() =>
      Promise.resolve({
        state: 'state-token',
        codeVerifier: 'verifier-token',
        authorizationUrl: 'https://github.com/login/oauth/authorize?safe=1',
        expiresAt,
      }),
    ),
    complete: vi.fn(() =>
      Promise.resolve({
        credential: 'rcg_test_public-secret-shown-once',
        expiresAt,
        model: 'rax/fast',
        maxOutputTokens: 64,
      }),
    ),
  };
}

async function app(value = service(), limiter?: DemoStartLimiter) {
  const gateway = Fastify({ logger: false });
  await registerDemoRoutes(gateway, {
    service: value,
    origin,
    ...(limiter === undefined ? {} : { startLimiter: limiter }),
  });
  return gateway;
}

describe('hosted demo routes', () => {
  it('serves a no-store page with strict browser security headers', async () => {
    const gateway = await app();
    const response = await gateway.inject({ method: 'GET', url: '/demo' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('v0.3.0');
    expect(response.body).toContain('Claim a five-minute key');
    expect(response.body).toContain('rax/agent');
    expect(response.body).toContain('Public five-minute keys remain text-only');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(response.body).not.toContain('rcg_test_');
    await gateway.close();
  });

  it('starts GitHub OAuth with short-lived hardened state cookies', async () => {
    const gateway = await app();
    const response = await gateway.inject({
      method: 'GET',
      url: '/demo/github',
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('github.com');
    const cookies = response.headers['set-cookie'];
    expect(cookies).toHaveLength(2);
    expect(String(cookies)).toContain('__Host-rcg_demo_state=state-token');
    expect(String(cookies)).toContain(
      '__Host-rcg_demo_verifier=verifier-token',
    );
    expect(String(cookies)).toContain('Secure');
    expect(String(cookies)).toContain('HttpOnly');
    expect(String(cookies)).toContain('SameSite=Lax');
    await gateway.close();
  });

  it('displays the credential once in a ready-to-run curl command', async () => {
    const value = service();
    const gateway = await app(value);
    const response = await gateway.inject({
      method: 'GET',
      url: '/demo/callback?code=github-code&state=state-token',
      headers: {
        cookie:
          '__Host-rcg_demo_state=state-token; __Host-rcg_demo_verifier=verifier-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`${origin}/v1/chat/completions`);
    expect(response.body).toContain('rcg_test_public-secret-shown-once');
    expect(response.body).toContain('does not allow streaming or Agent tools');
    expect(response.headers.location).toBeUndefined();
    expect(value.complete).toHaveBeenCalledWith({
      code: 'github-code',
      returnedState: 'state-token',
      cookieState: 'state-token',
      codeVerifier: 'verifier-token',
    });
    await gateway.close();
  });

  it('rejects missing OAuth cookies without calling the claim service', async () => {
    const value = service();
    const gateway = await app(value);
    const response = await gateway.inject({
      method: 'GET',
      url: '/demo/callback?code=github-code&state=state-token',
    });

    expect(response.statusCode).toBe(400);
    expect(value.complete).not.toHaveBeenCalled();
    await gateway.close();
  });

  it('maps controlled claim failures without leaking details', async () => {
    const value = service();
    vi.mocked(value.complete).mockRejectedValue(
      new DemoClaimError('already_claimed'),
    );
    const gateway = await app(value);
    const response = await gateway.inject({
      method: 'GET',
      url: '/demo/callback?code=github-code&state=state-token',
      headers: {
        cookie:
          '__Host-rcg_demo_state=state-token; __Host-rcg_demo_verifier=verifier-token',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('already claimed');
    expect(response.body).not.toContain('github-code');
    await gateway.close();
  });

  it('limits OAuth starts before creating database state', async () => {
    const value = service();
    const limiter = new DemoStartLimiter(1, 60_000, () => 1);
    const gateway = await app(value, limiter);

    expect(
      (await gateway.inject({ method: 'GET', url: '/demo/github' })).statusCode,
    ).toBe(302);
    expect(
      (await gateway.inject({ method: 'GET', url: '/demo/github' })).statusCode,
    ).toBe(429);
    expect(value.begin).toHaveBeenCalledTimes(1);
    await gateway.close();
  });
});
