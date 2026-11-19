import type { ApiKey, ApiKeyId, TenantId } from './api-key.js';
import type { Tenant } from './admin.js';
import type {
  BusinessInquiry,
  BusinessInquirySummary,
  CustomerAccountSummary,
  CustomerApiKeySummary,
  CustomerAuditEvent,
  CustomerOneTimeToken,
  CustomerSession,
  CustomerSessionWithUser,
  CustomerTenantEntitlements,
  CustomerTokenHash,
  CustomerTokenPurpose,
  CustomerUser,
  CustomerUserId,
} from './customer.js';

/** Transactional customer identity and token persistence boundary. */
export interface CustomerIdentityRepository {
  findUserByEmail(email: string): Promise<CustomerUser | null>;
  findUserById(id: CustomerUserId): Promise<CustomerUser | null>;
  createRegistration(input: {
    readonly tenant: Tenant;
    readonly user: CustomerUser;
    readonly entitlements: CustomerTenantEntitlements;
    readonly verification: CustomerOneTimeToken;
  }): Promise<'created' | 'account_exists'>;
  recordLoginSuccess(id: CustomerUserId, loggedInAt: Date): Promise<void>;
  recordLoginFailure(
    id: CustomerUserId,
    failedAt: Date,
    lockAfterFailures: number,
    lockDurationMs: number,
  ): Promise<void>;
  createSession(session: CustomerSession): Promise<void>;
  findSessionByTokenHash(
    hash: CustomerTokenHash,
    now: Date,
  ): Promise<CustomerSessionWithUser | null>;
  deleteSessionByTokenHash(hash: CustomerTokenHash): Promise<void>;
  deleteSessionsForUser(id: CustomerUserId): Promise<void>;
  replaceOneTimeToken(token: CustomerOneTimeToken): Promise<void>;
  verifyEmail(hash: CustomerTokenHash, now: Date): Promise<CustomerUser | null>;
  resetPassword(
    hash: CustomerTokenHash,
    passwordHash: string,
    now: Date,
  ): Promise<CustomerUser | null>;
}

/** Tenant-scoped metadata and inquiry operations used by the customer surface. */
export interface CustomerControlRepository {
  findEntitlements(
    tenantId: TenantId,
  ): Promise<CustomerTenantEntitlements | null>;
  listApiKeys(tenantId: TenantId): Promise<readonly CustomerApiKeySummary[]>;
  countActiveApiKeys(tenantId: TenantId, now: Date): Promise<number>;
  createApiKeyWithinEntitlements(
    apiKey: ApiKey,
    now: Date,
  ): Promise<'created' | 'entitlement_unavailable' | 'limit_reached'>;
  revokeApiKey(tenantId: TenantId, id: ApiKeyId): Promise<boolean>;
  createBusinessInquiry(inquiry: BusinessInquiry): Promise<void>;
}

export interface CustomerAuditRepository {
  append(event: CustomerAuditEvent): Promise<void>;
}

/** Cross-tenant operator operations kept outside the customer-facing port. */
export interface CustomerAdministrationRepository {
  listCustomerAccounts(): Promise<readonly CustomerAccountSummary[]>;
  setEntitlements(input: {
    readonly tenantId: TenantId;
    readonly tenantStatus: 'active' | 'disabled';
    readonly entitlements: CustomerTenantEntitlements;
  }): Promise<boolean>;
  listBusinessInquiries(): Promise<readonly BusinessInquirySummary[]>;
  updateBusinessInquiryStatus(
    id: string,
    status: 'in_progress' | 'closed' | 'deleted',
    updatedAt: Date,
  ): Promise<boolean>;
}

export type { CustomerTokenPurpose };
