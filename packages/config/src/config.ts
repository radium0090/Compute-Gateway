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
    adminEnabled: Type.Boolean(),
    adminOrigin: Type.Optional(Type.String({ minLength: 1 })),
    adminSessionPepper: Type.Optional(Type.String({ minLength: 32 })),
    adminSessionTtlMs: Type.Integer({ minimum: 900_000, maximum: 86_400_000 }),
    demoEnabled: Type.Boolean(),
    demoOrigin: Type.Optional(Type.String({ minLength: 1 })),
    demoGithubClientId: Type.Optional(Type.String({ minLength: 1 })),
    demoGithubClientSecret: Type.Optional(Type.String({ minLength: 1 })),
    demoHashPepper: Type.Optional(Type.String({ minLength: 32 })),
    demoTenantId: Type.Optional(
      Type.String({
        pattern:
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      }),
    ),
    demoModel: Type.String({ minLength: 1, maxLength: 200 }),
    demoKeyTtlMs: Type.Integer({ minimum: 60_000, maximum: 300_000 }),
    demoAccountMinimumAgeDays: Type.Integer({ minimum: 0, maximum: 3_650 }),
    demoAccountCooldownMs: Type.Integer({
      minimum: 60_000,
      maximum: 2_592_000_000,
    }),
    demoMaximumDailyClaims: Type.Integer({ minimum: 1, maximum: 10_000 }),
    demoRequestsPerMinute: Type.Integer({ minimum: 1, maximum: 60 }),
    demoMaxRequestTokens: Type.Integer({ minimum: 1, maximum: 100_000 }),
    demoMaxOutputTokens: Type.Integer({ minimum: 1, maximum: 4_096 }),
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
  adminEnabled: 'RCG_ADMIN_ENABLED',
  adminOrigin: 'RCG_ADMIN_ORIGIN',
  adminSessionPepper: 'RCG_ADMIN_SESSION_PEPPER',
  adminSessionTtlMs: 'RCG_ADMIN_SESSION_TTL_MS',
  demoEnabled: 'RCG_DEMO_ENABLED',
  demoOrigin: 'RCG_DEMO_ORIGIN',
  demoGithubClientId: 'RCG_DEMO_GITHUB_CLIENT_ID',
  demoGithubClientSecret: 'RCG_DEMO_GITHUB_CLIENT_SECRET',
  demoHashPepper: 'RCG_DEMO_HASH_PEPPER',
  demoTenantId: 'RCG_DEMO_TENANT_ID',
  demoModel: 'RCG_DEMO_MODEL',
  demoKeyTtlMs: 'RCG_DEMO_KEY_TTL_MS',
  demoAccountMinimumAgeDays: 'RCG_DEMO_ACCOUNT_MINIMUM_AGE_DAYS',
  demoAccountCooldownMs: 'RCG_DEMO_ACCOUNT_COOLDOWN_MS',
  demoMaximumDailyClaims: 'RCG_DEMO_MAXIMUM_DAILY_CLAIMS',
  demoRequestsPerMinute: 'RCG_DEMO_REQUESTS_PER_MINUTE',
  demoMaxRequestTokens: 'RCG_DEMO_MAX_REQUEST_TOKENS',
  demoMaxOutputTokens: 'RCG_DEMO_MAX_OUTPUT_TOKENS',
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
    adminEnabled: parseBoolean(source.RCG_ADMIN_ENABLED, false),
    ...(source.RCG_ADMIN_ORIGIN === undefined
      ? {}
      : { adminOrigin: source.RCG_ADMIN_ORIGIN }),
    ...(source.RCG_ADMIN_SESSION_PEPPER === undefined
      ? {}
      : { adminSessionPepper: source.RCG_ADMIN_SESSION_PEPPER }),
    adminSessionTtlMs: parseInteger(
      source.RCG_ADMIN_SESSION_TTL_MS,
      8 * 60 * 60 * 1_000,
    ),
    demoEnabled: parseBoolean(source.RCG_DEMO_ENABLED, false),
    ...(source.RCG_DEMO_ORIGIN === undefined
      ? {}
      : { demoOrigin: source.RCG_DEMO_ORIGIN }),
    ...(source.RCG_DEMO_GITHUB_CLIENT_ID === undefined
      ? {}
      : { demoGithubClientId: source.RCG_DEMO_GITHUB_CLIENT_ID }),
    ...(source.RCG_DEMO_GITHUB_CLIENT_SECRET === undefined
      ? {}
      : { demoGithubClientSecret: source.RCG_DEMO_GITHUB_CLIENT_SECRET }),
    ...(source.RCG_DEMO_HASH_PEPPER === undefined
      ? {}
      : { demoHashPepper: source.RCG_DEMO_HASH_PEPPER }),
    ...(source.RCG_DEMO_TENANT_ID === undefined
      ? {}
      : { demoTenantId: source.RCG_DEMO_TENANT_ID }),
    demoModel: source.RCG_DEMO_MODEL ?? 'rax/fast',
    demoKeyTtlMs: parseInteger(source.RCG_DEMO_KEY_TTL_MS, 300_000),
    demoAccountMinimumAgeDays: parseInteger(
      source.RCG_DEMO_ACCOUNT_MINIMUM_AGE_DAYS,
      7,
    ),
    demoAccountCooldownMs: parseInteger(
      source.RCG_DEMO_ACCOUNT_COOLDOWN_MS,
      86_400_000,
    ),
    demoMaximumDailyClaims: parseInteger(
      source.RCG_DEMO_MAXIMUM_DAILY_CLAIMS,
      50,
    ),
    demoRequestsPerMinute: parseInteger(source.RCG_DEMO_REQUESTS_PER_MINUTE, 2),
    demoMaxRequestTokens: parseInteger(
      source.RCG_DEMO_MAX_REQUEST_TOKENS,
      2_048,
    ),
    demoMaxOutputTokens: parseInteger(source.RCG_DEMO_MAX_OUTPUT_TOKENS, 128),
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

  if (candidate.adminEnabled) {
    if (candidate.adminOrigin === undefined) {
      issues.push(
        'RCG_ADMIN_ORIGIN is required when the admin console is enabled',
      );
    } else if (!isUrlWithProtocol(candidate.adminOrigin, ['http:', 'https:'])) {
      issues.push('RCG_ADMIN_ORIGIN must be an HTTP(S) origin');
    } else {
      const origin = new URL(candidate.adminOrigin);
      if (origin.origin !== candidate.adminOrigin || origin.pathname !== '/') {
        issues.push('RCG_ADMIN_ORIGIN must contain only scheme and authority');
      }
      if (
        candidate.environment === 'production' &&
        origin.protocol !== 'https:'
      ) {
        issues.push('RCG_ADMIN_ORIGIN must use HTTPS in production');
      }
    }
    if (candidate.adminSessionPepper === undefined) {
      issues.push(
        'RCG_ADMIN_SESSION_PEPPER is required when the admin console is enabled',
      );
    }
  }

  if (candidate.demoEnabled) {
    if (candidate.demoOrigin === undefined) {
      issues.push(
        'RCG_DEMO_ORIGIN is required when the hosted demo is enabled',
      );
    } else if (!isUrlWithProtocol(candidate.demoOrigin, ['http:', 'https:'])) {
      issues.push('RCG_DEMO_ORIGIN must be an HTTP(S) origin');
    } else {
      const origin = new URL(candidate.demoOrigin);
      if (origin.origin !== candidate.demoOrigin || origin.pathname !== '/') {
        issues.push('RCG_DEMO_ORIGIN must contain only scheme and authority');
      }
      if (
        candidate.environment === 'production' &&
        origin.protocol !== 'https:'
      ) {
        issues.push('RCG_DEMO_ORIGIN must use HTTPS in production');
      }
    }
    if (candidate.demoGithubClientId === undefined) {
      issues.push(
        'RCG_DEMO_GITHUB_CLIENT_ID is required when the hosted demo is enabled',
      );
    }
    if (candidate.demoGithubClientSecret === undefined) {
      issues.push(
        'RCG_DEMO_GITHUB_CLIENT_SECRET is required when the hosted demo is enabled',
      );
    }
    if (candidate.demoHashPepper === undefined) {
      issues.push(
        'RCG_DEMO_HASH_PEPPER is required when the hosted demo is enabled',
      );
    }
    if (candidate.demoTenantId === undefined) {
      issues.push(
        'RCG_DEMO_TENANT_ID is required when the hosted demo is enabled',
      );
    }
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
  Record<
    | 'RCG_KEY_HASH_PEPPER'
    | 'RCG_MASTER_KEY'
    | 'RCG_ADMIN_SESSION_PEPPER'
    | 'RCG_DEMO_GITHUB_CLIENT_SECRET'
    | 'RCG_DEMO_HASH_PEPPER',
    '<set>' | '<unset>'
  >
> {
  return {
    RCG_KEY_HASH_PEPPER: '<set>',
    RCG_MASTER_KEY: config.masterKey === undefined ? '<unset>' : '<set>',
    RCG_ADMIN_SESSION_PEPPER:
      config.adminSessionPepper === undefined ? '<unset>' : '<set>',
    RCG_DEMO_GITHUB_CLIENT_SECRET:
      config.demoGithubClientSecret === undefined ? '<unset>' : '<set>',
    RCG_DEMO_HASH_PEPPER:
      config.demoHashPepper === undefined ? '<unset>' : '<set>',
  };
}
