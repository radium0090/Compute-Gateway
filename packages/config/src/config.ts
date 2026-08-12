import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const EnvironmentSchema = Type.Union([
  Type.Literal('development'),
  Type.Literal('test'),
  Type.Literal('staging'),
  Type.Literal('production'),
]);

const LogLevelSchema = Type.Union([
  Type.Literal('debug'),
  Type.Literal('info'),
  Type.Literal('warn'),
  Type.Literal('error'),
]);

export const RuntimeConfigSchema = Type.Object(
  {
    environment: EnvironmentSchema,
    databaseUrl: Type.String({ minLength: 1 }),
    masterKey: Type.Optional(Type.String({ minLength: 32 })),
    keyHashPepper: Type.String({ minLength: 32 }),
    configFile: Type.String({ minLength: 1 }),
    redisUrl: Type.Optional(Type.String({ minLength: 1 })),
    otlpEndpoint: Type.Optional(Type.String({ minLength: 1 })),
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65_535 }),
    logLevel: LogLevelSchema,
    requestBodyLimitBytes: Type.Integer({ minimum: 1 }),
    totalTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
    connectTimeoutMs: Type.Integer({ minimum: 1 }),
    shutdownGraceMs: Type.Integer({ minimum: 1 }),
    trustProxy: Type.Boolean(),
    metricsEnabled: Type.Boolean(),
    serviceVersion: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._+-]*$',
    }),
    commitSha: Type.String({ pattern: '^(unknown|[a-f0-9]{7,64})$' }),
  },
  { additionalProperties: false },
);

/** Fully validated process settings consumed by the composition root. */
export type RuntimeConfig = Static<typeof RuntimeConfigSchema>;

/** Explicit configuration source used instead of hidden global environment reads. */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

const fieldToEnvironmentVariable: Readonly<Record<string, string>> = {
  environment: 'RCG_ENVIRONMENT',
  databaseUrl: 'RCG_DATABASE_URL',
  masterKey: 'RCG_MASTER_KEY',
  keyHashPepper: 'RCG_KEY_HASH_PEPPER',
  configFile: 'RCG_CONFIG_FILE',
  redisUrl: 'RCG_REDIS_URL',
  otlpEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
  host: 'RCG_HOST',
  port: 'RCG_PORT',
  logLevel: 'RCG_LOG_LEVEL',
  requestBodyLimitBytes: 'RCG_REQUEST_BODY_LIMIT_BYTES',
  totalTimeoutMs: 'RCG_TOTAL_TIMEOUT_MS',
  connectTimeoutMs: 'RCG_CONNECT_TIMEOUT_MS',
  shutdownGraceMs: 'RCG_SHUTDOWN_GRACE_MS',
  trustProxy: 'RCG_TRUST_PROXY',
  metricsEnabled: 'RCG_METRICS_ENABLED',
  serviceVersion: 'RCG_SERVICE_VERSION',
  commitSha: 'RCG_COMMIT_SHA',
};

/** Safe startup failure containing environment-variable names, never values. */
export class ConfigValidationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`Configuration validation failed: ${issues.join('; ')}`);
    this.name = 'ConfigValidationError';
  }
}

function parseInteger(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number(value);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return value as unknown as boolean;
}

function isUrlWithProtocol(
  value: string,
  protocols: readonly string[],
): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function schemaIssueToSafeMessage(path: string): string {
  const field = path.replace(/^\//, '').split('/')[0] ?? '';
  return `${fieldToEnvironmentVariable[field] ?? 'configuration'} is invalid`;
}

/** Loads and validates all process-level settings without exposing secret values. */
export function loadConfig(source: EnvironmentSource): RuntimeConfig {
  const candidate = {
    environment: source.RCG_ENVIRONMENT,
    databaseUrl: source.RCG_DATABASE_URL,
    ...(source.RCG_MASTER_KEY === undefined
      ? {}
      : { masterKey: source.RCG_MASTER_KEY }),
    keyHashPepper: source.RCG_KEY_HASH_PEPPER,
    configFile:
      source.RCG_CONFIG_FILE ?? '/etc/rax-compute-gateway/config.yaml',
    ...(source.RCG_REDIS_URL === undefined
      ? {}
      : { redisUrl: source.RCG_REDIS_URL }),
    ...(source.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? {}
      : { otlpEndpoint: source.OTEL_EXPORTER_OTLP_ENDPOINT }),
    host: source.RCG_HOST ?? '0.0.0.0',
    port: parseInteger(source.RCG_PORT, 8080),
    logLevel: source.RCG_LOG_LEVEL ?? 'info',
    requestBodyLimitBytes: parseInteger(
      source.RCG_REQUEST_BODY_LIMIT_BYTES,
      2_097_152,
    ),
    totalTimeoutMs: parseInteger(source.RCG_TOTAL_TIMEOUT_MS, 60_000),
    connectTimeoutMs: parseInteger(source.RCG_CONNECT_TIMEOUT_MS, 30_000),
    shutdownGraceMs: parseInteger(source.RCG_SHUTDOWN_GRACE_MS, 30_000),
    trustProxy: parseBoolean(source.RCG_TRUST_PROXY, false),
    metricsEnabled: parseBoolean(source.RCG_METRICS_ENABLED, true),
    serviceVersion: source.RCG_SERVICE_VERSION ?? '0.0.0',
    commitSha: source.RCG_COMMIT_SHA ?? 'unknown',
  };

  const issues = [...Value.Errors(RuntimeConfigSchema, candidate)].map(
    (error) => schemaIssueToSafeMessage(error.path),
  );

  if (
    typeof candidate.databaseUrl === 'string' &&
    !isUrlWithProtocol(candidate.databaseUrl, ['postgres:', 'postgresql:'])
  ) {
    issues.push('RCG_DATABASE_URL must be a PostgreSQL URL');
  }

  if (
    candidate.redisUrl !== undefined &&
    !isUrlWithProtocol(candidate.redisUrl, ['redis:', 'rediss:'])
  ) {
    issues.push('RCG_REDIS_URL must be a Redis URL');
  }

  if (
    candidate.otlpEndpoint !== undefined &&
    !isUrlWithProtocol(candidate.otlpEndpoint, ['http:', 'https:'])
  ) {
    issues.push('OTEL_EXPORTER_OTLP_ENDPOINT must be an HTTP(S) URL');
  }

  if (candidate.connectTimeoutMs >= candidate.totalTimeoutMs) {
    issues.push(
      'RCG_CONNECT_TIMEOUT_MS must be less than RCG_TOTAL_TIMEOUT_MS',
    );
  }

  if (/\s/.test(candidate.host)) {
    issues.push('RCG_HOST is invalid');
  }

  if (candidate.environment === 'production' && candidate.trustProxy) {
    issues.push('RCG_TRUST_PROXY requires explicit proxy CIDRs in production');
  }

  if (
    candidate.environment === 'production' &&
    candidate.redisUrl === undefined
  ) {
    issues.push(
      'RCG_REDIS_URL is required in production for distributed limits',
    );
  }

  if (issues.length > 0 || !Value.Check(RuntimeConfigSchema, candidate)) {
    throw new ConfigValidationError([...new Set(issues)]);
  }

  return candidate;
}

/** Returns secret presence only, suitable for diagnostics. */
export function describeSecretPresence(
  config: RuntimeConfig,
): Readonly<
  Record<'RCG_KEY_HASH_PEPPER' | 'RCG_MASTER_KEY', '<set>' | '<unset>'>
> {
  return {
    RCG_KEY_HASH_PEPPER: '<set>',
    RCG_MASTER_KEY: config.masterKey === undefined ? '<unset>' : '<set>',
  };
}
