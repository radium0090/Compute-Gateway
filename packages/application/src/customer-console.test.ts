import { describe, expect, it } from 'vitest';

import {
  apiKeyHash,
  apiKeyId,
  apiKeyPublicId,
  customerTokenHash,
  type ApiKey,
  type ApiKeyId,
  type BusinessInquiry,
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
  type TenantId,
} from '@rax-digital/domain';

import {
  CustomerConsoleService,
  CustomerInputError,
  type CustomerMailerPort,
} from './customer-console.js';

class MemoryIdentity implements CustomerIdentityRepository {
  public readonly users = new Map<string, CustomerUser>();
  public readonly sessions = new Map<string, CustomerSession>();
  public readonly tokens = new Map<string, CustomerOneTimeToken>();
  public readonly entitlements = new Map<string, CustomerTenantEntitlements>();

  public findUserByEmail(email: string): Promise<CustomerUser | null> {
    return Promise.resolve(
      [...this.users.values()].find((user) => user.email === email) ?? null,
    );
  }
  public findUserById(id: CustomerUserId): Promise<CustomerUser | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }
  public createRegistration(
    input: Parameters<CustomerIdentityRepository['createRegistration']>[0],
  ): Promise<void> {
    this.users.set(input.user.id, input.user);
    this.entitlements.set(input.entitlements.tenantId, input.entitlements);
    this.tokens.set(input.verification.tokenHash, input.verification);
    return Promise.resolve();
  }
  public recordLoginSuccess(id: CustomerUserId, at: Date): Promise<void> {
    const user = this.users.get(id);
    if (user !== undefined)
      this.users.set(id, {
        ...user,
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: at,
        updatedAt: at,
      });
    return Promise.resolve();
  }
  public recordLoginFailure(
    id: CustomerUserId,
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
          count >= threshold ? new Date(at.getTime() + durationMs) : null,
        updatedAt: at,
      });
    }
    return Promise.resolve();
  }
  public createSession(session: CustomerSession): Promise<void> {
    this.sessions.set(session.tokenHash, session);
    return Promise.resolve();
  }
  public findSessionByTokenHash(
    hash: CustomerTokenHash,
    now: Date,
  ): Promise<CustomerSessionWithUser | null> {
    const session = this.sessions.get(hash);
    const user =
      session === undefined ? undefined : this.users.get(session.userId);
    return Promise.resolve(
      session === undefined || user === undefined || session.expiresAt <= now
        ? null
        : { session, user },
    );
  }
  public deleteSessionByTokenHash(hash: CustomerTokenHash): Promise<void> {
    this.sessions.delete(hash);
    return Promise.resolve();
  }
  public deleteSessionsForUser(id: CustomerUserId): Promise<void> {
    for (const [hash, session] of this.sessions)
      if (session.userId === id) this.sessions.delete(hash);
    return Promise.resolve();
  }
  public replaceOneTimeToken(token: CustomerOneTimeToken): Promise<void> {
    for (const [hash, existing] of this.tokens)
      if (
        existing.userId === token.userId &&
        existing.purpose === token.purpose
      )
        this.tokens.delete(hash);
    this.tokens.set(token.tokenHash, token);
    return Promise.resolve();
  }
  public verifyEmail(
    hash: CustomerTokenHash,
    now: Date,
  ): Promise<CustomerUser | null> {
    const token = this.tokens.get(hash);
    const user = token === undefined ? undefined : this.users.get(token.userId);
    if (
      token?.purpose !== 'verify_email' ||
      token.expiresAt <= now ||
      user === undefined
    )
      return Promise.resolve(null);
    this.tokens.delete(hash);
    const verified = {
      ...user,
      status: 'active' as const,
      emailVerifiedAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, verified);
    return Promise.resolve(verified);
  }
  public resetPassword(
    hash: CustomerTokenHash,
    passwordHash: string,
    now: Date,
  ): Promise<CustomerUser | null> {
    const token = this.tokens.get(hash);
    const user = token === undefined ? undefined : this.users.get(token.userId);
    if (
      token?.purpose !== 'reset_password' ||
      token.expiresAt <= now ||
      user === undefined
    )
      return Promise.resolve(null);
    this.tokens.delete(hash);
    const updated = { ...user, passwordHash, updatedAt: now };
    this.users.set(user.id, updated);
    return Promise.resolve(updated);
  }
}

class MemoryControls implements CustomerControlRepository {
  public readonly keys: ApiKey[] = [];
  public readonly inquiries: BusinessInquiry[] = [];
  public constructor(private readonly identities: MemoryIdentity) {}
  public findEntitlements(id: TenantId) {
    return Promise.resolve(this.identities.entitlements.get(id) ?? null);
  }
  public listApiKeys(id: TenantId) {
    return Promise.resolve(
      this.keys
        .filter((key) => key.tenantId === id)
        .map((key) => ({ ...key, lastUsedAt: null })),
    );
  }
  public countActiveApiKeys(id: TenantId, now: Date) {
    return Promise.resolve(
      this.keys.filter(
        (key) =>
          key.tenantId === id &&
          key.status === 'active' &&
          (key.expiresAt === null || key.expiresAt > now),
      ).length,
    );
  }
  public async createApiKeyWithinEntitlements(
    key: ApiKey,
    now: Date,
  ): Promise<'created' | 'entitlement_unavailable' | 'limit_reached'> {
    const entitlements = this.identities.entitlements.get(key.tenantId);
    if (
      entitlements?.status !== 'active' ||
      JSON.stringify(entitlements.policy) !== JSON.stringify(key.policy)
    ) {
      return 'entitlement_unavailable';
    }
    if (
      (await this.countActiveApiKeys(key.tenantId, now)) >=
      entitlements.maxActiveApiKeys
    ) {
      return 'limit_reached';
    }
    this.keys.push(key);
    return 'created';
  }
  public revokeApiKey(selected: TenantId, id: ApiKeyId): Promise<boolean> {
    const index = this.keys.findIndex(
      (key) => key.id === id && key.tenantId === selected,
    );
    const key = this.keys[index];
    if (key === undefined || key.status === 'revoked')
      return Promise.resolve(false);
    this.keys[index] = { ...key, status: 'revoked' };
    return Promise.resolve(true);
  }
  public createBusinessInquiry(inquiry: BusinessInquiry): Promise<void> {
    this.inquiries.push(inquiry);
    return Promise.resolve();
  }
}

class MemoryAudits implements CustomerAuditRepository {
  public readonly events: CustomerAuditEvent[] = [];
  public append(event: CustomerAuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

class TestSecurity {
  public readonly dummyPasswordHash = 'test:dummy';
  private sequence = 1;
  public hashPassword(value: string): Promise<string> {
    return Promise.resolve(`test:${value}`);
  }
  public verifyPassword(value: string, encoded: string): Promise<boolean> {
    return Promise.resolve(encoded === `test:${value}`);
  }
  public generateOpaqueToken(): string {
    return String(this.sequence++).padStart(43, 'T');
  }
  public hashOpaqueToken(token: string) {
    return customerTokenHash(
      Buffer.from(token).toString('hex').padEnd(64, '0').slice(0, 64),
    );
  }
  public verifyOpaqueToken(
    token: string,
    expected: CustomerTokenHash,
  ): boolean {
    return this.hashOpaqueToken(token) === expected;
  }
}

class MemoryMailer implements CustomerMailerPort {
  public verificationToken = '';
  public resetToken = '';
  public sendEmailVerification(input: {
    verificationToken: string;
  }): Promise<void> {
    this.verificationToken = input.verificationToken;
    return Promise.resolve();
  }
  public sendPasswordReset(input: { resetToken: string }): Promise<void> {
    this.resetToken = input.resetToken;
    return Promise.resolve();
  }
}

function fixture() {
  let sequence = 1;
  const now = new Date('2026-11-19T00:00:00.000Z');
  const identities = new MemoryIdentity();
  const controls = new MemoryControls(identities);
  const mailer = new MemoryMailer();
  const service = new CustomerConsoleService(
    identities,
    controls,
    new MemoryAudits(),
    new TestSecurity(),
    mailer,
    {
      provision: (input) => ({
        credential: 'rcg_prod_public-key_secret',
        apiKey: {
          id: apiKeyId(input.id),
          publicId: apiKeyPublicId(
            `public-${String(sequence).padStart(4, '0')}`,
          ),
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
    {
      environment: 'production',
      clock: () => now,
      idGenerator: () =>
        `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
    },
  );
  return { service, identities, controls, mailer, now };
}

async function registerAndVerify(value: ReturnType<typeof fixture>) {
  await value.service.register({
    email: ' Owner@Example.com ',
    displayName: 'Owner',
    organizationName: 'Example',
    password: 'correct horse battery',
    requestId: 'req-register',
  });
  await value.service.verifyEmail(value.mailer.verificationToken, 'req-verify');
}

describe('CustomerConsoleService', () => {
  it('registers a pending tenant, verifies email, and creates a session', async () => {
    const value = fixture();
    await value.service.register({
      email: ' Owner@Example.com ',
      displayName: 'Owner',
      organizationName: 'Example',
      password: 'correct horse battery',
      requestId: 'req-register',
    });
    const stored = [...value.identities.users.values()][0];
    expect(stored).toMatchObject({
      email: 'owner@example.com',
      status: 'pending_verification',
    });
    await expect(
      value.service.login({
        email: 'owner@example.com',
        password: 'correct horse battery',
        requestId: 'before',
      }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
    await expect(
      value.service.verifyEmail(value.mailer.verificationToken, 'req-verify'),
    ).resolves.toBe(true);
    const login = await value.service.login({
      email: 'owner@example.com',
      password: 'correct horse battery',
      requestId: 'after',
    });
    expect(login.ok).toBe(true);
    if (login.ok)
      await expect(
        value.service.authorizeMutation(login.sessionToken, login.csrfToken),
      ).resolves.toMatchObject({ email: 'owner@example.com' });
  });

  it('fails closed until entitlements are approved and enforces the active-key limit', async () => {
    const value = fixture();
    await registerAndVerify(value);
    const login = await value.service.login({
      email: 'owner@example.com',
      password: 'correct horse battery',
      requestId: 'login',
    });
    if (!login.ok) throw new Error('login failed');
    await expect(
      value.service.createApiKey({
        actor: login.principal,
        name: 'app',
        requestId: 'pending',
      }),
    ).rejects.toMatchObject({ code: 'entitlement_unavailable' });
    const pending = value.identities.entitlements.get(login.principal.tenantId);
    if (pending === undefined) throw new Error('missing entitlement');
    value.identities.entitlements.set(login.principal.tenantId, {
      ...pending,
      status: 'active',
      policy: { ...pending.policy, allowedModelPatterns: ['rax/*'] },
    });
    await expect(
      value.service.createApiKey({
        actor: login.principal,
        name: 'app',
        requestId: 'create',
      }),
    ).resolves.toMatchObject({ credential: 'rcg_prod_public-key_secret' });
    await expect(
      value.service.createApiKey({
        actor: login.principal,
        name: 'second',
        requestId: 'limit',
      }),
    ).rejects.toBeInstanceOf(CustomerInputError);
  });

  it('uses a one-time password reset token and invalidates existing sessions', async () => {
    const value = fixture();
    await registerAndVerify(value);
    const login = await value.service.login({
      email: 'owner@example.com',
      password: 'correct horse battery',
      requestId: 'login',
    });
    if (!login.ok) throw new Error('login failed');
    await value.service.requestPasswordReset('owner@example.com');
    await expect(
      value.service.resetPassword({
        token: value.mailer.resetToken,
        password: 'a new secure password',
        requestId: 'reset',
      }),
    ).resolves.toBe(true);
    await expect(
      value.service.authenticate(login.sessionToken),
    ).resolves.toBeNull();
    await expect(
      value.service.resetPassword({
        token: value.mailer.resetToken,
        password: 'another secure password',
        requestId: 'replay',
      }),
    ).resolves.toBe(false);
  });

  it('normalizes and stores a consented business inquiry', async () => {
    const value = fixture();
    await value.service.createBusinessInquiry({
      name: ' RAX User ',
      email: 'USER@EXAMPLE.COM',
      company: ' Example ',
      message: 'We need a Gemini fallback proof of concept.',
      requestId: 'req-inquiry',
    });
    expect(value.controls.inquiries[0]).toMatchObject({
      name: 'RAX User',
      email: 'user@example.com',
      company: 'Example',
    });
  });
});
