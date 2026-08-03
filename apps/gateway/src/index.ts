#!/usr/bin/env node
import {
  ConfigValidationError,
  PolicyConfigValidationError,
  loadConfig,
  loadPolicyConfig,
  loadProviderCredentials,
} from '@genchi/config';
import { createLogger, TelemetryLifecycle } from '@genchi/observability';

import { stopTelemetrySafely } from './telemetry-shutdown.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const command = process.argv.slice(2);

  const telemetry = new TelemetryLifecycle({
    environment: config.environment,
    serviceVersion: config.serviceVersion,
    commitSha: config.commitSha,
    metricsEnabled: config.metricsEnabled,
    ...(config.otlpEndpoint === undefined
      ? {}
      : { otlpEndpoint: config.otlpEndpoint }),
  });
  const bootstrapLogger = createLogger({
    environment: config.environment,
    level: config.logLevel,
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
    if (command[0] === 'keys') {
      const { runKeyCommand } = await import('./key-commands.js');
      await runKeyCommand(config, command.slice(1));
      return;
    }
    const policy = await loadPolicyConfig(
      config.configFile,
      config.environment,
    );
    const credentials = loadProviderCredentials(policy, process.env);
    if (command.length === 1 && command[0] === '--check-config') {
      process.stdout.write('configuration valid\n');
      return;
    }
    if (command.length !== 0) {
      throw new Error('Unsupported command');
    }
    await runtime.runGateway(
      config,
      policy,
      credentials,
      telemetry.metricsRequestHandler(),
    );
  } finally {
    await stopTelemetrySafely(telemetry, bootstrapLogger);
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
