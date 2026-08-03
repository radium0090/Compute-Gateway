import { trace, TraceFlags, type Meter, type Span } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCorrelationContext, registerBuildInfo } from './telemetry.js';

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

describe('registerBuildInfo', () => {
  it('reports the configured version and commit without exposing secrets', () => {
    const addCallback = vi.fn();
    const createObservableGauge = vi.fn(() => ({ addCallback }));
    const observe = vi.fn();

    registerBuildInfo({ createObservableGauge } as unknown as Meter, {
      serviceVersion: 'v1.2.3',
      commitSha: 'abcdef1',
    });

    expect(createObservableGauge).toHaveBeenCalledWith('genchi_build_info', {
      description: 'Build identity for the running gateway',
    });
    const callback = addCallback.mock.calls[0]?.[0] as
      ((result: { observe: typeof observe }) => void) | undefined;
    expect(callback).toBeDefined();
    callback?.({ observe });
    expect(observe).toHaveBeenCalledWith(1, {
      version: 'v1.2.3',
      commit: 'abcdef1',
    });
  });
});
