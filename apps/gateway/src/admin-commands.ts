import { randomUUID } from 'node:crypto';

import { AdminConsoleService } from '@rax-digital/application';
import { NodeAdminSecurity } from '@rax-digital/auth';
import type { RuntimeConfig } from '@rax-digital/config';
import {
  PostgresAdminAuditRepository,
  PostgresAdminControlRepository,
  PostgresAdminIdentityRepository,
  PostgresApiKeyRepository,
  createPostgresPool,
} from '@rax-digital/persistence-postgres';

interface AdminCommandDependencies {
  readonly service: Pick<AdminConsoleService, 'bootstrapAdmin'>;
  readonly readPassword: () => Promise<string>;
  readonly output: (value: string) => void;
}

function parseCreateFlags(args: readonly string[]): {
  readonly email: string;
  readonly displayName: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      (flag !== '--email' && flag !== '--display-name') ||
      value === undefined ||
      value.startsWith('--') ||
      values.has(flag)
    ) {
      throw new Error(
        'Usage: rax-compute-gateway admins create --email <email> --display-name <name>',
      );
    }
    values.set(flag, value);
  }
  const email = values.get('--email');
  const displayName = values.get('--display-name');
  if (email === undefined || displayName === undefined || values.size !== 2) {
    throw new Error(
      'Usage: rax-compute-gateway admins create --email <email> --display-name <name>',
    );
  }
  return { email, displayName };
}

async function passwordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      'Pipe the temporary administrator password through standard input',
    );
  }
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin as AsyncIterable<string>) {
    value += chunk;
    if (value.length > 512)
      throw new Error('Administrator password input is too long');
  }
  return value.replace(/\r?\n$/, '');
}

export async function executeAdminCommand(
  args: readonly string[],
  dependencies: AdminCommandDependencies,
): Promise<void> {
  if (args[0] !== 'create') {
    throw new Error('Usage: rax-compute-gateway admins create [options]');
  }
  const flags = parseCreateFlags(args.slice(1));
  const password = await dependencies.readPassword();
  const user = await dependencies.service.bootstrapAdmin({
    ...flags,
    password,
  });
  dependencies.output(`administrator created: ${user.email}\n`);
}

/** Creates the first administrator without accepting passwords in arguments. */
export async function runAdminCommand(
  config: RuntimeConfig,
  args: readonly string[],
): Promise<void> {
  if (config.masterKey === undefined) {
    throw new Error('RCG_MASTER_KEY is required for administrator commands');
  }
  if (config.adminSessionPepper === undefined) {
    throw new Error(
      'RCG_ADMIN_SESSION_PEPPER is required for administrator commands',
    );
  }
  const pool = createPostgresPool({
    databaseUrl: config.databaseUrl,
    connectTimeoutMs: config.connectTimeoutMs,
    maxConnections: 1,
  });
  try {
    const identities = new PostgresAdminIdentityRepository(pool);
    await executeAdminCommand(args, {
      service: new AdminConsoleService(
        identities,
        new PostgresAdminControlRepository(pool),
        new PostgresApiKeyRepository(pool),
        new PostgresAdminAuditRepository(pool),
        new NodeAdminSecurity({ sessionPepper: config.adminSessionPepper }),
        {
          provision: () => {
            throw new Error(
              'API key provisioning is unavailable in this command',
            );
          },
        },
        { idGenerator: randomUUID },
      ),
      readPassword: passwordFromStdin,
      output: (value) => process.stdout.write(value),
    });
  } finally {
    await pool.end();
  }
}
