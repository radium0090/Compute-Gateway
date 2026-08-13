import { describe, expect, it, vi } from 'vitest';

import type {
  AdminLoginSuccess,
  AdminPrincipal,
} from '@rax-digital/application';
import {
  adminUserId,
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  tenantId,
} from '@rax-digital/domain';
import { loadConfig } from '@rax-digital/config';
import { createLogger } from '@rax-digital/observability';

import { buildGateway } from './app.js';
import { AdminLoginLimiter, type AdminRouteService } from './admin-routes.js';

const origin = 'https://admin.example.com';
const sessionToken = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const actor: AdminPrincipal = {
  id: adminUserId('00000000-0000-4000-8000-000000000001'),
  email: 'owner@rax-digital.com',
  displayName: 'RAX Owner',
  mustChangePassword: false,
};
const login: AdminLoginSuccess = {
  ok: true,
  sessionToken,
  csrfToken,
  expiresAt: new Date('2026-08-14T00:00:00.000Z'),
  principal: actor,
};

const config = loadConfig({
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://rcg:fake@localhost:5432/compute_gateway',
  RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});
const logger = createLogger({ environment: 'test', level: 'error' });

function service(): AdminRouteService {
  return {
    login: vi.fn(() => Promise.resolve(login)),
    authenticate: vi.fn((token: string) =>
      Promise.resolve(token === sessionToken ? actor : null),
    ),
    authorizeMutation: vi.fn((token: string, csrf: string) =>
      Promise.resolve(
        token === sessionToken && csrf === csrfToken ? actor : null,
      ),
    ),
    logout: vi.fn(() => Promise.resolve()),
    changePassword: vi.fn(() => Promise.resolve(true)),
    dashboardSummary: vi.fn(() =>
      Promise.resolve({
        tenantCount: 1,
        activeTenantCount: 1,
        apiKeyCount: 1,
        activeApiKeyCount: 1,
        apiKeysUsedSince: 1,
      }),
    ),
    listTenants: vi.fn(() =>
      Promise.resolve([
        {
          id: tenantId('00000000-0000-4000-8000-000000000010'),
          name: 'Customer Alpha',
          status: 'active' as const,
          createdAt: new Date('2026-08-13T00:00:00.000Z'),
          updatedAt: new Date('2026-08-13T00:00:00.000Z'),
        },
      ]),
    ),
    createTenant: vi.fn(() =>
      Promise.resolve({
        id: tenantId('00000000-0000-4000-8000-000000000011'),
        name: 'New tenant',
        status: 'active' as const,
        createdAt: new Date('2026-08-13T00:00:00.000Z'),
        updatedAt: new Date('2026-08-13T00:00:00.000Z'),
      }),
    ),
    listApiKeys: vi.fn(() =>
      Promise.resolve([
        {
          id: apiKeyId('00000000-0000-4000-8000-000000000020'),
          publicId: apiKeyPublicId('public-id-1234'),
          tenantId: tenantId('00000000-0000-4000-8000-000000000010'),
          tenantName: 'Customer Alpha',
          name: 'production app',
          environment: 'production' as const,
          status: 'active' as const,
          policy: {
            allowedModelPatterns: ['rax/*'],
            allowStreaming: true,
            allowTools: false,
            requestsPerMinute: 60,
            maxConcurrentRequests: 10,
          },
          createdAt: new Date('2026-08-13T00:00:00.000Z'),
          expiresAt: null,
          lastUsedAt: null,
        },
      ]),
    ),
    createApiKey: vi.fn(() =>
      Promise.resolve({
        credential: 'rcg_prod_publicid_secret-value-shown-once',
        apiKey: {
          id: apiKeyId('00000000-0000-4000-8000-000000000020'),
          publicId: apiKeyPublicId('public-id-1234'),
          keyHash: apiKeyHash('a'.repeat(64)),
          tenantId: tenantId('00000000-0000-4000-8000-000000000010'),
          name: 'production app',
          environment: 'production' as const,
          status: 'active' as const,
          policy: {
            allowedModelPatterns: ['rax/*'],
            allowStreaming: true,
            allowTools: false,
            requestsPerMinute: 60,
            maxConcurrentRequests: 10,
          },
          createdAt: new Date('2026-08-13T00:00:00.000Z'),
          expiresAt: null,
        },
      }),
    ),
    revokeApiKey: vi.fn(() => Promise.resolve(true)),
  };
}

async function app(value = service()) {
  return buildGateway({
    config,
    logger,
    readinessProbe: {
      check: () =>
        Promise.resolve({
          ready: true,
          checks: { postgres: 'ok' as const, redis: 'ok' as const },
        }),
    },
    admin: { service: value, origin, sessionTtlMs: 28_800_000 },
  });
}

const authenticatedHeaders = {
  cookie: `__Host-rcg_admin_session=${sessionToken}`,
  origin,
  'x-rcg-csrf-token': csrfToken,
};

describe('administrator routes', () => {
  it('serves the framework-free console with strict browser security headers', async () => {
    const gateway = await app();
    const response = await gateway.inject({ method: 'GET', url: '/admin/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('RAX Compute Gateway');
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    await gateway.close();
  });

  it('serves redirect, stylesheet, and JavaScript assets from the same origin', async () => {
    const gateway = await app();
    const redirect = await gateway.inject({ method: 'GET', url: '/admin' });
    const stylesheet = await gateway.inject({
      method: 'GET',
      url: '/admin/app.css',
    });
    const script = await gateway.inject({
      method: 'GET',
      url: '/admin/app.js',
    });

    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe('/admin/');
    expect(stylesheet.headers['content-type']).toContain('text/css');
    expect(script.headers['content-type']).toContain('text/javascript');
    await gateway.close();
  });

  it('rejects cross-origin login and sets a hardened cookie after success', async () => {
    const gateway = await app();
    const rejected = await gateway.inject({
      method: 'POST',
      url: '/admin/api/login',
      headers: { origin: 'https://attacker.example' },
      payload: { email: actor.email, password: 'temporary password 123' },
    });
    const accepted = await gateway.inject({
      method: 'POST',
      url: '/admin/api/login',
      headers: { origin },
      payload: { email: actor.email, password: 'temporary password 123' },
    });

    expect(rejected.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['set-cookie']).toContain(
      '__Host-rcg_admin_session=',
    );
    expect(accepted.headers['set-cookie']).toContain('Secure');
    expect(accepted.headers['set-cookie']).toContain('HttpOnly');
    expect(accepted.headers['set-cookie']).toContain('SameSite=Strict');
    expect(accepted.body).not.toContain('temporary password');
    await gateway.close();
  });

  it('requires both the session cookie and CSRF token for mutations', async () => {
    const gateway = await app();
    const missing = await gateway.inject({
      method: 'POST',
      url: '/admin/api/tenants',
      headers: { cookie: authenticatedHeaders.cookie, origin },
      payload: { name: 'New tenant' },
    });
    const accepted = await gateway.inject({
      method: 'POST',
      url: '/admin/api/tenants',
      headers: authenticatedHeaders,
      payload: { name: 'New tenant' },
    });

    expect(missing.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(201);
    await gateway.close();
  });

  it('returns health and content-free activity metadata to an authenticated admin', async () => {
    const gateway = await app();
    const response = await gateway.inject({
      method: 'GET',
      url: '/admin/api/dashboard',
      headers: { cookie: authenticatedHeaders.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      health: {
        ready: true,
        checks: { postgres: 'ok', redis: 'ok' },
      },
      summary: {
        tenant_count: 1,
        active_tenant_count: 1,
        api_key_count: 1,
        active_api_key_count: 1,
        api_keys_used_24h: 1,
      },
    });
    expect(response.body).not.toMatch(/prompt|completion|provider.*key/i);
    await gateway.close();
  });

  it('returns the current session and safe tenant/API-key lists', async () => {
    const gateway = await app();
    const session = await gateway.inject({
      method: 'GET',
      url: '/admin/api/session',
      headers: { cookie: authenticatedHeaders.cookie },
    });
    const tenants = await gateway.inject({
      method: 'GET',
      url: '/admin/api/tenants',
      headers: { cookie: authenticatedHeaders.cookie },
    });
    const keys = await gateway.inject({
      method: 'GET',
      url: '/admin/api/api-keys',
      headers: { cookie: authenticatedHeaders.cookie },
    });

    expect(session.statusCode).toBe(200);
    expect(session.body).toContain(actor.email);
    expect(tenants.body).toContain('Customer Alpha');
    expect(keys.body).toContain('public-id-1234');
    expect(keys.body).not.toContain('key_hash');
    expect(keys.body).not.toContain('credential');
    await gateway.close();
  });

  it('changes passwords, revokes sessions, and revokes API keys with CSRF', async () => {
    const value = service();
    const gateway = await app(value);
    const password = await gateway.inject({
      method: 'POST',
      url: '/admin/api/password',
      headers: authenticatedHeaders,
      payload: {
        current_password: 'temporary password 123',
        new_password: 'new secure password value',
      },
    });
    const revoke = await gateway.inject({
      method: 'POST',
      url: '/admin/api/api-keys/00000000-0000-4000-8000-000000000020/revoke',
      headers: authenticatedHeaders,
    });
    const logout = await gateway.inject({
      method: 'POST',
      url: '/admin/api/logout',
      headers: authenticatedHeaders,
    });

    expect(password.statusCode).toBe(200);
    expect(password.headers['set-cookie']).toContain('Max-Age=0');
    expect(revoke.statusCode).toBe(200);
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(value.changePassword).toHaveBeenCalledOnce();
    expect(value.revokeApiKey).toHaveBeenCalledOnce();
    expect(value.logout).toHaveBeenCalledOnce();
    await gateway.close();
  });

  it('blocks console operations until the temporary password is replaced', async () => {
    const value = service();
    value.authenticate = vi.fn(() =>
      Promise.resolve({ ...actor, mustChangePassword: true }),
    );
    const gateway = await app(value);
    const response = await gateway.inject({
      method: 'GET',
      url: '/admin/api/dashboard',
      headers: { cookie: authenticatedHeaders.cookie },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('password_change_required');
    await gateway.close();
  });

  it('returns a new API key exactly once from the create operation', async () => {
    const gateway = await app();
    const response = await gateway.inject({
      method: 'POST',
      url: '/admin/api/api-keys',
      headers: authenticatedHeaders,
      payload: {
        tenant_id: '00000000-0000-4000-8000-000000000010',
        name: 'production app',
        environment: 'production',
        allowed_model_patterns: ['rax/*'],
        allow_streaming: true,
        requests_per_minute: 60,
        max_concurrent_requests: 10,
        expires_at: null,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toContain(
      'rcg_prod_publicid_secret-value-shown-once',
    );
    expect(response.body).toContain('cannot be shown again');
    await gateway.close();
  });

  it('rate-limits authenticated control-plane routes independently of inference traffic', async () => {
    const gateway = await app();
    let response = await gateway.inject({
      method: 'GET',
      url: '/admin/api/session',
    });

    expect(response.statusCode).toBe(401);
    for (let attempt = 1; attempt <= 300; attempt += 1) {
      response = await gateway.inject({
        method: 'GET',
        url: '/admin/api/session',
      });
    }

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(response.body).toContain('The request rate limit was exceeded.');
    await gateway.close();
  });
});

describe('AdminLoginLimiter', () => {
  it('bounds anonymous password work and resets after the window', () => {
    let now = 0;
    const limiter = new AdminLoginLimiter(2, 1_000, () => now);
    expect(limiter.consume()).toEqual({ allowed: true });
    expect(limiter.consume()).toEqual({ allowed: true });
    expect(limiter.consume()).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    now = 1_001;
    expect(limiter.consume()).toEqual({ allowed: true });
  });
});
