import type {
  AdminApiKeySummary,
  AdminAuditEvent,
  AdminDashboardSummary,
  AdminSession,
  AdminSessionWithUser,
  AdminTokenHash,
  AdminUser,
  AdminUserId,
  Tenant,
} from './admin.js';
import type { TenantId } from './api-key.js';

/** Administrator identity and server-side session persistence port. */
export interface AdminIdentityRepository {
  findUserByEmail(email: string): Promise<AdminUser | null>;
  findUserById(id: AdminUserId): Promise<AdminUser | null>;
  createUser(user: AdminUser): Promise<void>;
  recordLoginSuccess(id: AdminUserId, loggedInAt: Date): Promise<void>;
  recordLoginFailure(
    id: AdminUserId,
    failedAt: Date,
    lockAfterFailures: number,
    lockDurationMs: number,
  ): Promise<void>;
  updatePassword(
    id: AdminUserId,
    passwordHash: string,
    updatedAt: Date,
  ): Promise<void>;
  createSession(session: AdminSession): Promise<void>;
  findSessionByTokenHash(
    tokenHash: AdminTokenHash,
    now: Date,
  ): Promise<AdminSessionWithUser | null>;
  deleteSessionByTokenHash(tokenHash: AdminTokenHash): Promise<void>;
  deleteSessionsForUser(id: AdminUserId): Promise<void>;
}

/** Tenant and safe API-key reporting operations used by the control plane. */
export interface AdminControlRepository {
  listTenants(): Promise<readonly Tenant[]>;
  createTenant(tenant: Tenant): Promise<void>;
  listApiKeys(tenantId?: TenantId): Promise<readonly AdminApiKeySummary[]>;
  dashboardSummary(usedSince: Date): Promise<AdminDashboardSummary>;
}

/** Durable, content-free record of administrator security and mutation events. */
export interface AdminAuditRepository {
  append(event: AdminAuditEvent): Promise<void>;
}
