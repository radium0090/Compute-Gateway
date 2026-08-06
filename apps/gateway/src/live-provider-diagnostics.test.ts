import { describe, expect, it } from 'vitest';

import {
  diagnoseGeminiRequest,
  safeGatewayFailureSummary,
} from './live-provider-diagnostics.js';

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
        const exactRequest =
          typeof init?.body === 'string' &&
          init.body.includes('maxOutputTokens') &&
          !rejected;
        return Promise.resolve(
          new Response(
            exactRequest
              ? JSON.stringify({
                  candidates: [
                    {
                      content: {
                        role: 'model',
                        parts: [{ text: 'raw model output' }],
                      },
                    },
                  ],
                  usageMetadata: { promptTokenCount: 3, totalTokenCount: 4 },
                })
              : '{}',
            { status: rejected ? 400 : 200 },
          ),
        );
      },
    });

    expect(result).toEqual([
      { name: 'configured-model', status: 200 },
      { name: 'minimal', status: 200 },
      { name: 'role', status: 200 },
      { name: 'candidate-count', status: 200 },
      {
        name: 'max-output-tokens',
        status: 200,
        shape:
          'candidates=1;content=true;role=model;parts=1;textParts=1;usage=true',
      },
      { name: 'thinking-budget', status: 400 },
      { name: 'latest-alias-minimal', status: 200 },
    ]);
    expect(capturedBodies).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(promptTextForAssertion);
    expect(JSON.stringify(result)).not.toContain('raw model output');
  });

  it('returns only allowlisted gateway failure metadata', () => {
    expect(
      safeGatewayFailureSummary({
        status: 502,
        code: 'provider_invalid_response',
        message: 'raw provider output',
        headers: { authorization: 'raw-secret' },
      }),
    ).toBe('status=502;code=provider_invalid_response');
    expect(
      safeGatewayFailureSummary({ status: 'bad', code: 'NOT SAFE!' }),
    ).toBe('status=unknown;code=unknown');
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
