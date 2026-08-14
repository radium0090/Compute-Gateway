import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  tenantId,
  type ApiKey,
} from '@rax-digital/domain';

import { PostgresDemoClaimRepository } from './demo-claim-repository.js';
import { runMigrations } from './migrations.js';
import { createPostgresPool } from './postgres.js';

const databaseUrl = process.env.RCG_TEST_DATABASE_URL;
const describeIntegration =
  databaseUrl === undefined ? describe.skip : describe;

describeIntegration('PostgresDemoClaimRepository integration', () => {
  const pool = createPostgresPool({
    databaseUrl:
      databaseUrl ?? 'postgresql://integration-test.invalid/compute_gateway',
    connectTimeoutMs: 5_000,
    maxConnections: 2,
  });
  const repository = new PostgresDemoClaimRepository(pool);
  const tenant = tenantId(randomUUID());

  function key(publicId: string, createdAt: Date): ApiKey {
    return {
      id: apiKeyId(randomUUID()),
      publicId: apiKeyPublicId(publicId),
      keyHash: apiKeyHash('a'.repeat(64)),
      tenantId: tenant,
      name: 'demo',
      environment: 'test',
      status: 'active',
      policy: {
        allowedModelPatterns: ['rax/fast'],
        allowStreaming: false,
        allowTools: false,
        requestsPerMinute: 2,
        maxConcurrentRequests: 1,
        maxOutputTokens: 128,
      },
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 300_000),
    };
  }

  beforeAll(async () => {
    await runMigrations(pool, 'db/migrations');
    await pool.query(
      'INSERT INTO tenants (id, name, status) VALUES ($1, $2, $3)',
      [tenant, 'demo tenant', 'active'],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM demo_oauth_states WHERE state_hash = $1', [
      'b'.repeat(64),
    ]);
    await pool.query('DELETE FROM api_keys WHERE tenant_id = $1', [tenant]);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenant]);
    await pool.end();
  });

  it('consumes state once and enforces account and global claim limits', async () => {
    const claimedAt = new Date('2026-08-14T05:00:00.000Z');
    await repository.createState({
      stateHash: 'b'.repeat(64),
      createdAt: claimedAt,
      expiresAt: new Date(claimedAt.getTime() + 600_000),
    });
    await expect(
      repository.consumeState('b'.repeat(64), claimedAt),
    ).resolves.toBe(true);
    await expect(
      repository.consumeState('b'.repeat(64), claimedAt),
    ).resolves.toBe(false);

    const first = key('demo-public-id-1', claimedAt);
    const shared = {
      identityHash: 'c'.repeat(64),
      claimedAt,
      cooldownThreshold: new Date(claimedAt.getTime() - 86_400_000),
      dailyWindowStart: new Date('2026-08-14T00:00:00.000Z'),
      maximumDailyClaims: 1,
    };
    await expect(
      repository.createClaim({ ...shared, apiKey: first }),
    ).resolves.toEqual({ created: true });
    await expect(
      repository.createClaim({
        ...shared,
        identityHash: 'd'.repeat(64),
        apiKey: key('demo-public-id-2', claimedAt),
      }),
    ).resolves.toEqual({ created: false, reason: 'daily_limit' });
    await expect(
      repository.createClaim({
        ...shared,
        maximumDailyClaims: 2,
        apiKey: key('demo-public-id-3', claimedAt),
      }),
    ).resolves.toEqual({ created: false, reason: 'account_cooldown' });
  });
});
