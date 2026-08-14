import { describe, expect, it, vi } from 'vitest';

import { apiKeyHash, apiKeyPublicId } from '@rax-digital/domain';

import {
  DemoClaimService,
  type DemoIdentityProviderPort,
  type DemoClaimRepository,
  type DemoClaimServiceOptions,
  type DemoSecurityPort,
} from './demo-claim.js';
import type { ApiKeyProvisionerPort } from './admin-console.js';

const now = new Date('2026-08-14T05:00:00.000Z');
const options: DemoClaimServiceOptions = {
  tenantId: '123e4567-e89b-42d3-a456-426614174000',
  environment: 'production',
  model: 'rax/fast',
  keyTtlMs: 300_000,
  stateTtlMs: 600_000,
  accountMinimumAgeDays: 7,
  accountCooldownMs: 86_400_000,
  maximumDailyClaims: 50,
  requestsPerMinute: 2,
  maxRequestTokens: 2_048,
  maxOutputTokens: 128,
  clock: () => now,
  idGenerator: () => '223e4567-e89b-42d3-a456-426614174000',
};

function fixture(result: 'created' | 'daily_limit' = 'created') {
  let stateHash = '';
  const createState = vi.fn<DemoClaimRepository['createState']>((state) => {
    stateHash = state.stateHash;
    return Promise.resolve();
  });
  const consumeState = vi.fn<DemoClaimRepository['consumeState']>((hash) =>
    Promise.resolve(hash === stateHash),
  );
  const createClaim = vi.fn<DemoClaimRepository['createClaim']>(() =>
    Promise.resolve(
      result === 'created'
        ? { created: true as const }
        : { created: false as const, reason: 'daily_limit' as const },
    ),
  );
  const repository: DemoClaimRepository = {
    createState,
    consumeState,
    createClaim,
  };
  const security: DemoSecurityPort = {
    generateOpaqueToken: vi
      .fn()
      .mockReturnValueOnce('state-token')
      .mockReturnValueOnce('pkce-verifier'),
    hashState: (value: string) => `state:${value}`,
    hashIdentity: (value: string) => `identity:${value}`,
    verifyState: (value: string, expected: string) =>
      `state:${value}` === expected,
    pkceChallenge: (value: string) => `challenge:${value}`,
  };
  const exchangeCode = vi.fn<DemoIdentityProviderPort['exchangeCode']>(() =>
    Promise.resolve({
      subject: 'github:123',
      accountCreatedAt: new Date('2020-01-01T00:00:00.000Z'),
    }),
  );
  const identityProvider: DemoIdentityProviderPort = {
    authorizationUrl: vi.fn(
      (state: string, challenge: string) =>
        `https://github.example/authorize?state=${state}&challenge=${challenge}`,
    ),
    exchangeCode,
  };
  const provision = vi.fn<ApiKeyProvisionerPort['provision']>((input) => ({
    credential: 'rcg_prod_public_secret',
    apiKey: {
      ...input,
      id: input.id as never,
      publicId: apiKeyPublicId('public-id-1234'),
      keyHash: apiKeyHash('a'.repeat(64)),
      status: 'active' as const,
      createdAt: input.now,
    },
  }));
  const apiKeyProvisioner: ApiKeyProvisionerPort = {
    provision,
  };
  return {
    repository,
    createClaim,
    security,
    identityProvider,
    exchangeCode,
    apiKeyProvisioner,
    provision,
    service: new DemoClaimService(
      repository,
      security,
      identityProvider,
      apiKeyProvisioner,
      options,
    ),
  };
}

describe('DemoClaimService', () => {
  it('stores one-time OAuth state and issues a bounded five-minute key', async () => {
    const value = fixture();
    const start = await value.service.begin();

    expect(start).toMatchObject({
      state: 'state-token',
      codeVerifier: 'pkce-verifier',
      expiresAt: new Date('2026-08-14T05:10:00.000Z'),
    });
    expect(start.authorizationUrl).toContain('challenge:pkce-verifier');

    const completed = await value.service.complete({
      code: 'temporary-code',
      returnedState: 'state-token',
      cookieState: 'state-token',
      codeVerifier: 'pkce-verifier',
    });
    expect(completed).toEqual({
      credential: 'rcg_prod_public_secret',
      expiresAt: new Date('2026-08-14T05:05:00.000Z'),
      model: 'rax/fast',
      maxOutputTokens: 128,
    });
    expect(value.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: new Date('2026-08-14T05:05:00.000Z'),
        policy: {
          allowedModelPatterns: ['rax/fast'],
          allowStreaming: false,
          allowTools: false,
          requestsPerMinute: 2,
          maxConcurrentRequests: 1,
          maxRequestTokens: 2_048,
          maxOutputTokens: 128,
        },
      }),
    );
  });

  it('rejects replayed or mismatched OAuth state before identity exchange', async () => {
    const value = fixture();
    await value.service.begin();

    await expect(
      value.service.complete({
        code: 'temporary-code',
        returnedState: 'attacker-state',
        cookieState: 'state-token',
        codeVerifier: 'pkce-verifier',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_oauth_state',
    });
    expect(value.exchangeCode).not.toHaveBeenCalled();
  });

  it('fails closed when the global daily claim budget is exhausted', async () => {
    const value = fixture('daily_limit');
    await value.service.begin();

    await expect(
      value.service.complete({
        code: 'temporary-code',
        returnedState: 'state-token',
        cookieState: 'state-token',
        codeVerifier: 'pkce-verifier',
      }),
    ).rejects.toMatchObject({
      code: 'claim_limit_reached',
    });
  });

  it('rejects GitHub accounts newer than the configured minimum age', async () => {
    const value = fixture();
    value.exchangeCode.mockResolvedValue({
      subject: 'github:456',
      accountCreatedAt: new Date('2026-08-13T00:00:00.000Z'),
    });
    await value.service.begin();

    await expect(
      value.service.complete({
        code: 'temporary-code',
        returnedState: 'state-token',
        cookieState: 'state-token',
        codeVerifier: 'pkce-verifier',
      }),
    ).rejects.toMatchObject({
      code: 'account_not_eligible',
    });
    expect(value.createClaim).not.toHaveBeenCalled();
  });
});
