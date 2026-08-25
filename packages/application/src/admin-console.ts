import {
  adminSessionId,
  adminUserId,
  apiKeyId,
  tenantId,
  type AdminAuditRepository,
  type AdminControlRepository,
  type AdminDashboardSummary,
  type AdminIdentityRepository,
  type AdminTokenHash,
  type AdminUser,
  type AdminUserId,
  type ApiKey,
  type ApiKeyEnvironment,
  type ApiKeyPolicy,
  type ApiKeyRepository,
  type Tenant,
  type TenantId,
} from '@rax-digital/domain';

export interface AdminSecurityPort {
  readonly dummyPasswordHash: string;
  hashPassword(password: string): Promise<string>;
  verifyPassword(password: string, encoded: string): Promise<boolean>;
  generateOpaqueToken(): string;
  hashOpaqueToken(token: string): AdminTokenHash;
  verifyOpaqueToken(token: string, expected: AdminTokenHash): boolean;
}

export interface ApiKeyProvisionerPort {
  provision(input: {
    readonly id: string;
    readonly tenantId: TenantId;
    readonly name: string;
    readonly environment: ApiKeyEnvironment;
    readonly policy: ApiKeyPolicy;
    readonly expiresAt: Date | null;
    readonly now: Date;
  }): { readonly credential: string; readonly apiKey: ApiKey };
}

export interface AdminPrincipal {
  readonly id: AdminUserId;
  readonly email: string;
  readonly displayName: string;
  readonly mustChangePassword: boolean;
}

export interface AdminLoginSuccess {
  readonly ok: true;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
  readonly principal: AdminPrincipal;
}

export type AdminLoginResult =
  | AdminLoginSuccess
  | { readonly ok: false; readonly reason: 'invalid_credentials' };

export interface AdminConsoleServiceOptions {
  readonly sessionTtlMs?: number;
  readonly lockAfterFailures?: number;
  readonly lockDurationMs?: number;
  readonly clock?: () => Date;
  readonly idGenerator: () => string;
}

export interface CreateAdminApiKeyInput {
  readonly tenantId: string;
  readonly name: string;
  readonly environment: ApiKeyEnvironment;
  readonly allowedModelPatterns: readonly string[];
  readonly allowStreaming: boolean;
  readonly allowTools?: boolean;
  readonly requestsPerMinute: number;
  readonly maxConcurrentRequests: number;
  readonly expiresAt: Date | null;
}

const defaultSessionTtlMs = 8 * 60 * 60 * 1_000;
const defaultLockDurationMs = 15 * 60 * 1_000;

export class AdminInputError extends Error {
  public constructor(
    public readonly code: 'tenant_invalid' | 'expiry_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AdminInputError';
  }
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new TypeError('A valid administrator email is required');
  }
  return normalized;
}

function validatePassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 15 || length > 128) {
    throw new TypeError(
      'Administrator passwords must contain 15 to 128 characters',
    );
  }
}

function validateName(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 100) {
    throw new TypeError(`${label} must contain 1 to 100 characters`);
  }
  return normalized;
}

function principal(user: AdminUser): AdminPrincipal {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    mustChangePassword: user.mustChangePassword,
  };
}

/** Application service for the authenticated, content-free operator console. */
export class AdminConsoleService {
  private readonly sessionTtlMs: number;
  private readonly lockAfterFailures: number;
  private readonly lockDurationMs: number;
  private readonly clock: () => Date;

  public constructor(
    private readonly identities: AdminIdentityRepository,
    private readonly controls: AdminControlRepository,
    private readonly apiKeys: ApiKeyRepository,
    private readonly audits: AdminAuditRepository,
    private readonly security: AdminSecurityPort,
    private readonly apiKeyProvisioner: ApiKeyProvisionerPort,
    private readonly options: AdminConsoleServiceOptions,
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? defaultSessionTtlMs;
    this.lockAfterFailures = options.lockAfterFailures ?? 5;
    this.lockDurationMs = options.lockDurationMs ?? defaultLockDurationMs;
    this.clock = options.clock ?? (() => new Date());
  }

  public async bootstrapAdmin(input: {
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
  }): Promise<AdminPrincipal> {
    const email = normalizeEmail(input.email);
    const displayName = validateName(input.displayName, 'Display name');
    validatePassword(input.password);
    if ((await this.identities.findUserByEmail(email)) !== null) {
      throw new Error('Administrator already exists');
    }
    const now = this.clock();
    const user: AdminUser = {
      id: adminUserId(this.options.idGenerator()),
      email,
      displayName,
      passwordHash: await this.security.hashPassword(input.password),
      status: 'active',
      mustChangePassword: true,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.identities.createUser(user);
    await this.audit(
      user.id,
      'admin.user_created',
      'admin_user',
      user.id,
      'bootstrap',
      {},
    );
    return principal(user);
  }

  public async login(input: {
    readonly email: string;
    readonly password: string;
    readonly requestId: string;
  }): Promise<AdminLoginResult> {
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
        'admin.login_failed',
        'admin_session',
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
      id: adminSessionId(this.options.idGenerator()),
      userId: user.id,
      tokenHash: this.security.hashOpaqueToken(sessionToken),
      csrfTokenHash: this.security.hashOpaqueToken(csrfToken),
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
    });
    await this.audit(
      user.id,
      'admin.login_succeeded',
      'admin_session',
      null,
      input.requestId,
      {},
    );
    return {
      ok: true,
      sessionToken,
      csrfToken,
      expiresAt,
      principal: principal({
        ...user,
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: now,
      }),
    };
  }

  public async authenticate(
    sessionToken: string,
  ): Promise<AdminPrincipal | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
    const record = await this.identities.findSessionByTokenHash(
      this.security.hashOpaqueToken(sessionToken),
      this.clock(),
    );
    if (record?.user.status !== 'active') return null;
    return principal(record.user);
  }

  public async authorizeMutation(
    sessionToken: string,
    csrfToken: string,
  ): Promise<AdminPrincipal | null> {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(sessionToken) ||
      !/^[A-Za-z0-9_-]{43}$/.test(csrfToken)
    ) {
      return null;
    }
    const record = await this.identities.findSessionByTokenHash(
      this.security.hashOpaqueToken(sessionToken),
      this.clock(),
    );
    if (
      record?.user.status !== 'active' ||
      !this.security.verifyOpaqueToken(csrfToken, record.session.csrfTokenHash)
    ) {
      return null;
    }
    return principal(record.user);
  }

  public async logout(
    sessionToken: string,
    actor: AdminPrincipal,
    requestId: string,
  ): Promise<void> {
    await this.identities.deleteSessionByTokenHash(
      this.security.hashOpaqueToken(sessionToken),
    );
    await this.audit(
      actor.id,
      'admin.logout',
      'admin_session',
      null,
      requestId,
      {},
    );
  }

  public async changePassword(input: {
    readonly actor: AdminPrincipal;
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly requestId: string;
  }): Promise<boolean> {
    validatePassword(input.newPassword);
    const user = await this.identities.findUserById(input.actor.id);
    if (
      user === null ||
      !(await this.security.verifyPassword(
        input.currentPassword,
        user.passwordHash,
      ))
    ) {
      return false;
    }
    const now = this.clock();
    await this.identities.updatePassword(
      user.id,
      await this.security.hashPassword(input.newPassword),
      now,
    );
    await this.identities.deleteSessionsForUser(user.id);
    await this.audit(
      user.id,
      'admin.password_changed',
      'admin_user',
      user.id,
      input.requestId,
      {},
    );
    return true;
  }

  public dashboardSummary(): Promise<AdminDashboardSummary> {
    return this.controls.dashboardSummary(
      new Date(this.clock().getTime() - 24 * 60 * 60 * 1_000),
    );
  }

  public listTenants() {
    return this.controls.listTenants();
  }

  public listApiKeys(tenant?: string) {
    return this.controls.listApiKeys(
      tenant === undefined ? undefined : tenantId(tenant),
    );
  }

  public async createTenant(input: {
    readonly actor: AdminPrincipal;
    readonly name: string;
    readonly requestId: string;
  }): Promise<Tenant> {
    const now = this.clock();
    const tenant: Tenant = {
      id: tenantId(this.options.idGenerator()),
      name: validateName(input.name, 'Tenant name'),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await this.controls.createTenant(tenant);
    await this.audit(
      input.actor.id,
      'tenant.created',
      'tenant',
      tenant.id,
      input.requestId,
      {},
    );
    return tenant;
  }

  public async createApiKey(input: {
    readonly actor: AdminPrincipal;
    readonly value: CreateAdminApiKeyInput;
    readonly requestId: string;
  }) {
    const selectedTenant = (await this.controls.listTenants()).find(
      (candidate) => candidate.id === input.value.tenantId,
    );
    if (selectedTenant?.status !== 'active') {
      throw new AdminInputError('tenant_invalid', 'Select an active tenant.');
    }
    const now = this.clock();
    if (
      input.value.expiresAt !== null &&
      input.value.expiresAt.getTime() <= now.getTime()
    ) {
      throw new AdminInputError(
        'expiry_invalid',
        'The expiry must be in the future.',
      );
    }
    const provisioned = this.apiKeyProvisioner.provision({
      id: this.options.idGenerator(),
      tenantId: tenantId(input.value.tenantId),
      name: validateName(input.value.name, 'API key name'),
      environment: input.value.environment,
      policy: {
        allowedModelPatterns: input.value.allowedModelPatterns,
        allowStreaming: input.value.allowStreaming,
        allowTools: input.value.allowTools ?? false,
        requestsPerMinute: input.value.requestsPerMinute,
        maxConcurrentRequests: input.value.maxConcurrentRequests,
      },
      expiresAt: input.value.expiresAt,
      now,
    });
    await this.apiKeys.create(provisioned.apiKey);
    await this.audit(
      input.actor.id,
      'api_key.created',
      'api_key',
      provisioned.apiKey.id,
      input.requestId,
      { tenant_id: input.value.tenantId },
    );
    return provisioned;
  }

  public async revokeApiKey(input: {
    readonly actor: AdminPrincipal;
    readonly id: string;
    readonly requestId: string;
  }): Promise<boolean> {
    const revoked = await this.apiKeys.revoke(apiKeyId(input.id));
    if (revoked) {
      await this.audit(
        input.actor.id,
        'api_key.revoked',
        'api_key',
        input.id,
        input.requestId,
        {},
      );
    }
    return revoked;
  }

  private async audit(
    actorAdminUserId: AdminUserId | null,
    action: string,
    targetType: string,
    targetId: string | null,
    requestId: string,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    await this.audits.append({
      id: this.options.idGenerator(),
      actorAdminUserId,
      action,
      targetType,
      targetId,
      requestId,
      metadata,
      createdAt: this.clock(),
    });
  }
}
