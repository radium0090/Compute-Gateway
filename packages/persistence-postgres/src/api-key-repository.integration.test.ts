import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  tenantId,
  type ApiKey,
} from '@rax-digital/domain';

import { PostgresApiKeyRepository } from './api-key-repository.js';
import { runMigrations } from './migrations.js';
import { createPostgresPool } from './postgres.js';

const databaseUrl = process.env.RCG_TEST_DATABASE_URL;
const describeIntegration =
  databaseUrl === undefined ? describe.skip : describe;

describeIntegration('PostgresApiKeyRepository integration', () => {
  const pool = createPostgresPool({
    databaseUrl:
      databaseUrl ?? 'postgresql://integration-test.invalid/compute_gateway',
    connectTimeoutMs: 5_000,
    maxConnections: 2,
  });
  const repository = new PostgresApiKeyRepository(pool);
  const tenant = tenantId(randomUUID());
  const key: ApiKey = {
    id: apiKeyId(randomUUID()),
    publicId: apiKeyPublicId(randomUUID().replaceAll('-', '').slice(0, 24)),
    keyHash: apiKeyHash('a'.repeat(64)),
    tenantId: tenant,
    name: 'integration key',
    environment: 'test',
    status: 'active',
    policy: {
      allowedModelPatterns: ['rax/*'],
      allowStreaming: true,
      allowTools: false,
      requestsPerMinute: 60,
      maxConcurrentRequests: 4,
    },
    createdAt: new Date('2026-08-03T00:00:00.000Z'),
    expiresAt: null,
  };

  beforeAll(async () => {
    await runMigrations(pool, 'db/migrations');
    await pool.query(
      'INSERT INTO tenants (id, name, status) VALUES ($1, $2, $3)',
      [tenant, 'integration tenant', 'active'],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM api_keys WHERE tenant_id = $1', [tenant]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenant]);
    await pool.end();
  });

  it('round-trips API key metadata and idempotently reruns migrations', async () => {
    await repository.create(key);
    await expect(repository.findByPublicId(key.publicId)).resolves.toEqual(key);
    await repository.markLastUsed(key.id, new Date('2026-08-03T00:01:00.000Z'));
    await expect(repository.revoke(key.id)).resolves.toBe(true);
    await expect(repository.revoke(key.id)).resolves.toBe(false);
    await expect(
      repository.findByPublicId(key.publicId),
    ).resolves.toMatchObject({
      status: 'revoked',
    });
    await expect(runMigrations(pool, 'db/migrations')).resolves.toEqual({
      appliedVersions: [],
    });
  });
});
