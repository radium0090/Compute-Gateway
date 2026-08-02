import { describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  describeSecretPresence,
  loadConfig,
} from './config.js';

const validEnvironment = {
  GENCHI_ENVIRONMENT: 'test',
  GENCHI_DATABASE_URL: 'postgresql://genchi:fake@localhost:5432/genchi',
  GENCHI_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
} as const;

describe('loadConfig', () => {
  it('loads validated defaults and typed overrides', () => {
    const config = loadConfig({
      ...validEnvironment,
      GENCHI_PORT: '9090',
      GENCHI_METRICS_ENABLED: 'false',
    });

    expect(config.port).toBe(9090);
    expect(config.metricsEnabled).toBe(false);
    expect(config.totalTimeoutMs).toBe(60_000);
    expect(config.configFile).toBe('/etc/genchi/config.yaml');
  });

  it('rejects missing required settings without echoing secret values', () => {
    const leakedCandidate = 'must-never-appear-in-an-error';

    expect(() =>
      loadConfig({
        GENCHI_ENVIRONMENT: 'test',
        GENCHI_DATABASE_URL: leakedCandidate,
        GENCHI_KEY_HASH_PEPPER: 'short',
      }),
    ).toThrow(ConfigValidationError);

    try {
      loadConfig({
        GENCHI_ENVIRONMENT: 'test',
        GENCHI_DATABASE_URL: leakedCandidate,
        GENCHI_KEY_HASH_PEPPER: 'short',
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
        GENCHI_ENVIRONMENT: 'production',
        GENCHI_TOTAL_TIMEOUT_MS: '5000',
        GENCHI_CONNECT_TIMEOUT_MS: '5000',
        GENCHI_TRUST_PROXY: 'true',
      }),
    ).toThrow(/must be less|explicit proxy CIDRs/);
  });

  it('reports only whether secrets are set', () => {
    const config = loadConfig({
      ...validEnvironment,
      GENCHI_MASTER_KEY: 'fake-master-key-with-at-least-32-characters',
    });

    expect(describeSecretPresence(config)).toEqual({
      GENCHI_KEY_HASH_PEPPER: '<set>',
      GENCHI_MASTER_KEY: '<set>',
    });
  });
});
