import pg from 'pg';

const { Pool } = pg;

export interface PostgresPoolOptions {
  readonly databaseUrl: string;
  readonly connectTimeoutMs: number;
  readonly maxConnections?: number;
}

/** Creates a bounded PostgreSQL pool owned by the gateway lifecycle. */
export function createPostgresPool(options: PostgresPoolOptions): pg.Pool {
  return new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: options.connectTimeoutMs,
    max: options.maxConnections ?? 10,
    allowExitOnIdle: false,
  });
}

export interface ReadinessProbeResult {
  readonly ready: boolean;
}

/** Database readiness probe that never exposes connection error details. */
export class PostgresReadinessProbe {
  public constructor(private readonly pool: pg.Pool) {}

  public async check(): Promise<ReadinessProbeResult> {
    try {
      await this.pool.query('SELECT 1');
      return { ready: true };
    } catch {
      return { ready: false };
    }
  }
}
