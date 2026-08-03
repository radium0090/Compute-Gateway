import { randomUUID } from 'node:crypto';

import { provisionApiKey } from '@genchi/auth';
import type { RuntimeConfig } from '@genchi/config';
import {
  apiKeyId,
  tenantId,
  type ApiKeyEnvironment,
  type ApiKeyRepository,
} from '@genchi/domain';
import {
  createPostgresPool,
  PostgresApiKeyRepository,
} from '@genchi/persistence-postgres';

interface KeyCommandDependencies {
  readonly repository: ApiKeyRepository;
  readonly pepper: string;
  readonly clock: () => Date;
  readonly idGenerator: () => string;
  readonly output: (value: string) => void;
}

const environmentAliases: Readonly<
  Record<string, ApiKeyEnvironment | undefined>
> = {
  dev: 'development',
  development: 'development',
  test: 'test',
  stg: 'staging',
  staging: 'staging',
  prod: 'production',
  production: 'production',
};

function parseFlags(
  args: readonly string[],
): ReadonlyMap<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith('--')) {
      throw new Error('Key command arguments must use named flags');
    }
    if (flags.has(flag)) throw new Error(`Duplicate key command flag: ${flag}`);
    if (flag === '--allow-streaming' || flag === '--allow-tools') {
      flags.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Key command flag requires a value: ${flag}`);
    }
    flags.set(flag, value);
    index += 1;
  }
  return flags;
}

function textFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  required = true,
): string | undefined {
  const value = flags.get(name);
  if (typeof value === 'string' && value.length > 0) return value;
  if (required) throw new Error(`Missing required key command flag: ${name}`);
  return undefined;
}

function positiveFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  fallback: number,
): number {
  const raw = textFlag(flags, name, false);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function assertOnly(
  flags: ReadonlyMap<string, string | true>,
  allowed: ReadonlySet<string>,
): void {
  for (const flag of flags.keys()) {
    if (!allowed.has(flag))
      throw new Error(`Unknown key command flag: ${flag}`);
  }
}

async function createKey(
  args: readonly string[],
  dependencies: KeyCommandDependencies,
): Promise<void> {
  const flags = parseFlags(args);
  assertOnly(
    flags,
    new Set([
      '--tenant-id',
      '--name',
      '--environment',
      '--models',
      '--requests-per-minute',
      '--max-concurrent-requests',
      '--max-request-tokens',
      '--max-output-tokens',
      '--expires-at',
      '--allow-streaming',
      '--allow-tools',
    ]),
  );
  const tenant = textFlag(flags, '--tenant-id');
  const name = textFlag(flags, '--name');
  const rawEnvironment = textFlag(flags, '--environment');
  const models = textFlag(flags, '--models')
    ?.split(',')
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
  if (
    tenant === undefined ||
    name === undefined ||
    rawEnvironment === undefined ||
    models === undefined ||
    models.length === 0
  ) {
    throw new Error('Required key command value is missing');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      tenant,
    )
  ) {
    throw new Error('--tenant-id must be a UUID');
  }
  const environment = environmentAliases[rawEnvironment];
  if (environment === undefined) throw new Error('--environment is invalid');
  const rawExpiry = textFlag(flags, '--expires-at', false);
  const expiresAt = rawExpiry === undefined ? null : new Date(rawExpiry);
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    throw new Error('--expires-at must be an ISO-8601 timestamp');
  }
  const maxRequestTokens = textFlag(flags, '--max-request-tokens', false);
  const maxOutputTokens = textFlag(flags, '--max-output-tokens', false);
  const provisioned = provisionApiKey(
    {
      id: apiKeyId(dependencies.idGenerator()),
      tenantId: tenantId(tenant),
      name,
      environment,
      pepper: dependencies.pepper,
      policy: {
        allowedModelPatterns: models,
        allowStreaming: flags.has('--allow-streaming'),
        allowTools: flags.has('--allow-tools'),
        requestsPerMinute: positiveFlag(flags, '--requests-per-minute', 60),
        maxConcurrentRequests: positiveFlag(
          flags,
          '--max-concurrent-requests',
          10,
        ),
        ...(maxRequestTokens === undefined
          ? {}
          : {
              maxRequestTokens: positiveFlag(flags, '--max-request-tokens', 1),
            }),
        ...(maxOutputTokens === undefined
          ? {}
          : {
              maxOutputTokens: positiveFlag(flags, '--max-output-tokens', 1),
            }),
      },
      expiresAt,
    },
    dependencies.clock(),
  );
  await dependencies.repository.create(provisioned.apiKey);
  dependencies.output(`${provisioned.credential}\n`);
}

async function revokeKey(
  args: readonly string[],
  dependencies: KeyCommandDependencies,
): Promise<void> {
  const flags = parseFlags(args);
  assertOnly(flags, new Set(['--id']));
  const id = textFlag(flags, '--id');
  if (id === undefined || !/^[0-9a-f-]{36}$/iu.test(id)) {
    throw new Error('--id must be a UUID');
  }
  if (!(await dependencies.repository.revoke(apiKeyId(id)))) {
    throw new Error('API key was not found or was already revoked');
  }
  dependencies.output(`revoked ${id}\n`);
}

export async function executeKeyCommand(
  args: readonly string[],
  dependencies: KeyCommandDependencies,
): Promise<void> {
  const operation = args[0];
  if (operation === 'create') return createKey(args.slice(1), dependencies);
  if (operation === 'revoke') return revokeKey(args.slice(1), dependencies);
  throw new Error('Usage: genchi keys <create|revoke> [options]');
}

export async function runKeyCommand(
  config: RuntimeConfig,
  args: readonly string[],
): Promise<void> {
  if (config.masterKey === undefined) {
    throw new Error('GENCHI_MASTER_KEY is required for key commands');
  }
  const pool = createPostgresPool({
    databaseUrl: config.databaseUrl,
    connectTimeoutMs: config.connectTimeoutMs,
    maxConnections: 1,
  });
  try {
    await executeKeyCommand(args, {
      repository: new PostgresApiKeyRepository(pool),
      pepper: config.keyHashPepper,
      clock: () => new Date(),
      idGenerator: randomUUID,
      output: (value) => {
        process.stdout.write(value);
      },
    });
  } finally {
    await pool.end();
  }
}
