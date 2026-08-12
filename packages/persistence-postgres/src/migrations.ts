import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Pool } from 'pg';

const migrationFilePattern = /^(\d{4})_[a-z0-9-]+\.sql$/;
const advisoryLockName = 'rcg:schema-migrations';

interface AppliedMigrationRow {
  readonly version: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly appliedVersions: readonly string[];
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/** Applies immutable ordered SQL migrations under a PostgreSQL advisory lock. */
export async function runMigrations(
  pool: Pool,
  migrationsDirectory: string,
): Promise<MigrationResult> {
  const entries = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && migrationFilePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const client = await pool.connect();
  const appliedVersions: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [
      advisoryLockName,
    ]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<AppliedMigrationRow>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const checksums = new Map(
      applied.rows.map((row) => [row.version, row.checksum]),
    );

    for (const filename of entries) {
      const match = migrationFilePattern.exec(filename);
      if (match === null) {
        continue;
      }
      const version = match[1];
      if (version === undefined) {
        continue;
      }
      const sql = await readFile(join(migrationsDirectory, filename), 'utf8');
      const currentChecksum = checksum(sql);
      const storedChecksum = checksums.get(version);
      if (storedChecksum !== undefined) {
        if (storedChecksum !== currentChecksum) {
          throw new Error(
            `Migration checksum drift detected for version ${version}`,
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [version, currentChecksum],
        );
        await client.query('COMMIT');
        appliedVersions.push(version);
      } catch (error: unknown) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
        advisoryLockName,
      ]);
    } finally {
      client.release();
    }
  }

  return { appliedVersions };
}
