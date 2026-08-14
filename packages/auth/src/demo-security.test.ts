import { describe, expect, it, vi } from 'vitest';

import { GitHubOAuthClient, NodeDemoSecurity } from './demo-security.js';

describe('NodeDemoSecurity', () => {
  it('domain-separates state and identity hashes and builds PKCE challenges', () => {
    const security = new NodeDemoSecurity(
      'demo-pepper-with-at-least-32-characters',
      () => new Uint8Array(32).fill(7),
    );
    const token = security.generateOpaqueToken();
    const stateHash = security.hashState(token);

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(security.hashIdentity(token)).not.toBe(stateHash);
    expect(security.verifyState(token, stateHash)).toBe(true);
    expect(security.verifyState(`${token}x`, stateHash)).toBe(false);
    expect(security.pkceChallenge(token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('GitHubOAuthClient', () => {
  it('uses PKCE and returns only the stable GitHub identity fields', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'github-secret-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 123, created_at: '2020-01-02T03:04:05Z' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    const client = new GitHubOAuthClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://api.example.com/demo/callback',
      fetchImpl,
    });

    const authorization = new URL(
      client.authorizationUrl('state-value', 'challenge-value'),
    );
    expect(authorization.searchParams.get('scope')).toBeNull();
    expect(authorization.searchParams.get('state')).toBe('state-value');
    expect(authorization.searchParams.get('code_challenge')).toBe(
      'challenge-value',
    );
    expect(authorization.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );

    await expect(
      client.exchangeCode('temporary-code', 'verifier'),
    ).resolves.toEqual({
      subject: 'github:123',
      accountCreatedAt: new Date('2020-01-02T03:04:05Z'),
    });
    const tokenRequest = fetchImpl.mock.calls[0]?.[1];
    expect(tokenRequest?.body).toBeInstanceOf(URLSearchParams);
    expect((tokenRequest?.body as URLSearchParams).toString()).toContain(
      'code_verifier=verifier',
    );
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer github-secret-token',
    });
  });

  it('returns one safe failure without exposing provider response fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'bad_verification_code',
          access_token: 'must-not-leak',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new GitHubOAuthClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://api.example.com/demo/callback',
      fetchImpl,
    });

    await expect(client.exchangeCode('bad-code', 'verifier')).rejects.toThrow(
      'GitHub OAuth token exchange failed',
    );
  });
});
