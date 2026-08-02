import { describe, expect, it, vi } from 'vitest';

import { stopTelemetrySafely } from './telemetry-shutdown.js';

describe('stopTelemetrySafely', () => {
  it('stops telemetry without warning when the exporter flushes', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();

    await stopTelemetrySafely({ stop }, { warn });

    expect(stop).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports an exporter failure without rejecting or logging its details', async () => {
    const stop = vi
      .fn()
      .mockRejectedValue(new Error('collector URL with sensitive query'));
    const warn = vi.fn();

    await expect(
      stopTelemetrySafely({ stop }, { warn }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { event: 'telemetry.shutdown_failed' },
      'telemetry shutdown failed',
    );
  });
});
