import { describe, expect, it } from 'vitest';

import {
  adminTokenHash,
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
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
  type ApiKey,
  type ApiKeyId,
  type ApiKeyPublicId,
  type ApiKeyRepository,
  type Tenant,
  type TenantId,
} from '@rax-digital/domain';

import { AdminConsoleService } from './admin-console.js';

class MemoryIdentities implements AdminIdentityRepository {
  public readonly users = new Map<string, AdminUser>();
  public readonly sessions = new Map<string, AdminSession>();

  public findUserByEmail(email: string): Promise<AdminUser | null> {
    return Promise.resolve(
      [...this.users.values()].find((user) => user.email === email) ?? null,
    );
  }

  public findUserById(id: AdminUserId): Promise<AdminUser | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }

  public createUser(user: AdminUser): Promise<void> {
    this.users.set(user.id, user);
    return Promise.resolve();
  }

  public recordLoginSuccess(id: AdminUserId, at: Date): Promise<void> {
    const user = this.users.get(id);
    if (user !== undefined) {
      this.users.set(id, {
        ...user,
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: at,
        updatedAt: at,
      });
    }
    return Promise.resolve();
  }

  public recordLoginFailure(
    id: AdminUserId,
    at: Date,
    threshold: number,
    durationMs: number,
  ): Promise<void> {
    const user = this.users.get(id);
    if (user !== undefined) {
      const count = user.failedLoginCount + 1;
      this.users.set(id, {
        ...user,
        failedLoginCount: count,
        lockedUntil:
          count >= threshold
            ? new Date(at.getTime() + durationMs)
            : user.lockedUntil,
        updatedAt: at,
      });
    }
    return Promise.resolve();
  }

  public updatePassword(
    id: AdminUserId,
    passwordHash: string,
    at: Date,
  ): Promise<void> {
    const user = this.users.get(id);
    if (user !== undefined) {
      this.users.set(id, {
        ...user,
        passwordHash,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: at,
      });
    }
    return Promise.resolve();
  }

  public createSession(session: AdminSession): Promise<void> {
    this.sessions.set(session.tokenHash, session);
    return Promise.resolve();
  }

  public findSessionByTokenHash(
    hash: AdminTokenHash,
    now: Date,
  ): Promise<AdminSessionWithUser | null> {
    const session = this.sessions.get(hash);
    const user =
      session === undefined ? undefined : this.users.get(session.userId);
    return Promise.resolve(
      session === undefined || user === undefined || session.expiresAt <= now
        ? null
        : { session, user },
    );
  }

  public deleteSessionByTokenHash(hash: AdminTokenHash): Promise<void> {
    this.sessions.delete(hash);
    return Promise.resolve();
  }

  public deleteSessionsForUser(id: AdminUserId): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.userId === id) this.sessions.delete(hash);
    }
    return Promise.resolve();
  }
}

class MemoryControls implements AdminControlRepository {
  public readonly tenants: Tenant[] = [];
  public readonly keys: ApiKey[] = [];

  public listTenants(): Promise<readonly Tenant[]> {
    return Promise.resolve(this.tenants);
  }

  public createTenant(tenant: Tenant): Promise<void> {
    this.tenants.push(tenant);
    return Promise.resolve();
  }

  public listApiKeys(selected?: TenantId) {
    return Promise.resolve(
      this.keys
        .filter((key) => selected === undefined || key.tenantId === selected)
        .map((key) => ({
          id: key.id,
          publicId: key.publicId,
          tenantId: key.tenantId,
          tenantName:
            this.tenants.find((tenant) => tenant.id === key.tenantId)?.name ??
            'unknown',
          name: key.name,
          environment: key.environment,
          status: key.status,
          policy: key.policy,
          createdAt: key.createdAt,
          expiresAt: key.expiresAt,
          lastUsedAt: null,
        })),
    );
  }

  public dashboardSummary(): Promise<AdminDashboardSummary> {
    return Promise.resolve({
      tenantCount: this.tenants.length,
      activeTenantCount: this.tenants.filter(
        (value) => value.status === 'active',
      ).length,
      apiKeyCount: this.keys.length,
      activeApiKeyCount: this.keys.filter((value) => value.status === 'active')
        .length,
      apiKeysUsedSince: 0,
    });
  }
}

class MemoryApiKeys implements ApiKeyRepository {
  public constructor(private readonly controls: MemoryControls) {}

  public findByPublicId(id: ApiKeyPublicId): Promise<ApiKey | null> {
    return Promise.resolve(
      this.controls.keys.find((key) => key.publicId === id) ?? null,
    );
  }

  public create(key: ApiKey): Promise<void> {
    this.controls.keys.push(key);
    return Promise.resolve();
  }

  public revoke(id: ApiKeyId): Promise<boolean> {
    const index = this.controls.keys.findIndex((key) => key.id === id);
    const key = this.controls.keys[index];
    if (key === undefined || key.status === 'revoked')
      return Promise.resolve(false);
    this.controls.keys[index] = { ...key, status: 'revoked' };
    return Promise.resolve(true);
  }

  public markLastUsed(): Promise<void> {
    return Promise.resolve();
  }
}

class MemoryAudits implements AdminAuditRepository {
  public readonly events: AdminAuditEvent[] = [];
  public append(event: AdminAuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

class TestSecurity {
  public readonly dummyPasswordHash = 'test:dummy-password';
  private tokenSequence = 1;

  public hashPassword(password: string): Promise<string> {
    return Promise.resolve(`test:${password}`);
  }

  public verifyPassword(password: string, encoded: string): Promise<boolean> {
    return Promise.resolve(encoded === `test:${password}`);
  }

  public generateOpaqueToken(): string {
    return String(this.tokenSequence++).padStart(43, 'A');
  }

  public hashOpaqueToken(token: string) {
    return adminTokenHash(
      Buffer.from(token).toString('hex').padEnd(64, '0').slice(0, 64),
    );
  }

  public verifyOpaqueToken(token: string, expected: AdminTokenHash): boolean {
    return this.hashOpaqueToken(token) === expected;
  }
}

function fixture() {
  let time = new Date('2026-08-13T00:00:00.000Z');
  let sequence = 1;
  const identities = new MemoryIdentities();
  const controls = new MemoryControls();
  const apiKeys = new MemoryApiKeys(controls);
  const audits = new MemoryAudits();
  const security = new TestSecurity();
  const idGenerator = () =>
    `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
  const service = new AdminConsoleService(
    identities,
    controls,
    apiKeys,
    audits,
    security,
    {
      provision: (input) => ({
        credential: `rcg_${input.environment === 'production' ? 'prod' : 'test'}_publickey_test-secret-value`,
        apiKey: {
          id: apiKeyId(input.id),
          publicId: apiKeyPublicId('publickey'),
          keyHash: apiKeyHash('a'.repeat(64)),
          tenantId: input.tenantId,
          name: input.name,
          environment: input.environment,
          status: 'active',
          policy: input.policy,
          createdAt: input.now,
          expiresAt: input.expiresAt,
        },
      }),
    },
    { idGenerator, clock: () => time },
  );
  return {
    service,
    identities,
    controls,
    audits,
    advance: (milliseconds: number) => {
      time = new Date(time.getTime() + milliseconds);
    },
  };
}

const email = 'owner@rax-digital.com';
const temporaryPassword = 'temporary password 123';

async function bootstrapAndLogin(value: ReturnType<typeof fixture>) {
  await value.service.bootstrapAdmin({
    email,
    displayName: 'RAX Owner',
    password: temporaryPassword,
  });
  const login = await value.service.login({
    email,
    password: temporaryPassword,
    requestId: 'req_login',
  });
  if (!login.ok) throw new Error('test login failed');
  return login;
}

describe('AdminConsoleService', () => {
  it('bootstraps a normalized administrator and creates an opaque session', async () => {
    const value = fixture();
    await expect(
      value.service.bootstrapAdmin({
        email: ' OWNER@RAX-DIGITAL.COM ',
        displayName: 'RAX Owner',
        password: temporaryPassword,
      }),
    ).resolves.toMatchObject({
      email,
      displayName: 'RAX Owner',
      mustChangePassword: true,
    });
    const stored = [...value.identities.users.values()][0];
    expect(stored?.passwordHash).toBe(`test:${temporaryPassword}`);

    const login = await value.service.login({
      email,
      password: temporaryPassword,
      requestId: 'req_login',
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    await expect(
      value.service.authenticate(login.sessionToken),
    ).resolves.toMatchObject({
      email,
    });
    await expect(
      value.service.authorizeMutation(login.sessionToken, login.csrfToken),
    ).resolves.toMatchObject({ email });
    await expect(
      value.service.authorizeMutation(
        login.sessionToken,
        `${login.csrfToken}x`,
      ),
    ).resolves.toBeNull();
    expect(value.audits.events.map((event) => event.action)).toEqual([
      'admin.user_created',
      'admin.login_succeeded',
    ]);
  });

  it('locks repeated failures, uses one uniform failure, and recovers after expiry', async () => {
    const value = fixture();
    await value.service.bootstrapAdmin({
      email,
      displayName: 'RAX Owner',
      password: temporaryPassword,
    });
    for (let count = 0; count < 5; count += 1) {
      await expect(
        value.service.login({
          email,
          password: 'wrong password value',
          requestId: `req_${String(count)}`,
        }),
      ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
    }
    await expect(
      value.service.login({
        email,
        password: temporaryPassword,
        requestId: 'req_locked',
      }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });

    value.advance(15 * 60 * 1_000 + 1);
    await expect(
      value.service.login({
        email,
        password: temporaryPassword,
        requestId: 'req_recovered',
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      value.service.login({
        email: 'missing@rax-digital.com',
        password: temporaryPassword,
        requestId: 'req_unknown',
      }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('forces password replacement and revokes existing sessions', async () => {
    const value = fixture();
    const login = await bootstrapAndLogin(value);
    const changed = await value.service.changePassword({
      actor: login.principal,
      currentPassword: temporaryPassword,
      newPassword: 'a new secure passphrase 456',
      requestId: 'req_password',
    });
    expect(changed).toBe(true);
    await expect(
      value.service.authenticate(login.sessionToken),
    ).resolves.toBeNull();
    await expect(
      value.service.login({
        email,
        password: 'a new secure passphrase 456',
        requestId: 'req_new_login',
      }),
    ).resolves.toMatchObject({
      ok: true,
      principal: { mustChangePassword: false },
    });
  });

  it('creates tenant-bound one-time API keys and revokes them', async () => {
    const value = fixture();
    const login = await bootstrapAndLogin(value);
    const tenant = await value.service.createTenant({
      actor: login.principal,
      name: 'Customer Alpha',
      requestId: 'req_tenant',
    });
    const created = await value.service.createApiKey({
      actor: login.principal,
      requestId: 'req_key',
      value: {
        tenantId: tenant.id,
        name: 'production app',
        environment: 'production',
        allowedModelPatterns: ['rax/*'],
        allowStreaming: true,
        requestsPerMinute: 60,
        maxConcurrentRequests: 10,
        expiresAt: null,
      },
    });

    expect(created.credential).toMatch(/^rcg_prod_/);
    expect(JSON.stringify(value.controls.keys)).not.toContain(
      created.credential,
    );
    await expect(value.service.listTenants()).resolves.toHaveLength(1);
    await expect(value.service.listApiKeys(tenant.id)).resolves.toHaveLength(1);
    await expect(value.service.dashboardSummary()).resolves.toMatchObject({
      tenantCount: 1,
      activeApiKeyCount: 1,
    });
    await expect(
      value.service.revokeApiKey({
        actor: login.principal,
        id: created.apiKey.id,
        requestId: 'req_revoke',
      }),
    ).resolves.toBe(true);
    await expect(
      value.service.revokeApiKey({
        actor: login.principal,
        id: created.apiKey.id,
        requestId: 'req_revoke_again',
      }),
    ).resolves.toBe(false);
  });
});
