#!/usr/bin/env node
import {
  ConfigValidationError,
  PolicyConfigValidationError,
  loadConfig,
  loadPolicyConfig,
} from '@genchi/config';
import { TelemetryLifecycle } from '@genchi/observability';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  await loadPolicyConfig(config.configFile, config.environment);
  const command = process.argv.slice(2);

  if (command.length === 1 && command[0] === '--check-config') {
    process.stdout.write('configuration valid\n');
    return;
  }

  const telemetry = new TelemetryLifecycle({
    environment: config.environment,
    serviceVersion: '0.0.0',
    metricsEnabled: config.metricsEnabled,
    ...(config.otlpEndpoint === undefined
      ? {}
      : { otlpEndpoint: config.otlpEndpoint }),
  });
  telemetry.start();

  try {
    const runtime = await import('./main.js');
    if (
      command.length === 2 &&
      command[0] === 'migrate' &&
      command[1] === 'up'
    ) {
      await runtime.runMigrationCommand(config);
      return;
    }
    if (command.length !== 0) {
      throw new Error('Unsupported command');
    }
    await runtime.runGateway(config);
  } finally {
    await telemetry.stop();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigValidationError ||
    error instanceof PolicyConfigValidationError
      ? error.message
      : 'Genchi command failed; see structured logs for details';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
