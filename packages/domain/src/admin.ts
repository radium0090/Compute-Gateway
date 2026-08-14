import type {
  ApiKeyEnvironment,
  ApiKeyId,
  ApiKeyPolicy,
  ApiKeyPublicId,
  ApiKeyStatus,
  TenantId,
} from './api-key.js';

declare const adminBrand: unique symbol;

type AdminBrand<Value, Name extends string> = Value & {
  readonly [adminBrand]: Name;
};

export type AdminUserId = AdminBrand<string, 'AdminUserId'>;
export type AdminSessionId = AdminBrand<string, 'AdminSessionId'>;
export type AdminTokenHash = AdminBrand<string, 'AdminTokenHash'>;
export type AdminUserStatus = 'active' | 'disabled';
export type TenantStatus = 'active' | 'disabled';

/** Persisted administrator identity. Plaintext passwords are never represented. */
export interface AdminUser {
  readonly id: AdminUserId;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly status: AdminUserStatus;
  readonly mustChangePassword: boolean;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Server-side session record containing hashes instead of browser credentials. */
export interface AdminSession {
  readonly id: AdminSessionId;
  readonly userId: AdminUserId;
  readonly tokenHash: AdminTokenHash;
  readonly csrfTokenHash: AdminTokenHash;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}

export interface AdminSessionWithUser {
  readonly session: AdminSession;
  readonly user: AdminUser;
}

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly status: TenantStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Safe API-key metadata returned to the operator console. */
export interface AdminApiKeySummary {
  readonly id: ApiKeyId;
  readonly publicId: ApiKeyPublicId;
  readonly tenantId: TenantId;
  readonly tenantName: string;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  readonly status: ApiKeyStatus;
  readonly policy: ApiKeyPolicy;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
}

/** Content-free operational totals; request bodies and responses never contribute. */
export interface AdminDashboardSummary {
  readonly tenantCount: number;
  readonly activeTenantCount: number;
  readonly apiKeyCount: number;
  readonly activeApiKeyCount: number;
  readonly apiKeysUsedSince: number;
}

export interface AdminAuditEvent {
  readonly id: string;
  readonly actorAdminUserId: AdminUserId | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly requestId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: Date;
}

export function adminUserId(value: string): AdminUserId {
  return value as AdminUserId;
}

export function adminSessionId(value: string): AdminSessionId {
  return value as AdminSessionId;
}

export function adminTokenHash(value: string): AdminTokenHash {
  return value as AdminTokenHash;
}
