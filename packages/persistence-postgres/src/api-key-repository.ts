import type { Pool } from 'pg';

import {
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  tenantId,
  validateApiKey,
  type ApiKey,
  type ApiKeyEnvironment,
  type ApiKeyPolicy,
  type ApiKeyPublicId,
  type ApiKeyRepository,
  type ApiKeyStatus,
  type ApiKeyId,
} from '@rax-digital/domain';

interface ApiKeyRow {
  readonly id: string;
  readonly public_id: string;
  readonly key_hash: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  readonly status: ApiKeyStatus;
  readonly policy: unknown;
  readonly created_at: Date;
  readonly expires_at: Date | null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parsePolicy(value: unknown): ApiKeyPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Persisted API key policy is invalid');
  }

  const record = value as Readonly<Record<string, unknown>>;
  const allowedModelPatterns = record.allowedModelPatterns;
  if (
    !Array.isArray(allowedModelPatterns) ||
    !allowedModelPatterns.every((pattern) => typeof pattern === 'string') ||
    typeof record.allowStreaming !== 'boolean' ||
    typeof record.allowTools !== 'boolean' ||
    !isPositiveInteger(record.requestsPerMinute) ||
    !isPositiveInteger(record.maxConcurrentRequests)
  ) {
    throw new TypeError('Persisted API key policy is invalid');
  }

  return {
    allowedModelPatterns,
    allowStreaming: record.allowStreaming,
    allowTools: record.allowTools,
    requestsPerMinute: record.requestsPerMinute,
    maxConcurrentRequests: record.maxConcurrentRequests,
    ...(isPositiveInteger(record.maxRequestTokens)
      ? { maxRequestTokens: record.maxRequestTokens }
      : {}),
    ...(isPositiveInteger(record.maxOutputTokens)
      ? { maxOutputTokens: record.maxOutputTokens }
      : {}),
  };
}

function mapApiKey(row: ApiKeyRow): ApiKey {
  const candidate: ApiKey = {
    id: apiKeyId(row.id),
    publicId: apiKeyPublicId(row.public_id),
    keyHash: apiKeyHash(row.key_hash),
    tenantId: tenantId(row.tenant_id),
    name: row.name,
    environment: row.environment,
    status: row.status,
    policy: parsePolicy(row.policy),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  const validation = validateApiKey(candidate);
  if (!validation.ok) {
    throw new TypeError(`Persisted API key is invalid: ${validation.reason}`);
  }
  return validation.value;
}

/** PostgreSQL implementation of the domain API key storage port. */
export class PostgresApiKeyRepository implements ApiKeyRepository {
  public constructor(private readonly pool: Pool) {}

  public async findByPublicId(
    publicId: ApiKeyPublicId,
  ): Promise<ApiKey | null> {
    const result = await this.pool.query<ApiKeyRow>(
      `SELECT id, public_id, key_hash, tenant_id, name, environment, status,
              policy, created_at, expires_at
         FROM api_keys
        WHERE public_id = $1`,
      [publicId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapApiKey(row);
  }

  public async create(apiKey: ApiKey): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_keys
         (id, public_id, key_hash, tenant_id, name, environment, status, policy,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
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
      ],
    );
  }

  public async revoke(id: ApiKeyId): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_keys
          SET status = 'revoked'
        WHERE id = $1
          AND status <> 'revoked'
      RETURNING id`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async markLastUsed(id: ApiKeyId, usedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE api_keys
          SET last_used_at = $2::timestamptz
        WHERE id = $1
          AND (
            last_used_at IS NULL
            OR last_used_at < $2::timestamptz - interval '1 minute'
          )`,
      [id, usedAt],
    );
  }
}
