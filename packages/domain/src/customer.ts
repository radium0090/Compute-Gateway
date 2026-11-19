import type { ApiKeyEnvironment, ApiKeyPolicy, TenantId } from './api-key.js';

declare const customerBrand: unique symbol;

type CustomerBrand<Value, Name extends string> = Value & {
  readonly [customerBrand]: Name;
};

export type CustomerUserId = CustomerBrand<string, 'CustomerUserId'>;
export type CustomerSessionId = CustomerBrand<string, 'CustomerSessionId'>;
export type CustomerTokenHash = CustomerBrand<string, 'CustomerTokenHash'>;
export type CustomerUserStatus = 'pending_verification' | 'active' | 'disabled';
export type CustomerTokenPurpose = 'verify_email' | 'reset_password';
export type CustomerEntitlementStatus = 'pending' | 'active' | 'suspended';

/** Long-lived hosted customer identity, separate from operator accounts. */
export interface CustomerUser {
  readonly id: CustomerUserId;
  readonly tenantId: TenantId;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly status: CustomerUserStatus;
  readonly emailVerifiedAt: Date | null;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Opaque, server-side customer browser session. */
export interface CustomerSession {
  readonly id: CustomerSessionId;
  readonly userId: CustomerUserId;
  readonly tokenHash: CustomerTokenHash;
  readonly csrfTokenHash: CustomerTokenHash;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}

export interface CustomerSessionWithUser {
  readonly session: CustomerSession;
  readonly user: CustomerUser;
}

export interface CustomerOneTimeToken {
  readonly id: string;
  readonly userId: CustomerUserId;
  readonly purpose: CustomerTokenPurpose;
  readonly tokenHash: CustomerTokenHash;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Operator-assigned ceiling used when a customer provisions an API key. */
export interface CustomerTenantEntitlements {
  readonly tenantId: TenantId;
  readonly status: CustomerEntitlementStatus;
  readonly planCode: string;
  readonly policy: ApiKeyPolicy;
  readonly maxActiveApiKeys: number;
  readonly keyTtlDays: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomerApiKeySummary {
  readonly id: string;
  readonly publicId: string;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  readonly status: 'active' | 'disabled' | 'revoked';
  readonly policy: ApiKeyPolicy;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface BusinessInquiry {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly company: string | null;
  readonly message: string;
  readonly requestId: string;
  readonly consentedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomerAuditEvent {
  readonly id: string;
  readonly actorCustomerUserId: CustomerUserId | null;
  readonly tenantId: TenantId | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly requestId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: Date;
}

export interface CustomerAccountSummary {
  readonly userId: CustomerUserId;
  readonly tenantId: TenantId;
  readonly tenantName: string;
  readonly tenantStatus: 'active' | 'disabled';
  readonly email: string;
  readonly displayName: string;
  readonly userStatus: CustomerUserStatus;
  readonly emailVerifiedAt: Date | null;
  readonly entitlements: CustomerTenantEntitlements;
  readonly createdAt: Date;
}

export interface BusinessInquirySummary extends BusinessInquiry {
  readonly status: 'new' | 'in_progress' | 'closed' | 'deleted';
}

export function customerUserId(value: string): CustomerUserId {
  return value as CustomerUserId;
}

export function customerSessionId(value: string): CustomerSessionId {
  return value as CustomerSessionId;
}

export function customerTokenHash(value: string): CustomerTokenHash {
  return value as CustomerTokenHash;
}
