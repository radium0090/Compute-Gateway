import type { Pool, PoolClient } from 'pg';

import {
  apiKeyId,
  customerSessionId,
  customerTokenHash,
  customerUserId,
  tenantId,
  type ApiKeyEnvironment,
  type ApiKey,
  type ApiKeyId,
  type ApiKeyPolicy,
  type ApiKeyStatus,
  type BusinessInquiry,
  type BusinessInquirySummary,
  type CustomerAccountSummary,
  type CustomerAdministrationRepository,
  type CustomerApiKeySummary,
  type CustomerAuditEvent,
  type CustomerAuditRepository,
  type CustomerControlRepository,
  type CustomerIdentityRepository,
  type CustomerOneTimeToken,
  type CustomerSession,
  type CustomerSessionWithUser,
  type CustomerTenantEntitlements,
  type CustomerTokenHash,
  type CustomerUser,
  type CustomerUserId,
  type Tenant,
  type TenantId,
} from '@rax-digital/domain';

interface CustomerUserRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly password_hash: string;
  readonly status: 'pending_verification' | 'active' | 'disabled';
  readonly email_verified_at: Date | null;
  readonly failed_login_count: number;
  readonly locked_until: Date | null;
  readonly last_login_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CustomerSessionRow extends CustomerUserRow {
  readonly session_id: string;
  readonly session_user_id: string;
  readonly token_hash: string;
  readonly csrf_token_hash: string;
  readonly session_created_at: Date;
  readonly expires_at: Date;
  readonly last_seen_at: Date;
}

interface EntitlementRow {
  readonly tenant_id: string;
  readonly status: 'pending' | 'active' | 'suspended';
  readonly plan_code: string;
  readonly allowed_model_patterns: unknown;
  readonly allow_streaming: boolean;
  readonly allow_tools: boolean;
  readonly requests_per_minute: number;
  readonly max_concurrent_requests: number;
  readonly max_request_tokens: number;
  readonly max_output_tokens: number;
  readonly max_active_api_keys: number;
  readonly key_ttl_days: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface EntitlementCreationRow extends EntitlementRow {
  readonly tenant_status: 'active' | 'disabled';
}

interface ApiKeySummaryRow {
  readonly id: string;
  readonly public_id: string;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  readonly status: ApiKeyStatus;
  readonly policy: unknown;
  readonly created_at: Date;
  readonly expires_at: Date | null;
  readonly last_used_at: Date | null;
}

interface CustomerAccountRow extends Omit<
  EntitlementRow,
  'status' | 'created_at' | 'updated_at'
> {
  readonly id: string;
  readonly tenant_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly status: 'pending_verification' | 'active' | 'disabled';
  readonly email_verified_at: Date | null;
  readonly tenant_name: string;
  readonly tenant_status: 'active' | 'disabled';
  readonly entitlement_status: 'pending' | 'active' | 'suspended';
  readonly user_created_at: Date;
  readonly entitlement_created_at: Date;
  readonly entitlement_updated_at: Date;
}

interface BusinessInquiryRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly company: string | null;
  readonly message: string;
  readonly status: 'new' | 'in_progress' | 'closed' | 'deleted';
  readonly request_id: string;
  readonly consented_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function mapUser(row: CustomerUserRow): CustomerUser {
  return {
    id: customerUserId(row.id),
    tenantId: tenantId(row.tenant_id),
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status,
    emailVerifiedAt: row.email_verified_at,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePatterns(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new TypeError('Persisted model entitlement is invalid');
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isDuplicateCustomerEmail(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Readonly<Record<string, unknown>>;
  return (
    record.code === '23505' &&
    record.constraint === 'customer_users_email_unique_idx'
  );
}

function parsePolicy(value: unknown): ApiKeyPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Persisted API key policy is invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  return {
    allowedModelPatterns: parsePatterns(record.allowedModelPatterns),
    allowStreaming: record.allowStreaming === true,
    allowTools: record.allowTools === true,
    requestsPerMinute: isPositiveInteger(record.requestsPerMinute)
      ? record.requestsPerMinute
      : 1,
    maxConcurrentRequests: isPositiveInteger(record.maxConcurrentRequests)
      ? record.maxConcurrentRequests
      : 1,
    ...(isPositiveInteger(record.maxRequestTokens)
      ? { maxRequestTokens: record.maxRequestTokens }
      : {}),
    ...(isPositiveInteger(record.maxOutputTokens)
      ? { maxOutputTokens: record.maxOutputTokens }
      : {}),
  };
}

function mapEntitlements(row: EntitlementRow): CustomerTenantEntitlements {
  return {
    tenantId: tenantId(row.tenant_id),
    status: row.status,
    planCode: row.plan_code,
    policy: {
      allowedModelPatterns: parsePatterns(row.allowed_model_patterns),
      allowStreaming: row.allow_streaming,
      allowTools: row.allow_tools,
      requestsPerMinute: row.requests_per_minute,
      maxConcurrentRequests: row.max_concurrent_requests,
      maxRequestTokens: row.max_request_tokens,
      maxOutputTokens: row.max_output_tokens,
    },
    maxActiveApiKeys: row.max_active_api_keys,
    keyTtlDays: row.key_ttl_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function policiesMatch(left: ApiKeyPolicy, right: ApiKeyPolicy): boolean {
  return (
    left.allowStreaming === right.allowStreaming &&
    left.allowTools === right.allowTools &&
    left.requestsPerMinute === right.requestsPerMinute &&
    left.maxConcurrentRequests === right.maxConcurrentRequests &&
    left.maxRequestTokens === right.maxRequestTokens &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.allowedModelPatterns.length === right.allowedModelPatterns.length &&
    left.allowedModelPatterns.every(
      (pattern, index) => pattern === right.allowedModelPatterns[index],
    )
  );
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const userColumns = `id, tenant_id, email, display_name, password_hash, status,
  email_verified_at, failed_login_count, locked_until, last_login_at,
  created_at, updated_at`;

/** PostgreSQL customer identities, sessions, and one-time tokens. */
export class PostgresCustomerIdentityRepository implements CustomerIdentityRepository {
  public constructor(private readonly pool: Pool) {}

  public async findUserByEmail(email: string): Promise<CustomerUser | null> {
    const result = await this.pool.query<CustomerUserRow>(
      `SELECT ${userColumns} FROM customer_users WHERE email = $1`,
      [email],
    );
    return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
  }

  public async findUserById(id: CustomerUserId): Promise<CustomerUser | null> {
    const result = await this.pool.query<CustomerUserRow>(
      `SELECT ${userColumns} FROM customer_users WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
  }

  public async createRegistration(input: {
    readonly tenant: Tenant;
    readonly user: CustomerUser;
    readonly entitlements: CustomerTenantEntitlements;
    readonly verification: CustomerOneTimeToken;
  }): Promise<'created' | 'account_exists'> {
    try {
      await transaction(this.pool, async (client) => {
        await client.query(
          `INSERT INTO tenants (id, name, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            input.tenant.id,
            input.tenant.name,
            input.tenant.status,
            input.tenant.createdAt,
            input.tenant.updatedAt,
          ],
        );
        await client.query(
          `INSERT INTO customer_users
             (id, tenant_id, email, display_name, password_hash, status,
              email_verified_at, failed_login_count, locked_until, last_login_at,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            input.user.id,
            input.user.tenantId,
            input.user.email,
            input.user.displayName,
            input.user.passwordHash,
            input.user.status,
            input.user.emailVerifiedAt,
            input.user.failedLoginCount,
            input.user.lockedUntil,
            input.user.lastLoginAt,
            input.user.createdAt,
            input.user.updatedAt,
          ],
        );
        const policy = input.entitlements.policy;
        await client.query(
          `INSERT INTO customer_tenant_entitlements
             (tenant_id, status, plan_code, allowed_model_patterns,
              allow_streaming, allow_tools, requests_per_minute,
              max_concurrent_requests, max_request_tokens, max_output_tokens,
              max_active_api_keys, key_ttl_days, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14)`,
          [
            input.entitlements.tenantId,
            input.entitlements.status,
            input.entitlements.planCode,
            JSON.stringify(policy.allowedModelPatterns),
            policy.allowStreaming,
            policy.allowTools,
            policy.requestsPerMinute,
            policy.maxConcurrentRequests,
            policy.maxRequestTokens ?? 2_048,
            policy.maxOutputTokens ?? 256,
            input.entitlements.maxActiveApiKeys,
            input.entitlements.keyTtlDays,
            input.entitlements.createdAt,
            input.entitlements.updatedAt,
          ],
        );
        await this.insertToken(client, input.verification);
      });
      return 'created';
    } catch (error) {
      if (isDuplicateCustomerEmail(error)) return 'account_exists';
      throw error;
    }
  }

  public async recordLoginSuccess(
    id: CustomerUserId,
    loggedInAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE customer_users
          SET failed_login_count = 0, locked_until = NULL,
              last_login_at = $2, updated_at = $2
        WHERE id = $1`,
      [id, loggedInAt],
    );
  }

  public async recordLoginFailure(
    id: CustomerUserId,
    failedAt: Date,
    lockAfterFailures: number,
    lockDurationMs: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE customer_users
          SET failed_login_count = CASE
                WHEN locked_until IS NOT NULL AND locked_until <= $2 THEN 1
                ELSE failed_login_count + 1
              END,
              locked_until = CASE
                WHEN (CASE
                  WHEN locked_until IS NOT NULL AND locked_until <= $2 THEN 1
                  ELSE failed_login_count + 1
                END) >= $3
                  THEN $2::timestamptz + ($4 * interval '1 millisecond')
                WHEN locked_until IS NOT NULL AND locked_until <= $2 THEN NULL
                ELSE locked_until
              END,
              updated_at = $2
        WHERE id = $1`,
      [id, failedAt, lockAfterFailures, lockDurationMs],
    );
  }

  public async createSession(session: CustomerSession): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query(
        'DELETE FROM customer_sessions WHERE expires_at <= $1',
        [session.createdAt],
      );
      await client.query(
        `DELETE FROM customer_sessions
          WHERE user_id = $1
            AND id NOT IN (
              SELECT id FROM customer_sessions
               WHERE user_id = $1
               ORDER BY created_at DESC, id
               LIMIT 4
            )`,
        [session.userId],
      );
      await client.query(
        `INSERT INTO customer_sessions
           (id, user_id, token_hash, csrf_token_hash, created_at, expires_at,
            last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          session.id,
          session.userId,
          session.tokenHash,
          session.csrfTokenHash,
          session.createdAt,
          session.expiresAt,
          session.lastSeenAt,
        ],
      );
    });
  }

  public async findSessionByTokenHash(
    hash: CustomerTokenHash,
    now: Date,
  ): Promise<CustomerSessionWithUser | null> {
    const result = await this.pool.query<CustomerSessionRow>(
      `SELECT u.id, u.tenant_id, u.email, u.display_name, u.password_hash,
              u.status, u.email_verified_at, u.failed_login_count,
              u.locked_until, u.last_login_at, u.created_at, u.updated_at,
              s.id AS session_id, s.user_id AS session_user_id,
              s.token_hash, s.csrf_token_hash,
              s.created_at AS session_created_at, s.expires_at, s.last_seen_at
         FROM customer_sessions s
         JOIN customer_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [hash, now],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      user: mapUser(row),
      session: {
        id: customerSessionId(row.session_id),
        userId: customerUserId(row.session_user_id),
        tokenHash: customerTokenHash(row.token_hash),
        csrfTokenHash: customerTokenHash(row.csrf_token_hash),
        createdAt: row.session_created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
      },
    };
  }

  public async deleteSessionByTokenHash(
    hash: CustomerTokenHash,
  ): Promise<void> {
    await this.pool.query(
      'DELETE FROM customer_sessions WHERE token_hash = $1',
      [hash],
    );
  }

  public async deleteSessionsForUser(id: CustomerUserId): Promise<void> {
    await this.pool.query('DELETE FROM customer_sessions WHERE user_id = $1', [
      id,
    ]);
  }

  public async replaceOneTimeToken(token: CustomerOneTimeToken): Promise<void> {
    await transaction(this.pool, async (client) => {
      await client.query(
        `DELETE FROM customer_one_time_tokens
          WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
        [token.userId, token.purpose],
      );
      await this.insertToken(client, token);
    });
  }

  public async verifyEmail(
    hash: CustomerTokenHash,
    now: Date,
  ): Promise<CustomerUser | null> {
    return transaction(this.pool, async (client) => {
      const token = await client.query<{ readonly user_id: string }>(
        `UPDATE customer_one_time_tokens
            SET consumed_at = $2
          WHERE token_hash = $1 AND purpose = 'verify_email'
            AND consumed_at IS NULL AND expires_at > $2
          RETURNING user_id`,
        [hash, now],
      );
      const userId = token.rows[0]?.user_id;
      if (userId === undefined) return null;
      const result = await client.query<CustomerUserRow>(
        `UPDATE customer_users
            SET status = 'active', email_verified_at = $2, updated_at = $2
          WHERE id = $1 AND status = 'pending_verification'
          RETURNING ${userColumns}`,
        [userId, now],
      );
      return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
    });
  }

  public async resetPassword(
    hash: CustomerTokenHash,
    passwordHash: string,
    now: Date,
  ): Promise<CustomerUser | null> {
    return transaction(this.pool, async (client) => {
      const token = await client.query<{ readonly user_id: string }>(
        `UPDATE customer_one_time_tokens
            SET consumed_at = $2
          WHERE token_hash = $1 AND purpose = 'reset_password'
            AND consumed_at IS NULL AND expires_at > $2
          RETURNING user_id`,
        [hash, now],
      );
      const userId = token.rows[0]?.user_id;
      if (userId === undefined) return null;
      const result = await client.query<CustomerUserRow>(
        `UPDATE customer_users
            SET password_hash = $2, failed_login_count = 0,
                locked_until = NULL, updated_at = $3
          WHERE id = $1 AND status = 'active'
          RETURNING ${userColumns}`,
        [userId, passwordHash, now],
      );
      return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
    });
  }

  private async insertToken(
    client: PoolClient,
    token: CustomerOneTimeToken,
  ): Promise<void> {
    await client.query(
      `INSERT INTO customer_one_time_tokens
         (id, user_id, purpose, token_hash, created_at, expires_at, consumed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [
        token.id,
        token.userId,
        token.purpose,
        token.tokenHash,
        token.createdAt,
        token.expiresAt,
      ],
    );
  }
}

/** PostgreSQL tenant-scoped customer metadata and public inquiry store. */
export class PostgresCustomerControlRepository
  implements CustomerControlRepository, CustomerAdministrationRepository
{
  public constructor(private readonly pool: Pool) {}

  public async findEntitlements(
    selectedTenantId: TenantId,
  ): Promise<CustomerTenantEntitlements | null> {
    const result = await this.pool.query<EntitlementRow>(
      `SELECT tenant_id, status, plan_code, allowed_model_patterns,
              allow_streaming, allow_tools, requests_per_minute,
              max_concurrent_requests, max_request_tokens, max_output_tokens,
              max_active_api_keys, key_ttl_days, created_at, updated_at
         FROM customer_tenant_entitlements
        WHERE tenant_id = $1`,
      [selectedTenantId],
    );
    return result.rows[0] === undefined
      ? null
      : mapEntitlements(result.rows[0]);
  }

  public async listApiKeys(
    selectedTenantId: TenantId,
  ): Promise<readonly CustomerApiKeySummary[]> {
    const result = await this.pool.query<ApiKeySummaryRow>(
      `SELECT id, public_id, name, environment, status, policy,
              created_at, expires_at, last_used_at
         FROM api_keys
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id`,
      [selectedTenantId],
    );
    return result.rows.map((row) => ({
      id: apiKeyId(row.id),
      publicId: row.public_id,
      name: row.name,
      environment: row.environment,
      status: row.status,
      policy: parsePolicy(row.policy),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  public async countActiveApiKeys(
    selectedTenantId: TenantId,
    now: Date,
  ): Promise<number> {
    const result = await this.pool.query<{ readonly count: string }>(
      `SELECT count(*)::text AS count
         FROM api_keys
        WHERE tenant_id = $1 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > $2)`,
      [selectedTenantId, now],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  public async createApiKeyWithinEntitlements(
    apiKey: ApiKey,
    now: Date,
  ): Promise<'created' | 'entitlement_unavailable' | 'limit_reached'> {
    return transaction(this.pool, async (client) => {
      const entitlementResult = await client.query<EntitlementCreationRow>(
        `SELECT e.tenant_id, e.status, e.plan_code,
                e.allowed_model_patterns, e.allow_streaming, e.allow_tools,
                e.requests_per_minute, e.max_concurrent_requests,
                e.max_request_tokens, e.max_output_tokens,
                e.max_active_api_keys, e.key_ttl_days,
                e.created_at, e.updated_at, t.status AS tenant_status
           FROM customer_tenant_entitlements e
           JOIN tenants t ON t.id = e.tenant_id
          WHERE e.tenant_id = $1
          FOR UPDATE OF e, t`,
        [apiKey.tenantId],
      );
      const row = entitlementResult.rows[0];
      if (row === undefined) return 'entitlement_unavailable';
      const entitlements = mapEntitlements(row);
      if (
        row.tenant_status !== 'active' ||
        entitlements.status !== 'active' ||
        entitlements.policy.allowedModelPatterns.length === 0 ||
        !policiesMatch(apiKey.policy, entitlements.policy)
      ) {
        return 'entitlement_unavailable';
      }
      const active = await client.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count
           FROM api_keys
          WHERE tenant_id = $1 AND status = 'active'
            AND (expires_at IS NULL OR expires_at > $2)`,
        [apiKey.tenantId, now],
      );
      if (
        Number(active.rows[0]?.count ?? '0') >= entitlements.maxActiveApiKeys
      ) {
        return 'limit_reached';
      }
      await client.query(
        `INSERT INTO api_keys
           (id, public_id, key_hash, tenant_id, name, environment, status,
            policy, created_at, expires_at)
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
      return 'created';
    });
  }

  public async revokeApiKey(
    selectedTenantId: TenantId,
    id: ApiKeyId,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_keys SET status = 'revoked'
        WHERE id = $1 AND tenant_id = $2 AND status <> 'revoked'`,
      [id, selectedTenantId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async createBusinessInquiry(inquiry: BusinessInquiry): Promise<void> {
    await this.pool.query(
      `INSERT INTO business_inquiries
         (id, name, email, company, message, status, request_id, consented_at,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'new', $6, $7, $8, $9)`,
      [
        inquiry.id,
        inquiry.name,
        inquiry.email,
        inquiry.company,
        inquiry.message,
        inquiry.requestId,
        inquiry.consentedAt,
        inquiry.createdAt,
        inquiry.updatedAt,
      ],
    );
  }

  public async listCustomerAccounts(): Promise<
    readonly CustomerAccountSummary[]
  > {
    const result = await this.pool.query<CustomerAccountRow>(
      `SELECT u.id, u.tenant_id, u.email, u.display_name,
              u.status, u.email_verified_at, u.created_at AS user_created_at,
              t.name AS tenant_name, t.status AS tenant_status,
              e.status AS entitlement_status, e.plan_code,
              e.allowed_model_patterns, e.allow_streaming, e.allow_tools,
              e.requests_per_minute, e.max_concurrent_requests,
              e.max_request_tokens, e.max_output_tokens,
              e.max_active_api_keys, e.key_ttl_days,
              e.created_at AS entitlement_created_at,
              e.updated_at AS entitlement_updated_at
         FROM customer_users u
         JOIN tenants t ON t.id = u.tenant_id
         JOIN customer_tenant_entitlements e ON e.tenant_id = u.tenant_id
        ORDER BY u.created_at DESC, u.id`,
    );
    return result.rows.map((row) => ({
      userId: customerUserId(row.id),
      tenantId: tenantId(row.tenant_id),
      tenantName: row.tenant_name,
      tenantStatus: row.tenant_status,
      email: row.email,
      displayName: row.display_name,
      userStatus: row.status,
      emailVerifiedAt: row.email_verified_at,
      entitlements: mapEntitlements({
        ...row,
        status: row.entitlement_status,
        created_at: row.entitlement_created_at,
        updated_at: row.entitlement_updated_at,
      }),
      createdAt: row.user_created_at,
    }));
  }

  public async setEntitlements(input: {
    readonly tenantId: TenantId;
    readonly tenantStatus: 'active' | 'disabled';
    readonly entitlements: CustomerTenantEntitlements;
  }): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const policy = input.entitlements.policy;
      const entitlement = await client.query(
        `UPDATE customer_tenant_entitlements
            SET status = $2, plan_code = $3,
                allowed_model_patterns = $4::jsonb,
                allow_streaming = $5, allow_tools = $6,
                requests_per_minute = $7, max_concurrent_requests = $8,
                max_request_tokens = $9, max_output_tokens = $10,
                max_active_api_keys = $11, key_ttl_days = $12,
                updated_at = $13
          WHERE tenant_id = $1`,
        [
          input.tenantId,
          input.entitlements.status,
          input.entitlements.planCode,
          JSON.stringify(policy.allowedModelPatterns),
          policy.allowStreaming,
          policy.allowTools,
          policy.requestsPerMinute,
          policy.maxConcurrentRequests,
          policy.maxRequestTokens ?? 2_048,
          policy.maxOutputTokens ?? 256,
          input.entitlements.maxActiveApiKeys,
          input.entitlements.keyTtlDays,
          input.entitlements.updatedAt,
        ],
      );
      if ((entitlement.rowCount ?? 0) === 0) return false;
      const tenant = await client.query(
        `UPDATE tenants SET status = $2, updated_at = $3 WHERE id = $1`,
        [input.tenantId, input.tenantStatus, input.entitlements.updatedAt],
      );
      if ((tenant.rowCount ?? 0) === 0) {
        throw new Error('Customer entitlement references a missing tenant');
      }
      if (input.entitlements.status === 'suspended') {
        await client.query(
          `UPDATE api_keys SET status = 'disabled'
            WHERE tenant_id = $1 AND status = 'active'`,
          [input.tenantId],
        );
      }
      return true;
    });
  }

  public async listBusinessInquiries(): Promise<
    readonly BusinessInquirySummary[]
  > {
    const result = await this.pool.query<BusinessInquiryRow>(
      `SELECT id, name, email, company, message, status, request_id,
              consented_at, created_at, updated_at
         FROM business_inquiries
        WHERE status <> 'deleted'
        ORDER BY created_at DESC, id`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      company: row.company,
      message: row.message,
      status: row.status,
      requestId: row.request_id,
      consentedAt: row.consented_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public async updateBusinessInquiryStatus(
    id: string,
    status: 'in_progress' | 'closed' | 'deleted',
    updatedAt: Date,
  ): Promise<boolean> {
    if (status === 'deleted') {
      const deleted = await this.pool.query(
        'DELETE FROM business_inquiries WHERE id = $1',
        [id],
      );
      return (deleted.rowCount ?? 0) > 0;
    }
    const result = await this.pool.query(
      `UPDATE business_inquiries SET status = $2, updated_at = $3
        WHERE id = $1 AND status <> 'deleted'`,
      [id, status, updatedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export class PostgresCustomerAuditRepository implements CustomerAuditRepository {
  public constructor(private readonly pool: Pool) {}

  public async append(event: CustomerAuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO customer_audit_events
         (id, actor_customer_user_id, tenant_id, action, target_type,
          target_id, request_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        event.id,
        event.actorCustomerUserId,
        event.tenantId,
        event.action,
        event.targetType,
        event.targetId,
        event.requestId,
        JSON.stringify(event.metadata),
        event.createdAt,
      ],
    );
  }
}
