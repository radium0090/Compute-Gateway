import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { ApiKey, ApiKeyEnvironment } from '@rax-digital/domain';

export interface DemoStateRecordInput {
  readonly stateHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type PostgresDemoClaimResult =
  | { readonly created: true }
  | {
      readonly created: false;
      readonly reason:
        'account_cooldown' | 'daily_limit' | 'tenant_unavailable';
    };

interface TenantStatusRow {
  readonly status: 'active' | 'disabled';
}

interface CountRow {
  readonly count: string;
}

interface LatestClaimRow {
  readonly claimed_at: Date;
}

/** PostgreSQL claim ledger and atomic trial-key provisioning adapter. */
export class PostgresDemoClaimRepository {
  public constructor(private readonly pool: Pool) {}

  public async createState(state: DemoStateRecordInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO demo_oauth_states
         (state_hash, created_at, expires_at)
       VALUES ($1, $2, $3)`,
      [state.stateHash, state.createdAt, state.expiresAt],
    );
    await this.pool.query(
      `DELETE FROM demo_oauth_states
        WHERE expires_at < $1::timestamptz - interval '1 day'`,
      [state.createdAt],
    );
  }

  public async consumeState(
    stateHash: string,
    consumedAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE demo_oauth_states
          SET consumed_at = $2
        WHERE state_hash = $1
          AND consumed_at IS NULL
          AND expires_at > $2
      RETURNING state_hash`,
      [stateHash, consumedAt],
    );
    return (result.rowCount ?? 0) === 1;
  }

  public async createClaim(input: {
    readonly identityHash: string;
    readonly apiKey: ApiKey;
    readonly claimedAt: Date;
    readonly cooldownThreshold: Date;
    readonly dailyWindowStart: Date;
    readonly maximumDailyClaims: number;
  }): Promise<PostgresDemoClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Claim volume is deliberately tiny. One table lock gives the global cap
      // and per-identity cooldown deterministic behavior across all replicas.
      await client.query('LOCK TABLE demo_claims IN EXCLUSIVE MODE');
      const tenant = await client.query<TenantStatusRow>(
        'SELECT status FROM tenants WHERE id = $1',
        [input.apiKey.tenantId],
      );
      if (tenant.rows[0]?.status !== 'active') {
        await client.query('ROLLBACK');
        return { created: false, reason: 'tenant_unavailable' };
      }

      const latest = await client.query<LatestClaimRow>(
        `SELECT claimed_at
           FROM demo_claims
          WHERE identity_hash = $1
          ORDER BY claimed_at DESC
          LIMIT 1`,
        [input.identityHash],
      );
      const latestClaim = latest.rows[0]?.claimed_at;
      if (latestClaim !== undefined && latestClaim > input.cooldownThreshold) {
        await client.query('ROLLBACK');
        return { created: false, reason: 'account_cooldown' };
      }

      const count = await client.query<CountRow>(
        `SELECT count(*)::text AS count
           FROM demo_claims
          WHERE claimed_at >= $1`,
        [input.dailyWindowStart],
      );
      if (Number(count.rows[0]?.count ?? '0') >= input.maximumDailyClaims) {
        await client.query('ROLLBACK');
        return { created: false, reason: 'daily_limit' };
      }

      await client.query(
        `INSERT INTO api_keys
           (id, public_id, key_hash, tenant_id, name, environment, status,
            policy, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
        apiKeyParameters(input.apiKey),
      );
      await client.query(
        `INSERT INTO demo_claims
           (id, identity_hash, api_key_id, claimed_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          randomUUID(),
          input.identityHash,
          input.apiKey.id,
          input.claimedAt,
          input.apiKey.expiresAt,
        ],
      );
      await client.query('COMMIT');
      return { created: true };
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function apiKeyParameters(
  apiKey: ApiKey,
): [
  string,
  string,
  string,
  string,
  string,
  ApiKeyEnvironment,
  string,
  string,
  Date,
  Date | null,
] {
  return [
    apiKey.id,
    apiKey.publicId,
    apiKey.keyHash,
    apiKey.tenantId,
    apiKey.name,
    apiKey.environment,
    apiKey.status,
    JSON.stringify(apiKey.policy),
    apiKey.createdAt,
    apiKey.expiresAt,
  ];
}
