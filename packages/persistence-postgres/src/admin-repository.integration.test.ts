import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  adminSessionId,
  adminTokenHash,
  adminUserId,
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  tenantId,
  type AdminSession,
  type AdminUser,
  type ApiKey,
} from '@rax-digital/domain';

import {
  PostgresAdminAuditRepository,
  PostgresAdminControlRepository,
  PostgresAdminIdentityRepository,
} from './admin-repository.js';
import { PostgresApiKeyRepository } from './api-key-repository.js';
import { runMigrations } from './migrations.js';
import { createPostgresPool } from './postgres.js';

const databaseUrl = process.env.RCG_TEST_DATABASE_URL;
const describeIntegration =
  databaseUrl === undefined ? describe.skip : describe;

describeIntegration('PostgreSQL administrator repositories', () => {
  const pool = createPostgresPool({
    databaseUrl:
      databaseUrl ?? 'postgresql://integration-test.invalid/compute_gateway',
    connectTimeoutMs: 5_000,
    maxConnections: 2,
  });
  const identities = new PostgresAdminIdentityRepository(pool);
  const controls = new PostgresAdminControlRepository(pool);
  const audits = new PostgresAdminAuditRepository(pool);
  const apiKeys = new PostgresApiKeyRepository(pool);
  const now = new Date('2026-08-13T00:00:00.000Z');
  const user: AdminUser = {
    id: adminUserId(randomUUID()),
    email: `owner-${randomUUID()}@example.com`,
    displayName: 'Integration Owner',
    passwordHash:
      'scrypt$v=1$N=32768$r=8$p=3$AAAAAAAAAAAAAAAAAAAAAA$bSiBtLmp2p10SfHCPaF2JTc6SdKodsv8cpvatDq-dok',
    status: 'active',
    mustChangePassword: true,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const tenant = {
    id: tenantId(randomUUID()),
    name: `integration-${randomUUID()}`,
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
  const key: ApiKey = {
    id: apiKeyId(randomUUID()),
    publicId: apiKeyPublicId(randomUUID().replaceAll('-', '').slice(0, 24)),
    keyHash: apiKeyHash('b'.repeat(64)),
    tenantId: tenant.id,
    name: 'admin-created key',
    environment: 'test',
    status: 'active',
    policy: {
      allowedModelPatterns: ['rax/*'],
      allowStreaming: true,
      allowTools: false,
      requestsPerMinute: 60,
      maxConcurrentRequests: 4,
    },
    createdAt: now,
    expiresAt: null,
  };

  beforeAll(async () => {
    await runMigrations(pool, 'db/migrations');
  });

  afterAll(async () => {
    await pool.query(
      'DELETE FROM operator_audit_events WHERE actor_admin_user_id = $1',
      [user.id],
    );
    await pool.query('DELETE FROM api_keys WHERE tenant_id = $1', [tenant.id]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [user.id]);
    await pool.end();
  });

  it('persists identities, opaque sessions, control metadata, and audit events', async () => {
    await identities.createUser(user);
    await expect(identities.findUserByEmail(user.email)).resolves.toEqual(user);
    await identities.recordLoginFailure(user.id, now, 1, 60_000);
    await expect(identities.findUserById(user.id)).resolves.toMatchObject({
      failedLoginCount: 1,
      lockedUntil: new Date('2026-08-13T00:01:00.000Z'),
    });
    await identities.recordLoginSuccess(user.id, now);

    const session: AdminSession = {
      id: adminSessionId(randomUUID()),
      userId: user.id,
      tokenHash: adminTokenHash('c'.repeat(64)),
      csrfTokenHash: adminTokenHash('d'.repeat(64)),
      createdAt: now,
      expiresAt: new Date('2026-08-13T08:00:00.000Z'),
      lastSeenAt: now,
    };
    await identities.createSession(session);
    await expect(
      identities.findSessionByTokenHash(
        session.tokenHash,
        new Date('2026-08-13T01:00:00.000Z'),
      ),
    ).resolves.toMatchObject({ session, user: { id: user.id } });

    await controls.createTenant(tenant);
    await apiKeys.create(key);
    await expect(controls.listTenants()).resolves.toContainEqual(tenant);
    await expect(controls.listApiKeys(tenant.id)).resolves.toMatchObject([
      { id: key.id, tenantId: tenant.id, lastUsedAt: null },
    ]);
    const summary = await controls.dashboardSummary(now);
    expect(summary.tenantCount).toBeGreaterThanOrEqual(1);
    expect(summary.apiKeyCount).toBeGreaterThanOrEqual(1);
    expect(summary.activeApiKeyCount).toBeGreaterThanOrEqual(1);

    await audits.append({
      id: randomUUID(),
      actorAdminUserId: user.id,
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: tenant.id,
      requestId: 'req_integration',
      metadata: { tenant_id: tenant.id },
      createdAt: now,
    });
    const audit = await pool.query(
      'SELECT action, metadata FROM operator_audit_events WHERE actor_admin_user_id = $1',
      [user.id],
    );
    expect(audit.rows).toMatchObject([
      { action: 'tenant.created', metadata: { tenant_id: tenant.id } },
    ]);

    await identities.deleteSessionsForUser(user.id);
    await expect(
      identities.findSessionByTokenHash(session.tokenHash, now),
    ).resolves.toBeNull();
  });
});
