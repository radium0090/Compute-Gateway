import { describe, expect, it } from 'vitest';

import {
  PolicyConfigValidationError,
  loadProviderCredentials,
  parsePolicyConfig,
} from './policy-config.js';

const validPolicy = `
version: 1
providers:
  primary:
    adapter: openai
    credential_env: OPENAI_API_KEY
    base_url: https://api.openai.com/v1
    models:
      model-a:
        capabilities: [chat, streaming]
aliases:
  genchi/fast:
    candidates:
      - provider: primary
        model: model-a
        weight: 100
routing:
  max_attempts: 2
  total_timeout_ms: 60000
`;

describe('parsePolicyConfig', () => {
  it('parses a versioned policy without executing routing behavior', () => {
    const policy = parsePolicyConfig(validPolicy, 'test');

    expect(policy.version).toBe(1);
    expect(policy.aliases['genchi/fast']?.candidates).toHaveLength(1);
  });

  it('rejects unknown keys and dangling provider references', () => {
    expect(() =>
      parsePolicyConfig(`${validPolicy}\nunknown: true\n`, 'test'),
    ).toThrow(PolicyConfigValidationError);

    expect(() =>
      parsePolicyConfig(
        validPolicy.replace('provider: primary', 'provider: missing'),
        'test',
      ),
    ).toThrow(/unknown provider/);
  });

  it('requires HTTPS provider URLs in production', () => {
    const insecure = validPolicy.replace(
      'https://api.openai.com',
      'http://provider.internal',
    );

    expect(() => parsePolicyConfig(insecure, 'production')).toThrow(
      /must use HTTPS/,
    );
  });

  it('does not echo invalid YAML source content', () => {
    const sensitiveText = 'accidental-secret-value';
    try {
      parsePolicyConfig(`version: [${sensitiveText}`, 'test');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PolicyConfigValidationError);
      expect((error as Error).message).not.toContain(sensitiveText);
    }
  });

  it('loads referenced credentials without including their values in errors', () => {
    const policy = parsePolicyConfig(validPolicy, 'test');
    expect(
      loadProviderCredentials(policy, { OPENAI_API_KEY: 'fake-key' }).get(
        'primary',
      ),
    ).toBe('fake-key');

    expect(() => loadProviderCredentials(policy, {})).toThrow(
      /provider primary credential is not set/,
    );
  });
});
