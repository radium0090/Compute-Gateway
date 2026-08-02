interface TelemetryHandle {
  stop(): Promise<void>;
}

interface WarningLogger {
  warn(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

/**
 * Flushes telemetry without allowing an unavailable collector to turn an
 * otherwise graceful process shutdown into a service failure.
 */
export async function stopTelemetrySafely(
  telemetry: TelemetryHandle,
  logger: WarningLogger,
): Promise<void> {
  try {
    await telemetry.stop();
  } catch {
    logger.warn(
      { event: 'telemetry.shutdown_failed' },
      'telemetry shutdown failed',
    );
  }
}
