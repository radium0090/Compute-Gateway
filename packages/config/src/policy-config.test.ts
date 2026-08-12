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
  rax/fast:
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
    expect(policy.aliases['rax/fast']?.candidates).toHaveLength(1);
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

  it('validates bounded retry, concurrency, and circuit policy', () => {
    const configured = validPolicy.replace(
      '  total_timeout_ms: 60000',
      `  total_timeout_ms: 60000
  connect_timeout_ms: 5000
  same_route_retries: 1
  minimum_attempt_budget_ms: 2000
  retry_base_delay_ms: 100
  global_max_concurrent_calls: 100
  provider_max_concurrent_calls: 10
  circuit:
    failure_threshold: 5
    rolling_window_ms: 30000
    open_duration_ms: 30000
    half_open_max_calls: 1`,
    );
    expect(parsePolicyConfig(configured, 'test').routing.circuit).toMatchObject(
      {
        failure_threshold: 5,
      },
    );

    expect(() =>
      parsePolicyConfig(
        configured.replace(
          'minimum_attempt_budget_ms: 2000',
          'minimum_attempt_budget_ms: 70000',
        ),
        'test',
      ),
    ).toThrow(/minimum attempt budget/);
  });
});
