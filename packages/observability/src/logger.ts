import pino, { type DestinationStream, type Logger } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  readonly environment: string;
  readonly level: LogLevel;
  readonly destination?: DestinationStream;
}

const forbiddenLogPaths = [
  'authorization',
  'cookie',
  'credential',
  'apiKey',
  'api_key',
  'providerKey',
  'provider_key',
  'keyHashPepper',
  'databaseUrl',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.cookie',
  '*.credential',
  '*.apiKey',
  '*.api_key',
  '*.providerKey',
  '*.provider_key',
  '*.keyHashPepper',
  '*.databaseUrl',
] as const;

/** Creates the only approved structured runtime logger. */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      name: 'genchi-gateway',
      level: options.level,
      base: {
        service: 'genchi-gateway',
        environment: options.environment,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [...forbiddenLogPaths],
        censor: '<redacted>',
      },
    },
    options.destination,
  );
}
