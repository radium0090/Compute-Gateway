import { describe, expect, it } from 'vitest';

import { resultErrorMapping } from './chat-errors.js';

describe('routing admission error mapping', () => {
  it('maps per-key rate limits to a retryable 429', () => {
    expect(
      resultErrorMapping({
        ok: false,
        failure: {
          kind: 'admission',
          reason: 'rate_limited',
          retryAfterSeconds: 12,
        },
      }),
    ).toMatchObject({
      statusCode: 429,
      code: 'rate_limit_exceeded',
      retryAfterSeconds: 12,
      retryable: true,
    });
  });

  it('fails closed with a safe 503 when coordination is unavailable', () => {
    expect(
      resultErrorMapping({
        ok: false,
        failure: {
          kind: 'admission',
          reason: 'coordination_unavailable',
        },
      }),
    ).toMatchObject({
      statusCode: 503,
      code: 'coordination_unavailable',
      retryable: true,
    });
  });

  it('maps an API key input ceiling to a safe client error', () => {
    expect(
      resultErrorMapping({
        ok: false,
        failure: { kind: 'policy', reason: 'request_too_large' },
      }),
    ).toEqual({
      statusCode: 400,
      type: 'invalid_request_error',
      code: 'request_too_large',
      message: 'The request exceeds this API key policy limit.',
      param: 'messages',
      retryable: false,
    });
  });
});
