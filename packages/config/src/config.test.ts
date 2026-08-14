import { describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  describeSecretPresence,
  loadConfig,
} from './config.js';

const validEnvironment = {
  RCG_ENVIRONMENT: 'test',
  RCG_DATABASE_URL: 'postgresql://rcg:fake@localhost:5432/compute_gateway',
  RCG_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
} as const;

describe('loadConfig', () => {
  it('loads validated defaults and typed overrides', () => {
    const config = loadConfig({
      ...validEnvironment,
      RCG_PORT: '9090',
      RCG_METRICS_ENABLED: 'false',
      RCG_SERVICE_VERSION: 'v0.1.0',
      RCG_COMMIT_SHA: 'abcdef1234567',
    });

    expect(config.port).toBe(9090);
    expect(config.metricsEnabled).toBe(false);
    expect(config.totalTimeoutMs).toBe(60_000);
    expect(config.connectTimeoutMs).toBe(30_000);
    expect(config.configFile).toBe('/etc/rax-compute-gateway/config.yaml');
    expect(config.serviceVersion).toBe('v0.1.0');
    expect(config.commitSha).toBe('abcdef1234567');
    expect(config.adminEnabled).toBe(false);
    expect(config.demoEnabled).toBe(false);
    expect(config.demoKeyTtlMs).toBe(300_000);
  });

  it('rejects missing required settings without echoing secret values', () => {
    const leakedCandidate = 'must-never-appear-in-an-error';

    expect(() =>
      loadConfig({
        RCG_ENVIRONMENT: 'test',
        RCG_DATABASE_URL: leakedCandidate,
        RCG_KEY_HASH_PEPPER: 'short',
      }),
    ).toThrow(ConfigValidationError);

    try {
      loadConfig({
        RCG_ENVIRONMENT: 'test',
        RCG_DATABASE_URL: leakedCandidate,
        RCG_KEY_HASH_PEPPER: 'short',
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as Error).message).not.toContain(leakedCandidate);
      expect((error as Error).message).not.toContain('short');
    }
  });

  it('enforces timeout ordering and production proxy safety', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        RCG_ENVIRONMENT: 'production',
        RCG_TOTAL_TIMEOUT_MS: '5000',
        RCG_CONNECT_TIMEOUT_MS: '5000',
        RCG_TRUST_PROXY: 'true',
      }),
    ).toThrow(/must be less|explicit proxy CIDRs/);
  });

  it('requires Redis for production distributed controls', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, RCG_ENVIRONMENT: 'production' }),
    ).toThrow(/RCG_REDIS_URL is required/);

    expect(
      loadConfig({
        ...validEnvironment,
        RCG_ENVIRONMENT: 'production',
        RCG_REDIS_URL: 'rediss://redis.example:6379',
      }).redisUrl,
    ).toBe('rediss://redis.example:6379');
  });

  it('reports only whether secrets are set', () => {
    const config = loadConfig({
      ...validEnvironment,
      RCG_MASTER_KEY: 'fake-master-key-with-at-least-32-characters',
    });

    expect(describeSecretPresence(config)).toEqual({
      RCG_KEY_HASH_PEPPER: '<set>',
      RCG_MASTER_KEY: '<set>',
      RCG_ADMIN_SESSION_PEPPER: '<unset>',
      RCG_DEMO_GITHUB_CLIENT_SECRET: '<unset>',
      RCG_DEMO_HASH_PEPPER: '<unset>',
    });
  });

  it('requires an origin and dedicated pepper when admin is enabled', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, RCG_ADMIN_ENABLED: 'true' }),
    ).toThrow(/RCG_ADMIN_ORIGIN|RCG_ADMIN_SESSION_PEPPER/);

    expect(
      loadConfig({
        ...validEnvironment,
        RCG_ADMIN_ENABLED: 'true',
        RCG_ADMIN_ORIGIN: 'http://localhost:8080',
        RCG_ADMIN_SESSION_PEPPER:
          'fake-admin-session-pepper-with-at-least-32-characters',
      }).adminEnabled,
    ).toBe(true);
  });

  it('requires HTTPS for a production admin origin', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        RCG_ENVIRONMENT: 'production',
        RCG_REDIS_URL: 'redis://redis:6379',
        RCG_ADMIN_ENABLED: 'true',
        RCG_ADMIN_ORIGIN: 'http://admin.example.com',
        RCG_ADMIN_SESSION_PEPPER:
          'fake-admin-session-pepper-with-at-least-32-characters',
      }),
    ).toThrow(/must use HTTPS/);
  });

  it('requires complete isolated configuration when the hosted demo is enabled', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, RCG_DEMO_ENABLED: 'true' }),
    ).toThrow(/RCG_DEMO_ORIGIN|RCG_DEMO_GITHUB_CLIENT_ID/);

    const config = loadConfig({
      ...validEnvironment,
      RCG_DEMO_ENABLED: 'true',
      RCG_DEMO_ORIGIN: 'http://localhost:8080',
      RCG_DEMO_GITHUB_CLIENT_ID: 'github-client',
      RCG_DEMO_GITHUB_CLIENT_SECRET: 'github-secret',
      RCG_DEMO_HASH_PEPPER: 'demo-hash-pepper-with-at-least-32-characters',
      RCG_DEMO_TENANT_ID: '123e4567-e89b-42d3-a456-426614174000',
    });

    expect(config).toMatchObject({
      demoEnabled: true,
      demoModel: 'rax/fast',
      demoMaximumDailyClaims: 50,
      demoRequestsPerMinute: 2,
      demoMaxRequestTokens: 2_048,
      demoMaxOutputTokens: 128,
    });
    expect(describeSecretPresence(config)).toMatchObject({
      RCG_DEMO_GITHUB_CLIENT_SECRET: '<set>',
      RCG_DEMO_HASH_PEPPER: '<set>',
    });
  });

  it('requires HTTPS for the production hosted-demo origin', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        RCG_ENVIRONMENT: 'production',
        RCG_REDIS_URL: 'redis://redis:6379',
        RCG_DEMO_ENABLED: 'true',
        RCG_DEMO_ORIGIN: 'http://api.example.com',
        RCG_DEMO_GITHUB_CLIENT_ID: 'github-client',
        RCG_DEMO_GITHUB_CLIENT_SECRET: 'github-secret',
        RCG_DEMO_HASH_PEPPER: 'demo-hash-pepper-with-at-least-32-characters',
        RCG_DEMO_TENANT_ID: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).toThrow(/RCG_DEMO_ORIGIN must use HTTPS/);
  });
});
