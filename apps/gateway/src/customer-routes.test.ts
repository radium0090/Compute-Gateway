import { describe, expect, it, vi } from 'vitest';

import type {
  CustomerLoginResult,
  CustomerPrincipal,
} from '@rax-digital/application';
import { loadConfig } from '@rax-digital/config';
import {
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  customerUserId,
  tenantId,
} from '@rax-digital/domain';
import { createLogger } from '@rax-digital/observability';

import { buildGateway } from './app.js';
import type { CustomerRouteService } from './customer-routes.js';

const origin = 'https://gateway.example.com';
const sessionToken = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const actor: CustomerPrincipal = {
  id: customerUserId('00000000-0000-4000-8000-000000000001'),
  tenantId: tenantId('00000000-0000-4000-8000-000000000002'),
  email: 'owner@example.com',
  displayName: 'Example Owner',
};
const login: CustomerLoginResult = {
  ok: true,
  sessionToken,
  csrfToken,
  expiresAt: new Date('2026-11-20T00:00:00.000Z'),
  principal: actor,
};
const config = loadConfig({
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://rcg:fake@localhost:5432/compute_gateway',
  RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});
const logger = createLogger({ environment: 'test', level: 'error' });

function service(): CustomerRouteService {
  return {
    register: vi.fn(() => Promise.resolve()),
    verifyEmail: vi.fn(() => Promise.resolve(true)),
    resendVerification: vi.fn(() => Promise.resolve()),
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
    requestPasswordReset: vi.fn(() => Promise.resolve()),
    resetPassword: vi.fn(() => Promise.resolve(true)),
    dashboard: vi.fn(() => Promise.resolve({ entitlements: null, keys: [] })),
    createApiKey: vi.fn(() =>
      Promise.reject(new Error('not used in this fixture')),
    ),
    revokeApiKey: vi.fn(() => Promise.resolve(true)),
    createBusinessInquiry: vi.fn(() => Promise.resolve()),
  };
}

function gateway(value = service(), registrationEnabled = true) {
  return buildGateway({
    config,
    logger,
    readinessProbe: { check: () => Promise.resolve({ ready: true }) },
    customer: {
      service: value,
      origin,
      sessionTtlMs: 8 * 60 * 60 * 1_000,
      registrationEnabled,
    },
  });
}

describe('customer and product routes', () => {
  it('serves the product site with a restrictive policy', async () => {
    const app = await gateway();
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('One stable API.');
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    const privacy = await app.inject({
      method: 'GET',
      url: '/legal/privacy',
    });
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain('Privacy notice');
    await app.close();
  });

  it('accepts same-origin inquiries and rejects foreign origins', async () => {
    const value = service();
    const app = await gateway(value);
    const body = {
      name: 'Customer',
      email: 'customer@example.com',
      message: 'We need a private deployment.',
      accepted_privacy: true,
    };
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/inquiries',
      headers: { origin: 'https://attacker.example' },
      payload: body,
    });
    expect(rejected.statusCode).toBe(403);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/inquiries',
      headers: { origin },
      payload: body,
    });
    expect(accepted.statusCode).toBe(202);
    expect(value.createBusinessInquiry).toHaveBeenCalledOnce();
    const trapped = await app.inject({
      method: 'POST',
      url: '/api/inquiries',
      headers: { origin },
      payload: { ...body, website: 'https://spam.example' },
    });
    expect(trapped.statusCode).toBe(204);
    expect(value.createBusinessInquiry).toHaveBeenCalledOnce();
    await app.close();
  });

  it('keeps public registration behind an operator switch', async () => {
    const value = service();
    const app = await gateway(value, false);
    const response = await app.inject({
      method: 'POST',
      url: '/console/api/register',
      headers: { origin },
      payload: {
        email: 'customer@example.com',
        display_name: 'Customer',
        organization_name: 'Example',
        password: 'a secure password',
        accepted_terms: true,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(value.register).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses a host-only customer cookie and requires CSRF for mutations', async () => {
    const value = service();
    const app = await gateway(value);
    const response = await app.inject({
      method: 'POST',
      url: '/console/api/login',
      headers: { origin },
      payload: { email: actor.email, password: 'a secure password' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain(
      '__Host-rcg_customer_session=',
    );
    expect(response.headers['set-cookie']).toContain('HttpOnly');

    const rejected = await app.inject({
      method: 'DELETE',
      url: '/console/api/api-keys/00000000-0000-4000-8000-000000000010',
      headers: {
        origin,
        cookie: `__Host-rcg_customer_session=${sessionToken}`,
      },
    });
    expect(rejected.statusCode).toBe(401);
    const accepted = await app.inject({
      method: 'DELETE',
      url: '/console/api/api-keys/00000000-0000-4000-8000-000000000010',
      headers: {
        origin,
        cookie: `__Host-rcg_customer_session=${sessionToken}`,
        'x-rcg-csrf-token': csrfToken,
      },
    });
    expect(accepted.statusCode).toBe(204);
    await app.close();
  });

  it('serves the complete verified-account lifecycle without exposing key hashes', async () => {
    const value = service();
    value.dashboard = vi.fn(() =>
      Promise.resolve({
        entitlements: {
          tenantId: actor.tenantId,
          status: 'active' as const,
          planCode: 'private_beta',
          policy: {
            allowedModelPatterns: ['rax/*'],
            allowStreaming: true,
            allowTools: false,
            requestsPerMinute: 30,
            maxConcurrentRequests: 3,
            maxRequestTokens: 4_096,
            maxOutputTokens: 512,
          },
          maxActiveApiKeys: 2,
          keyTtlDays: 30,
          createdAt: new Date('2026-11-19T00:00:00.000Z'),
          updatedAt: new Date('2026-11-19T00:00:00.000Z'),
        },
        keys: [],
      }),
    );
    value.createApiKey = vi.fn(() =>
      Promise.resolve({
        credential: 'rcg_prod_public_secret-shown-once',
        apiKey: {
          id: apiKeyId('00000000-0000-4000-8000-000000000010'),
          publicId: apiKeyPublicId('customer-public-id'),
          keyHash: apiKeyHash('a'.repeat(64)),
          tenantId: actor.tenantId,
          name: 'production app',
          environment: 'production' as const,
          status: 'active' as const,
          policy: {
            allowedModelPatterns: ['rax/*'],
            allowStreaming: true,
            allowTools: false,
            requestsPerMinute: 30,
            maxConcurrentRequests: 3,
          },
          createdAt: new Date('2026-11-19T00:00:00.000Z'),
          expiresAt: new Date('2026-12-19T00:00:00.000Z'),
        },
      }),
    );
    const app = await gateway(value);
    const register = await app.inject({
      method: 'POST',
      url: '/console/api/register',
      headers: { origin },
      payload: {
        email: actor.email,
        display_name: actor.displayName,
        organization_name: 'Example',
        password: 'a secure password',
        accepted_terms: true,
      },
    });
    const resend = await app.inject({
      method: 'POST',
      url: '/console/api/verification/resend',
      headers: { origin },
      payload: { email: actor.email },
    });
    const verify = await app.inject({
      method: 'POST',
      url: '/console/api/verification/confirm',
      headers: { origin },
      payload: { token: 'v'.repeat(43) },
    });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/console/api/login',
      headers: { origin },
      payload: { email: actor.email, password: 'a secure password' },
    });
    const session = await app.inject({
      method: 'GET',
      url: '/console/api/session',
      headers: { cookie: `__Host-rcg_customer_session=${sessionToken}` },
    });
    const resetRequest = await app.inject({
      method: 'POST',
      url: '/console/api/password-reset/request',
      headers: { origin },
      payload: { email: actor.email },
    });
    const reset = await app.inject({
      method: 'POST',
      url: '/console/api/password-reset/confirm',
      headers: { origin },
      payload: { token: 'r'.repeat(43), password: 'a new secure password' },
    });
    const dashboard = await app.inject({
      method: 'GET',
      url: '/console/api/dashboard',
      headers: { cookie: `__Host-rcg_customer_session=${sessionToken}` },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/console/api/api-keys',
      headers: {
        cookie: `__Host-rcg_customer_session=${sessionToken}`,
        origin,
        'x-rcg-csrf-token': csrfToken,
      },
      payload: { name: 'production app' },
    });
    const logout = await app.inject({
      method: 'POST',
      url: '/console/api/logout',
      headers: {
        cookie: `__Host-rcg_customer_session=${sessionToken}`,
        origin,
        'x-rcg-csrf-token': csrfToken,
      },
    });

    expect(register.statusCode).toBe(202);
    expect(resend.statusCode).toBe(202);
    expect(verify.statusCode).toBe(200);
    expect(loginResponse.statusCode).toBe(200);
    expect(session.statusCode).toBe(200);
    expect(resetRequest.statusCode).toBe(202);
    expect(reset.statusCode).toBe(200);
    expect(dashboard.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    expect(created.body).toContain('rcg_prod_public_secret-shown-once');
    expect(created.body).not.toContain('key_hash');
    expect(logout.statusCode).toBe(204);
    expect(value.register).toHaveBeenCalledOnce();
    expect(value.resendVerification).toHaveBeenCalledOnce();
    expect(value.requestPasswordReset).toHaveBeenCalledOnce();
    expect(value.createApiKey).toHaveBeenCalledOnce();
    expect(value.logout).toHaveBeenCalledOnce();
    await app.close();
  });
});
