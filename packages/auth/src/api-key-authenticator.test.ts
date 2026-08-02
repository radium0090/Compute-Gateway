import { describe, expect, it } from 'vitest';

import {
  apiKeyId,
  tenantId,
  type ApiKey,
  type ApiKeyPolicy,
  type ApiKeyRepository,
} from '@genchi/domain';

import {
  ApiKeyAuthenticator,
  parseApiKeyCredential,
  provisionApiKey,
} from './api-key-authenticator.js';

const policy: ApiKeyPolicy = {
  allowedModelPatterns: ['genchi/*'],
  allowStreaming: false,
  allowTools: false,
  requestsPerMinute: 60,
  maxConcurrentRequests: 4,
};

const pepper = 'test-only-pepper-with-at-least-32-characters';
const now = new Date('2026-08-03T00:00:00.000Z');

class InMemoryApiKeyRepository implements ApiKeyRepository {
  public constructor(private readonly record: ApiKey | null) {}

  public findByPublicId(): Promise<ApiKey | null> {
    return Promise.resolve(this.record);
  }

  public create(): Promise<void> {
    return Promise.resolve();
  }

  public markLastUsed(): Promise<void> {
    return Promise.resolve();
  }
}

function deterministicBytes(size: number): Uint8Array {
  return new Uint8Array(size).fill(7);
}

function provision(expiresAt?: Date): ReturnType<typeof provisionApiKey> {
  return provisionApiKey(
    {
      id: apiKeyId('01989c9b-a400-7000-8000-000000000001'),
      tenantId: tenantId('01989c9b-a400-7000-8000-000000000002'),
      name: 'test key',
      environment: 'test',
      policy,
      pepper,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
    now,
    deterministicBytes,
  );
}

describe('API key provisioning', () => {
  it('creates the documented key shape with a 256-bit secret', () => {
    const result = provision();
    const parsed = parseApiKeyCredential(result.credential);
    const secret = result.credential.slice(
      result.credential.lastIndexOf('_') + 1,
    );

    expect(parsed).toEqual({
      environment: 'test',
      publicId: result.apiKey.publicId,
    });
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(result.apiKey.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.apiKey.keyHash).not.toContain(result.credential);
  });

  it('accepts URL-safe secrets containing underscore separators', () => {
    const result = provisionApiKey(
      {
        id: apiKeyId('01989c9b-a400-7000-8000-000000000001'),
        tenantId: tenantId('01989c9b-a400-7000-8000-000000000002'),
        name: 'underscore key',
        environment: 'test',
        policy,
        pepper,
      },
      now,
      (size) => new Uint8Array(size).fill(255),
    );

    expect(result.credential).toContain('_');
    expect(parseApiKeyCredential(result.credential)).not.toBeNull();
  });
});

describe('ApiKeyAuthenticator', () => {
  it('authenticates a valid active key', async () => {
    const provisioned = provision();
    const authenticator = new ApiKeyAuthenticator(
      new InMemoryApiKeyRepository(provisioned.apiKey),
      pepper,
      'test',
      () => now,
    );

    await expect(
      authenticator.authenticate(provisioned.credential),
    ).resolves.toEqual({
      authenticated: true,
      apiKey: provisioned.apiKey,
    });
  });

  it.each([
    ['wrong secret', (credential: string) => `${credential.slice(0, -1)}A`],
    ['malformed key', () => 'not-a-genchi-key'],
  ])('returns the same invalid result for %s', async (_name, mutate) => {
    const provisioned = provision();
    const authenticator = new ApiKeyAuthenticator(
      new InMemoryApiKeyRepository(provisioned.apiKey),
      pepper,
      'test',
      () => now,
    );

    await expect(
      authenticator.authenticate(mutate(provisioned.credential)),
    ).resolves.toEqual({ authenticated: false });
  });

  it('rejects expired, revoked, and wrong-environment keys', async () => {
    const provisioned = provision(new Date('2026-08-03T00:00:01.000Z'));
    const later = new Date('2026-08-03T00:00:02.000Z');
    const revoked: ApiKey = { ...provisioned.apiKey, status: 'revoked' };

    const expiredAuthenticator = new ApiKeyAuthenticator(
      new InMemoryApiKeyRepository(provisioned.apiKey),
      pepper,
      'test',
      () => later,
    );
    const revokedAuthenticator = new ApiKeyAuthenticator(
      new InMemoryApiKeyRepository(revoked),
      pepper,
      'test',
      () => now,
    );
    const environmentAuthenticator = new ApiKeyAuthenticator(
      new InMemoryApiKeyRepository(provisioned.apiKey),
      pepper,
      'production',
      () => now,
    );

    await expect(
      expiredAuthenticator.authenticate(provisioned.credential),
    ).resolves.toEqual({ authenticated: false });
    await expect(
      revokedAuthenticator.authenticate(provisioned.credential),
    ).resolves.toEqual({ authenticated: false });
    await expect(
      environmentAuthenticator.authenticate(provisioned.credential),
    ).resolves.toEqual({ authenticated: false });
  });
});
