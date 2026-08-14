import type { Pool } from 'pg';

import {
  adminSessionId,
  adminTokenHash,
  adminUserId,
  apiKeyId,
  apiKeyPublicId,
  tenantId,
  type AdminApiKeySummary,
  type AdminAuditEvent,
  type AdminAuditRepository,
  type AdminControlRepository,
  type AdminDashboardSummary,
  type AdminIdentityRepository,
  type AdminSession,
  type AdminSessionWithUser,
  type AdminTokenHash,
  type AdminUser,
  type AdminUserId,
  type ApiKeyEnvironment,
  type ApiKeyPolicy,
  type ApiKeyStatus,
  type Tenant,
  type TenantId,
  type TenantStatus,
} from '@rax-digital/domain';

interface AdminUserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly password_hash: string;
  readonly status: 'active' | 'disabled';
  readonly must_change_password: boolean;
  readonly failed_login_count: number;
  readonly locked_until: Date | null;
  readonly last_login_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SessionUserRow extends AdminUserRow {
  readonly session_id: string;
  readonly session_user_id: string;
  readonly token_hash: string;
  readonly csrf_token_hash: string;
  readonly session_created_at: Date;
  readonly expires_at: Date;
  readonly last_seen_at: Date;
}

interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ApiKeySummaryRow {
  readonly id: string;
  readonly public_id: string;
  readonly tenant_id: string;
  readonly tenant_name: string;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  readonly status: ApiKeyStatus;
  readonly policy: unknown;
  readonly created_at: Date;
  readonly expires_at: Date | null;
  readonly last_used_at: Date | null;
}

interface DashboardRow {
  readonly tenant_count: string;
  readonly active_tenant_count: string;
  readonly api_key_count: string;
  readonly active_api_key_count: string;
  readonly api_keys_used_since: string;
}

function mapUser(row: AdminUserRow): AdminUser {
  return {
    id: adminUserId(row.id),
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status,
    mustChangePassword: row.must_change_password,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTenant(row: TenantRow): Tenant {
  return {
    id: tenantId(row.id),
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parsePolicy(value: unknown): ApiKeyPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Persisted API key policy is invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const patterns = record.allowedModelPatterns;
  if (
    !Array.isArray(patterns) ||
    !patterns.every((pattern) => typeof pattern === 'string') ||
    typeof record.allowStreaming !== 'boolean' ||
    typeof record.allowTools !== 'boolean' ||
    !isPositiveInteger(record.requestsPerMinute) ||
    !isPositiveInteger(record.maxConcurrentRequests)
  ) {
    throw new TypeError('Persisted API key policy is invalid');
  }
  return {
    allowedModelPatterns: patterns,
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

/** PostgreSQL administrator identities and opaque sessions. */
export class PostgresAdminIdentityRepository implements AdminIdentityRepository {
  public constructor(private readonly pool: Pool) {}

  public async findUserByEmail(email: string): Promise<AdminUser | null> {
    const result = await this.pool.query<AdminUserRow>(
      `SELECT id, email, display_name, password_hash, status,
              must_change_password, failed_login_count, locked_until,
              last_login_at, created_at, updated_at
         FROM admin_users
        WHERE email = $1`,
      [email],
    );
    return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
  }

  public async findUserById(id: AdminUserId): Promise<AdminUser | null> {
    const result = await this.pool.query<AdminUserRow>(
      `SELECT id, email, display_name, password_hash, status,
              must_change_password, failed_login_count, locked_until,
              last_login_at, created_at, updated_at
         FROM admin_users
        WHERE id = $1`,
      [id],
    );
    return result.rows[0] === undefined ? null : mapUser(result.rows[0]);
  }

  public async createUser(user: AdminUser): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_users
         (id, email, display_name, password_hash, status,
          must_change_password, failed_login_count, locked_until,
          last_login_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        user.id,
        user.email,
        user.displayName,
        user.passwordHash,
        user.status,
        user.mustChangePassword,
        user.failedLoginCount,
        user.lockedUntil,
        user.lastLoginAt,
        user.createdAt,
        user.updatedAt,
      ],
    );
  }

  public async recordLoginSuccess(
    id: AdminUserId,
    loggedInAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE admin_users
          SET failed_login_count = 0,
              locked_until = NULL,
              last_login_at = $2,
              updated_at = $2
        WHERE id = $1`,
      [id, loggedInAt],
    );
  }

  public async recordLoginFailure(
    id: AdminUserId,
    failedAt: Date,
    lockAfterFailures: number,
    lockDurationMs: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE admin_users
          SET failed_login_count = CASE
                WHEN locked_until IS NOT NULL AND locked_until <= $2
                  THEN 1
                ELSE failed_login_count + 1
              END,
              locked_until = CASE
                WHEN (CASE
                  WHEN locked_until IS NOT NULL AND locked_until <= $2
                    THEN 1
                  ELSE failed_login_count + 1
                END) >= $3
                  THEN $2::timestamptz + ($4 * interval '1 millisecond')
                WHEN locked_until IS NOT NULL AND locked_until <= $2
                  THEN NULL
                ELSE locked_until
              END,
              updated_at = $2
        WHERE id = $1`,
      [id, failedAt, lockAfterFailures, lockDurationMs],
    );
  }

  public async updatePassword(
    id: AdminUserId,
    passwordHash: string,
    updatedAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE admin_users
          SET password_hash = $2,
              must_change_password = false,
              failed_login_count = 0,
              locked_until = NULL,
              updated_at = $3
        WHERE id = $1`,
      [id, passwordHash, updatedAt],
    );
  }

  public async createSession(session: AdminSession): Promise<void> {
    await this.pool.query('DELETE FROM admin_sessions WHERE expires_at <= $1', [
      session.createdAt,
    ]);
    await this.pool.query(
      `DELETE FROM admin_sessions
        WHERE user_id = $1
          AND id NOT IN (
            SELECT id
              FROM admin_sessions
             WHERE user_id = $1
             ORDER BY created_at DESC, id
             LIMIT 4
          )`,
      [session.userId],
    );
    await this.pool.query(
      `INSERT INTO admin_sessions
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
  }

  public async findSessionByTokenHash(
    tokenHash: AdminTokenHash,
    now: Date,
  ): Promise<AdminSessionWithUser | null> {
    const result = await this.pool.query<SessionUserRow>(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.status,
              u.must_change_password, u.failed_login_count, u.locked_until,
              u.last_login_at, u.created_at, u.updated_at,
              s.id AS session_id, s.user_id AS session_user_id,
              s.token_hash, s.csrf_token_hash,
              s.created_at AS session_created_at, s.expires_at, s.last_seen_at
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > $2`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      user: mapUser(row),
      session: {
        id: adminSessionId(row.session_id),
        userId: adminUserId(row.session_user_id),
        tokenHash: adminTokenHash(row.token_hash),
        csrfTokenHash: adminTokenHash(row.csrf_token_hash),
        createdAt: row.session_created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
      },
    };
  }

  public async deleteSessionByTokenHash(
    tokenHash: AdminTokenHash,
  ): Promise<void> {
    await this.pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [
      tokenHash,
    ]);
  }

  public async deleteSessionsForUser(id: AdminUserId): Promise<void> {
    await this.pool.query('DELETE FROM admin_sessions WHERE user_id = $1', [
      id,
    ]);
  }
}

/** PostgreSQL tenant and safe API-key reporting operations. */
export class PostgresAdminControlRepository implements AdminControlRepository {
  public constructor(private readonly pool: Pool) {}

  public async listTenants(): Promise<readonly Tenant[]> {
    const result = await this.pool.query<TenantRow>(
      `SELECT id, name, status, created_at, updated_at
         FROM tenants
        ORDER BY lower(name), id`,
    );
    return result.rows.map(mapTenant);
  }

  public async createTenant(tenant: Tenant): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenants (id, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenant.id,
        tenant.name,
        tenant.status,
        tenant.createdAt,
        tenant.updatedAt,
      ],
    );
  }

  public async listApiKeys(
    selectedTenantId?: TenantId,
  ): Promise<readonly AdminApiKeySummary[]> {
    const result = await this.pool.query<ApiKeySummaryRow>(
      `SELECT k.id, k.public_id, k.tenant_id, t.name AS tenant_name,
              k.name, k.environment, k.status, k.policy, k.created_at,
              k.expires_at, k.last_used_at
         FROM api_keys k
         JOIN tenants t ON t.id = k.tenant_id
        WHERE ($1::uuid IS NULL OR k.tenant_id = $1)
        ORDER BY k.created_at DESC, k.id`,
      [selectedTenantId ?? null],
    );
    return result.rows.map((row) => ({
      id: apiKeyId(row.id),
      publicId: apiKeyPublicId(row.public_id),
      tenantId: tenantId(row.tenant_id),
      tenantName: row.tenant_name,
      name: row.name,
      environment: row.environment,
      status: row.status,
      policy: parsePolicy(row.policy),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  public async dashboardSummary(
    usedSince: Date,
  ): Promise<AdminDashboardSummary> {
    const result = await this.pool.query<DashboardRow>(
      `SELECT
         (SELECT count(*) FROM tenants)::text AS tenant_count,
         (SELECT count(*) FROM tenants WHERE status = 'active')::text
           AS active_tenant_count,
         (SELECT count(*) FROM api_keys)::text AS api_key_count,
         (SELECT count(*) FROM api_keys WHERE status = 'active')::text
           AS active_api_key_count,
         (SELECT count(*) FROM api_keys WHERE last_used_at >= $1)::text
           AS api_keys_used_since`,
      [usedSince],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error('Dashboard summary query returned no row');
    return {
      tenantCount: Number(row.tenant_count),
      activeTenantCount: Number(row.active_tenant_count),
      apiKeyCount: Number(row.api_key_count),
      activeApiKeyCount: Number(row.active_api_key_count),
      apiKeysUsedSince: Number(row.api_keys_used_since),
    };
  }
}

/** PostgreSQL append-only administrator audit event store. */
export class PostgresAdminAuditRepository implements AdminAuditRepository {
  public constructor(private readonly pool: Pool) {}

  public async append(event: AdminAuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO operator_audit_events
         (id, actor_admin_user_id, action, target_type, target_id, request_id,
          metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        event.id,
        event.actorAdminUserId,
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
