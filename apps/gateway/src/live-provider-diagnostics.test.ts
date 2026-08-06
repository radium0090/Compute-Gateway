import { describe, expect, it } from 'vitest';

import { diagnoseGeminiRequest } from './live-provider-diagnostics.js';

describe('Gemini live provider diagnostics', () => {
  it('returns only staged HTTP statuses and stops after the rejected field', async () => {
    const secret = 'fake-gemini-secret';
    const capturedBodies: unknown[] = [];
    const result = await diagnoseGeminiRequest({
      apiKey: secret,
      configuredModel: 'gemini-2.5-flash',
      fetchImplementation: (_input, init) => {
        if (typeof init?.body === 'string') {
          capturedBodies.push(JSON.parse(init.body) as unknown);
        }
        const rejected =
          typeof init?.body === 'string' &&
          init.body.includes('thinkingConfig');
        return Promise.resolve(
          new Response('{}', { status: rejected ? 400 : 200 }),
        );
      },
    });

    expect(result).toEqual([
      { name: 'configured-model', status: 200 },
      { name: 'minimal', status: 200 },
      { name: 'role', status: 200 },
      { name: 'candidate-count', status: 200 },
      { name: 'max-output-tokens', status: 200 },
      { name: 'thinking-budget', status: 400 },
      { name: 'latest-alias-minimal', status: 200 },
    ]);
    expect(capturedBodies).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(promptTextForAssertion);
  });

  it('normalizes transport failures without exposing error details', async () => {
    const result = await diagnoseGeminiRequest({
      apiKey: 'fake-gemini-secret',
      configuredModel: 'gemini-flash-latest',
      fetchImplementation: () =>
        Promise.reject(new Error('raw network detail')),
    });

    expect(result).toEqual([
      { name: 'configured-model', status: 'network_error' },
      { name: 'minimal', status: 'network_error' },
    ]);
    expect(JSON.stringify(result)).not.toContain('raw network detail');
  });
});

const promptTextForAssertion = 'Reply with OK.';
