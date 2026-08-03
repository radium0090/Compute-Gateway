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
});
