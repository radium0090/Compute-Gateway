import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './migrations.js';

describe('runMigrations', () => {
  it('rejects malformed SQL filenames before opening a database connection', async () => {
    const migrationsDirectory = await mkdtemp(
      join(tmpdir(), 'rcg-migrations-'),
    );
    const pool = {
      connect: () => {
        throw new Error('database connection must not be attempted');
      },
    } as unknown as Pool;

    try {
      await writeFile(
        join(migrationsDirectory, '0004-customer-console.sql'),
        'SELECT 1;',
        'utf8',
      );

      await expect(runMigrations(pool, migrationsDirectory)).rejects.toThrow(
        'Invalid migration filename 0004-customer-console.sql; expected NNNN_description.sql',
      );
    } finally {
      await rm(migrationsDirectory, { recursive: true, force: true });
    }
  });
});
