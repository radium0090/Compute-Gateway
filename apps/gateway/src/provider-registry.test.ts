import { describe, expect, it } from 'vitest';

import { parsePolicyConfig } from '@genchi/config';

import { buildProviderRegistry } from './main.js';

describe('buildProviderRegistry', () => {
  it('registers every configured adapter without exposing credentials', () => {
    const policy = parsePolicyConfig(
      `
version: 1
providers:
  oa:
    adapter: openai
    credential_env: OPENAI_API_KEY
    base_url: https://openai.example/v1
    models:
      openai-model: { capabilities: [chat, streaming] }
  an:
    adapter: anthropic
    credential_env: ANTHROPIC_API_KEY
    base_url: https://anthropic.example/v1
    models:
      anthropic-model: { capabilities: [chat, streaming] }
  ge:
    adapter: gemini
    credential_env: GEMINI_API_KEY
    base_url: https://gemini.example/v1beta
    models:
      gemini-model: { capabilities: [chat, streaming] }
aliases:
  genchi/fast:
    candidates:
      - { provider: oa, model: openai-model, weight: 100 }
routing:
  max_attempts: 1
  total_timeout_ms: 60000
`,
      'test',
    );
    const adapters = buildProviderRegistry(
      policy,
      new Map([
        ['oa', 'fake-openai'],
        ['an', 'fake-anthropic'],
        ['ge', 'fake-gemini'],
      ]),
    );

    expect([...adapters.keys()]).toEqual(['oa', 'an', 'ge']);
    expect(adapters.get('oa')?.capabilities('openai-model')?.streaming).toBe(
      true,
    );
    expect(adapters.get('an')?.capabilities('anthropic-model')?.streaming).toBe(
      true,
    );
    expect(adapters.get('ge')?.capabilities('gemini-model')?.streaming).toBe(
      true,
    );
    expect(JSON.stringify(adapters)).not.toContain('fake-');
  });
});
