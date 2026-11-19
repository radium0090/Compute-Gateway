import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  customerSessionId,
  customerTokenHash,
  customerUserId,
  tenantId,
  type ApiKey,
  type CustomerSession,
  type CustomerTenantEntitlements,
  type CustomerUser,
  type Tenant,
} from '@rax-digital/domain';

import {
  PostgresCustomerAuditRepository,
  PostgresCustomerControlRepository,
  PostgresCustomerIdentityRepository,
} from './customer-repository.js';
import { runMigrations } from './migrations.js';
import { createPostgresPool } from './postgres.js';

const databaseUrl = process.env.RCG_TEST_DATABASE_URL;
const describeIntegration =
  databaseUrl === undefined ? describe.skip : describe;

describeIntegration('PostgreSQL customer repositories', () => {
  const pool = createPostgresPool({
    databaseUrl:
      databaseUrl ?? 'postgresql://integration-test.invalid/compute_gateway',
    connectTimeoutMs: 5_000,
    maxConnections: 2,
  });
  const identities = new PostgresCustomerIdentityRepository(pool);
  const controls = new PostgresCustomerControlRepository(pool);
  const audits = new PostgresCustomerAuditRepository(pool);
  const now = new Date('2026-11-19T00:00:00.000Z');
  const selectedTenantId = tenantId(randomUUID());
  const userId = customerUserId(randomUUID());
  const inquiryId = randomUUID();
  const tenant: Tenant = {
    id: selectedTenantId,
    name: `customer-${randomUUID()}`,
    status: 'disabled',
    createdAt: now,
    updatedAt: now,
  };
  const user: CustomerUser = {
    id: userId,
    tenantId: selectedTenantId,
    email: `customer-${randomUUID()}@example.com`,
    displayName: 'Customer Owner',
    passwordHash:
      'scrypt$v=1$N=32768$r=8$p=3$AAAAAAAAAAAAAAAAAAAAAA$bSiBtLmp2p10SfHCPaF2JTc6SdKodsv8cpvatDq-dok',
    status: 'pending_verification',
    emailVerifiedAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const entitlements: CustomerTenantEntitlements = {
    tenantId: selectedTenantId,
    status: 'pending',
    planCode: 'private_beta',
    policy: {
      allowedModelPatterns: [],
      allowStreaming: false,
      allowTools: false,
      requestsPerMinute: 1,
      maxConcurrentRequests: 1,
      maxRequestTokens: 2_048,
      maxOutputTokens: 256,
    },
    maxActiveApiKeys: 1,
    keyTtlDays: 30,
    createdAt: now,
    updatedAt: now,
  };
  const verificationHash = customerTokenHash('a'.repeat(64));

  beforeAll(async () => {
    await runMigrations(pool, 'db/migrations');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM customer_audit_events WHERE tenant_id = $1', [
      selectedTenantId,
    ]);
    await pool.query('DELETE FROM business_inquiries WHERE id = $1', [
      inquiryId,
    ]);
    await pool.query('DELETE FROM api_keys WHERE tenant_id = $1', [
      selectedTenantId,
    ]);
    await pool.query('DELETE FROM customer_users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [selectedTenantId]);
    await pool.end();
  });

  it('persists the complete customer identity, entitlement, key, and inquiry lifecycle', async () => {
    await expect(
      identities.createRegistration({
        tenant,
        user,
        entitlements,
        verification: {
          id: randomUUID(),
          userId,
          purpose: 'verify_email',
          tokenHash: verificationHash,
          createdAt: now,
          expiresAt: new Date('2026-11-20T00:00:00.000Z'),
        },
      }),
    ).resolves.toBe('created');
    const duplicateTenantId = tenantId(randomUUID());
    const duplicateUserId = customerUserId(randomUUID());
    await expect(
      identities.createRegistration({
        tenant: {
          ...tenant,
          id: duplicateTenantId,
          name: `${tenant.name}-duplicate`,
        },
        user: {
          ...user,
          id: duplicateUserId,
          tenantId: duplicateTenantId,
        },
        entitlements: {
          ...entitlements,
          tenantId: duplicateTenantId,
        },
        verification: {
          id: randomUUID(),
          userId: duplicateUserId,
          purpose: 'verify_email',
          tokenHash: customerTokenHash('9'.repeat(64)),
          createdAt: now,
          expiresAt: new Date('2026-11-20T00:00:00.000Z'),
        },
      }),
    ).resolves.toBe('account_exists');
    await expect(
      pool.query('SELECT id FROM tenants WHERE id = $1', [duplicateTenantId]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(identities.findUserByEmail(user.email)).resolves.toEqual(user);
    await expect(
      identities.verifyEmail(
        verificationHash,
        new Date('2026-11-19T01:00:00.000Z'),
      ),
    ).resolves.toMatchObject({ status: 'active' });

    const session: CustomerSession = {
      id: customerSessionId(randomUUID()),
      userId,
      tokenHash: customerTokenHash('b'.repeat(64)),
      csrfTokenHash: customerTokenHash('c'.repeat(64)),
      createdAt: now,
      expiresAt: new Date('2026-11-19T08:00:00.000Z'),
      lastSeenAt: now,
    };
    await identities.createSession(session);
    await expect(
      identities.findSessionByTokenHash(
        session.tokenHash,
        new Date('2026-11-19T02:00:00.000Z'),
      ),
    ).resolves.toMatchObject({ session: { id: session.id } });

    const activeEntitlements: CustomerTenantEntitlements = {
      ...entitlements,
      status: 'active',
      policy: {
        ...entitlements.policy,
        allowedModelPatterns: ['rax/*'],
        allowStreaming: true,
      },
      updatedAt: new Date('2026-11-19T02:00:00.000Z'),
    };
    await expect(
      controls.setEntitlements({
        tenantId: selectedTenantId,
        tenantStatus: 'active',
        entitlements: activeEntitlements,
      }),
    ).resolves.toBe(true);
    await expect(controls.listCustomerAccounts()).resolves.toMatchObject([
      {
        tenantId: selectedTenantId,
        tenantStatus: 'active',
        entitlements: { status: 'active' },
      },
    ]);

    const key: ApiKey = {
      id: apiKeyId(randomUUID()),
      publicId: apiKeyPublicId(randomUUID().replaceAll('-', '').slice(0, 24)),
      keyHash: apiKeyHash('d'.repeat(64)),
      tenantId: selectedTenantId,
      name: 'customer key',
      environment: 'test',
      status: 'active',
      policy: activeEntitlements.policy,
      createdAt: now,
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    };
    await expect(
      controls.createApiKeyWithinEntitlements(key, now),
    ).resolves.toBe('created');
    await expect(
      controls.createApiKeyWithinEntitlements(
        {
          ...key,
          id: apiKeyId(randomUUID()),
          publicId: apiKeyPublicId(
            randomUUID().replaceAll('-', '').slice(0, 24),
          ),
          keyHash: apiKeyHash('e'.repeat(64)),
        },
        now,
      ),
    ).resolves.toBe('limit_reached');
    await expect(
      controls.countActiveApiKeys(selectedTenantId, now),
    ).resolves.toBe(1);
    await expect(controls.listApiKeys(selectedTenantId)).resolves.toMatchObject(
      [{ id: key.id, name: 'customer key' }],
    );
    await expect(controls.revokeApiKey(selectedTenantId, key.id)).resolves.toBe(
      true,
    );

    const replacement = {
      ...key,
      id: apiKeyId(randomUUID()),
      publicId: apiKeyPublicId(randomUUID().replaceAll('-', '').slice(0, 24)),
      keyHash: apiKeyHash('f'.repeat(64)),
    };
    await expect(
      controls.createApiKeyWithinEntitlements(replacement, now),
    ).resolves.toBe('created');
    await expect(
      controls.setEntitlements({
        tenantId: selectedTenantId,
        tenantStatus: 'disabled',
        entitlements: {
          ...activeEntitlements,
          status: 'suspended',
          updatedAt: new Date('2026-11-19T03:00:00.000Z'),
        },
      }),
    ).resolves.toBe(true);
    const suspendedKeys = await controls.listApiKeys(selectedTenantId);
    expect(suspendedKeys).toContainEqual(
      expect.objectContaining({ id: replacement.id, status: 'disabled' }),
    );
    await expect(
      controls.createApiKeyWithinEntitlements(
        {
          ...replacement,
          id: apiKeyId(randomUUID()),
          publicId: apiKeyPublicId(
            randomUUID().replaceAll('-', '').slice(0, 24),
          ),
        },
        now,
      ),
    ).resolves.toBe('entitlement_unavailable');

    await controls.createBusinessInquiry({
      id: inquiryId,
      name: 'Customer',
      email: user.email,
      company: tenant.name,
      message: 'We need a private production deployment.',
      requestId: 'req_inquiry',
      consentedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await expect(controls.listBusinessInquiries()).resolves.toMatchObject([
      { id: inquiryId, status: 'new' },
    ]);
    await expect(
      controls.updateBusinessInquiryStatus(inquiryId, 'closed', now),
    ).resolves.toBe(true);

    await audits.append({
      id: randomUUID(),
      actorCustomerUserId: userId,
      tenantId: selectedTenantId,
      action: 'customer.login_succeeded',
      targetType: 'customer_session',
      targetId: session.id,
      requestId: 'req_login',
      metadata: {},
      createdAt: now,
    });
    const audit = await pool.query(
      'SELECT action FROM customer_audit_events WHERE tenant_id = $1',
      [selectedTenantId],
    );
    expect(audit.rows).toContainEqual({ action: 'customer.login_succeeded' });
  });
});
