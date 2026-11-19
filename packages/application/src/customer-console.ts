import {
  apiKeyId,
  customerSessionId,
  customerUserId,
  tenantId,
  type BusinessInquiry,
  type CustomerAuditRepository,
  type CustomerControlRepository,
  type CustomerIdentityRepository,
  type CustomerTenantEntitlements,
  type CustomerTokenHash,
  type CustomerUser,
  type CustomerUserId,
  type ApiKey,
  type ApiKeyEnvironment,
  type Tenant,
  type TenantId,
} from '@rax-digital/domain';

import type { ApiKeyProvisionerPort } from './admin-console.js';

export interface CustomerSecurityPort {
  readonly dummyPasswordHash: string;
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, encoded: string): Promise<boolean>;
  generateOpaqueToken(): string;
  hashOpaqueToken(token: string): CustomerTokenHash;
  verifyOpaqueToken(token: string, expected: CustomerTokenHash): boolean;
}

export interface CustomerMailerPort {
  sendEmailVerification(input: {
    readonly email: string;
    readonly displayName: string;
    readonly verificationToken: string;
  }): Promise<void>;
  sendPasswordReset(input: {
    readonly email: string;
    readonly displayName: string;
    readonly resetToken: string;
  }): Promise<void>;
}

export interface CustomerPrincipal {
  readonly id: CustomerUserId;
  readonly tenantId: TenantId;
  readonly email: string;
  readonly displayName: string;
}

export type CustomerLoginResult =
  | {
      readonly ok: true;
      readonly sessionToken: string;
      readonly csrfToken: string;
      readonly expiresAt: Date;
      readonly principal: CustomerPrincipal;
    }
  | { readonly ok: false; readonly reason: 'invalid_credentials' };

export interface CustomerConsoleServiceOptions {
  readonly environment: ApiKeyEnvironment;
  readonly sessionTtlMs?: number;
  readonly verificationTtlMs?: number;
  readonly passwordResetTtlMs?: number;
  readonly lockAfterFailures?: number;
  readonly lockDurationMs?: number;
  readonly clock?: () => Date;
  readonly idGenerator: () => string;
}

export class CustomerInputError extends Error {
  public constructor(
    public readonly code:
      | 'account_exists'
      | 'account_unavailable'
      | 'email_delivery_failed'
      | 'entitlement_unavailable'
      | 'key_limit_reached'
      | 'token_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'CustomerInputError';
  }
}

const defaultSessionTtlMs = 8 * 60 * 60 * 1_000;
const defaultVerificationTtlMs = 24 * 60 * 60 * 1_000;
const defaultPasswordResetTtlMs = 60 * 60 * 1_000;
const defaultLockDurationMs = 15 * 60 * 1_000;

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new TypeError('A valid email address is required');
  }
  return normalized;
}

function validatePassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 12 || length > 128) {
    throw new TypeError('Passwords must contain 12 to 128 characters');
  }
}

function validateName(value: string, label: string, maximum = 100): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum) {
    throw new TypeError(
      `${label} must contain 1 to ${String(maximum)} characters`,
    );
  }
  return normalized;
}

function principal(user: CustomerUser): CustomerPrincipal {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    displayName: user.displayName,
  };
}

/** Hosted customer identity, entitlement, and tenant-scoped key lifecycle. */
export class CustomerConsoleService {
  private readonly sessionTtlMs: number;
  private readonly verificationTtlMs: number;
  private readonly passwordResetTtlMs: number;
  private readonly lockAfterFailures: number;
  private readonly lockDurationMs: number;
  private readonly clock: () => Date;

  public constructor(
    private readonly identities: CustomerIdentityRepository,
    private readonly controls: CustomerControlRepository,
    private readonly audits: CustomerAuditRepository,
    private readonly security: CustomerSecurityPort,
    private readonly mailer: CustomerMailerPort,
    private readonly apiKeyProvisioner: ApiKeyProvisionerPort,
    private readonly options: CustomerConsoleServiceOptions,
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? defaultSessionTtlMs;
    this.verificationTtlMs =
      options.verificationTtlMs ?? defaultVerificationTtlMs;
    this.passwordResetTtlMs =
      options.passwordResetTtlMs ?? defaultPasswordResetTtlMs;
    this.lockAfterFailures = options.lockAfterFailures ?? 5;
    this.lockDurationMs = options.lockDurationMs ?? defaultLockDurationMs;
    this.clock = options.clock ?? (() => new Date());
  }

  public async register(input: {
    readonly email: string;
    readonly displayName: string;
    readonly organizationName: string;
    readonly password: string;
    readonly requestId: string;
  }): Promise<void> {
    const email = normalizeEmail(input.email);
    const displayName = validateName(input.displayName, 'Display name');
    const organizationName = validateName(
      input.organizationName,
      'Organization name',
      160,
    );
    validatePassword(input.password);
    if ((await this.identities.findUserByEmail(email)) !== null) {
      throw new CustomerInputError(
        'account_exists',
        'An account already exists for this email address.',
      );
    }

    const now = this.clock();
    const userId = customerUserId(this.options.idGenerator());
    const registrationTenantId = tenantId(this.options.idGenerator());
    const verificationToken = this.security.generateOpaqueToken();
    const tenant: Tenant = {
      id: registrationTenantId,
      name: organizationName,
      status: 'disabled',
      createdAt: now,
      updatedAt: now,
    };
    const user: CustomerUser = {
      id: userId,
      tenantId: registrationTenantId,
      email,
      displayName,
      passwordHash: await this.security.hashPassword(input.password),
      status: 'pending_verification',
      emailVerifiedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const entitlements: CustomerTenantEntitlements = {
      tenantId: registrationTenantId,
      status: 'pending',
      planCode: 'private_beta',
      policy: {
        allowedModelPatterns: [],
        allowStreaming: false,
        allowTools: false,
        requestsPerMinute: 1,
        maxConcurrentRequests: 1,
        maxRequestTokens: 2_048,
        maxOutputTokens: 256,
      },
      maxActiveApiKeys: 1,
      keyTtlDays: 30,
      createdAt: now,
      updatedAt: now,
    };
    await this.identities.createRegistration({
      tenant,
      user,
      entitlements,
      verification: {
        id: this.options.idGenerator(),
        userId,
        purpose: 'verify_email',
        tokenHash: this.security.hashOpaqueToken(verificationToken),
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.verificationTtlMs),
      },
    });
    await this.audit(
      userId,
      registrationTenantId,
      'customer.registered',
      'customer_user',
      userId,
      input.requestId,
      {},
    );
    try {
      await this.mailer.sendEmailVerification({
        email,
        displayName,
        verificationToken,
      });
    } catch {
      throw new CustomerInputError(
        'email_delivery_failed',
        'The account was created, but the verification email could not be sent.',
      );
    }
  }

  public async verifyEmail(token: string, requestId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const user = await this.identities.verifyEmail(
      this.security.hashOpaqueToken(token),
      this.clock(),
    );
    if (user === null) return false;
    await this.audit(
      user.id,
      user.tenantId,
      'customer.email_verified',
      'customer_user',
      user.id,
      requestId,
      {},
    );
    return true;
  }

  public async resendVerification(emailInput: string): Promise<void> {
    let email: string;
    try {
      email = normalizeEmail(emailInput);
    } catch {
      return;
    }
    const user = await this.identities.findUserByEmail(email);
    if (user?.status !== 'pending_verification') return;
    const now = this.clock();
    const verificationToken = this.security.generateOpaqueToken();
    await this.identities.replaceOneTimeToken({
      id: this.options.idGenerator(),
      userId: user.id,
      purpose: 'verify_email',
      tokenHash: this.security.hashOpaqueToken(verificationToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.verificationTtlMs),
    });
    try {
      await this.mailer.sendEmailVerification({
        email: user.email,
        displayName: user.displayName,
        verificationToken,
      });
    } catch {
      // Keep the response indistinguishable from an unknown address. A later
      // retry replaces this token, so no undelivered credential remains valid.
    }
  }

  public async login(input: {
    readonly email: string;
    readonly password: string;
    readonly requestId: string;
  }): Promise<CustomerLoginResult> {
    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch {
      email = 'invalid@example.invalid';
    }
    const now = this.clock();
    const user = await this.identities.findUserByEmail(email);
    const passwordMatches = await this.security.verifyPassword(
      input.password,
      user?.passwordHash ?? this.security.dummyPasswordHash,
    );
    const locked =
      user?.lockedUntil !== null &&
      user?.lockedUntil !== undefined &&
      user.lockedUntil.getTime() > now.getTime();
    if (
      user === null ||
      !passwordMatches ||
      user.status !== 'active' ||
      user.emailVerifiedAt === null ||
      locked
    ) {
      if (user !== null && user.status === 'active' && !locked) {
        await this.identities.recordLoginFailure(
          user.id,
          now,
          this.lockAfterFailures,
          this.lockDurationMs,
        );
      }
      await this.audit(
        user?.id ?? null,
        user?.tenantId ?? null,
        'customer.login_failed',
        'customer_session',
        null,
        input.requestId,
        {},
      );
      return { ok: false, reason: 'invalid_credentials' };
    }
    const sessionToken = this.security.generateOpaqueToken();
    const csrfToken = this.security.generateOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await this.identities.recordLoginSuccess(user.id, now);
    await this.identities.createSession({
      id: customerSessionId(this.options.idGenerator()),
      userId: user.id,
      tokenHash: this.security.hashOpaqueToken(sessionToken),
      csrfTokenHash: this.security.hashOpaqueToken(csrfToken),
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
    });
    await this.audit(
      user.id,
      user.tenantId,
      'customer.login_succeeded',
      'customer_session',
      null,
      input.requestId,
      {},
    );
    return {
      ok: true,
      sessionToken,
      csrfToken,
      expiresAt,
      principal: principal(user),
    };
  }

  public async authenticate(
    sessionToken: string,
  ): Promise<CustomerPrincipal | null> {
    const record = await this.sessionRecord(sessionToken);
    return record === null ? null : principal(record.user);
  }

  public async authorizeMutation(
    sessionToken: string,
    csrfToken: string,
  ): Promise<CustomerPrincipal | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(csrfToken)) return null;
    const record = await this.sessionRecord(sessionToken);
    if (
      record === null ||
      !this.security.verifyOpaqueToken(csrfToken, record.session.csrfTokenHash)
    ) {
      return null;
    }
    return principal(record.user);
  }

  public async logout(
    sessionToken: string,
    actor: CustomerPrincipal,
    requestId: string,
  ): Promise<void> {
    await this.identities.deleteSessionByTokenHash(
      this.security.hashOpaqueToken(sessionToken),
    );
    await this.audit(
      actor.id,
      actor.tenantId,
      'customer.logout',
      'customer_session',
      null,
      requestId,
      {},
    );
  }

  public async requestPasswordReset(emailInput: string): Promise<void> {
    let email: string;
    try {
      email = normalizeEmail(emailInput);
    } catch {
      return;
    }
    const user = await this.identities.findUserByEmail(email);
    if (user?.status !== 'active' || user.emailVerifiedAt === null) return;
    const now = this.clock();
    const resetToken = this.security.generateOpaqueToken();
    await this.identities.replaceOneTimeToken({
      id: this.options.idGenerator(),
      userId: user.id,
      purpose: 'reset_password',
      tokenHash: this.security.hashOpaqueToken(resetToken),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.passwordResetTtlMs),
    });
    try {
      await this.mailer.sendPasswordReset({
        email: user.email,
        displayName: user.displayName,
        resetToken,
      });
    } catch {
      // Password recovery must not reveal whether an address has an account.
    }
  }

  public async resetPassword(input: {
    readonly token: string;
    readonly password: string;
    readonly requestId: string;
  }): Promise<boolean> {
    validatePassword(input.password);
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) return false;
    const user = await this.identities.resetPassword(
      this.security.hashOpaqueToken(input.token),
      await this.security.hashPassword(input.password),
      this.clock(),
    );
    if (user === null) return false;
    await this.identities.deleteSessionsForUser(user.id);
    await this.audit(
      user.id,
      user.tenantId,
      'customer.password_reset',
      'customer_user',
      user.id,
      input.requestId,
      {},
    );
    return true;
  }

  public async dashboard(actor: CustomerPrincipal) {
    const [entitlements, keys] = await Promise.all([
      this.controls.findEntitlements(actor.tenantId),
      this.controls.listApiKeys(actor.tenantId),
    ]);
    return { entitlements, keys };
  }

  public async createApiKey(input: {
    readonly actor: CustomerPrincipal;
    readonly name: string;
    readonly requestId: string;
  }): Promise<{ readonly credential: string; readonly apiKey: ApiKey }> {
    const entitlements = await this.controls.findEntitlements(
      input.actor.tenantId,
    );
    if (
      entitlements?.status !== 'active' ||
      entitlements.policy.allowedModelPatterns.length === 0
    ) {
      throw new CustomerInputError(
        'entitlement_unavailable',
        'This tenant is not approved for API key creation.',
      );
    }
    const now = this.clock();
    const provisioned = this.apiKeyProvisioner.provision({
      id: this.options.idGenerator(),
      tenantId: input.actor.tenantId,
      name: validateName(input.name, 'API key name'),
      environment: this.options.environment,
      policy: entitlements.policy,
      expiresAt: new Date(
        now.getTime() + entitlements.keyTtlDays * 24 * 60 * 60 * 1_000,
      ),
      now,
    });
    const creation = await this.controls.createApiKeyWithinEntitlements(
      provisioned.apiKey,
      now,
    );
    if (creation === 'entitlement_unavailable') {
      throw new CustomerInputError(
        'entitlement_unavailable',
        'This tenant is not approved for API key creation.',
      );
    }
    if (creation === 'limit_reached') {
      throw new CustomerInputError(
        'key_limit_reached',
        'The active API key limit has been reached.',
      );
    }
    await this.audit(
      input.actor.id,
      input.actor.tenantId,
      'customer.api_key_created',
      'api_key',
      provisioned.apiKey.id,
      input.requestId,
      {},
    );
    return provisioned;
  }

  public async revokeApiKey(input: {
    readonly actor: CustomerPrincipal;
    readonly id: string;
    readonly requestId: string;
  }): Promise<boolean> {
    const revoked = await this.controls.revokeApiKey(
      input.actor.tenantId,
      apiKeyId(input.id),
    );
    if (revoked) {
      await this.audit(
        input.actor.id,
        input.actor.tenantId,
        'customer.api_key_revoked',
        'api_key',
        input.id,
        input.requestId,
        {},
      );
    }
    return revoked;
  }

  public async createBusinessInquiry(input: {
    readonly name: string;
    readonly email: string;
    readonly company?: string;
    readonly message: string;
    readonly requestId: string;
  }): Promise<void> {
    const now = this.clock();
    const message = input.message.trim();
    if (message.length < 10 || message.length > 4_000) {
      throw new TypeError('Inquiry message must contain 10 to 4000 characters');
    }
    const inquiry: BusinessInquiry = {
      id: this.options.idGenerator(),
      name: validateName(input.name, 'Name'),
      email: normalizeEmail(input.email),
      company:
        input.company === undefined || input.company.trim() === ''
          ? null
          : validateName(input.company, 'Company', 160),
      message,
      requestId: input.requestId,
      consentedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.controls.createBusinessInquiry(inquiry);
  }

  private async sessionRecord(sessionToken: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
    const record = await this.identities.findSessionByTokenHash(
      this.security.hashOpaqueToken(sessionToken),
      this.clock(),
    );
    if (
      record?.user.status !== 'active' ||
      record.user.emailVerifiedAt === null
    ) {
      return null;
    }
    return record;
  }

  private async audit(
    actorCustomerUserId: CustomerUserId | null,
    auditTenantId: TenantId | null,
    action: string,
    targetType: string,
    targetId: string | null,
    requestId: string,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    await this.audits.append({
      id: this.options.idGenerator(),
      actorCustomerUserId,
      tenantId: auditTenantId,
      action,
      targetType,
      targetId,
      requestId,
      metadata,
      createdAt: this.clock(),
    });
  }
}
