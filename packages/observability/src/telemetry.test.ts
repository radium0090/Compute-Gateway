import { trace, TraceFlags, type Span } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCorrelationContext } from './telemetry.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getCorrelationContext', () => {
  it('omits invalid all-zero span identifiers', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: TraceFlags.NONE,
      }),
    } as unknown as Span);

    expect(getCorrelationContext()).toEqual({});
  });

  it('returns valid active correlation identifiers', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue({
      spanContext: () => ({
        traceId: '1'.repeat(32),
        spanId: '2'.repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      }),
    } as unknown as Span);

    expect(getCorrelationContext()).toEqual({
      traceId: '1'.repeat(32),
      spanId: '2'.repeat(16),
    });
  });
});
