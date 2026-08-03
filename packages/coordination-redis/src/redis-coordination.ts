import { createHash, randomUUID } from 'node:crypto';

import { createClient } from 'redis';

import type {
  AdmissionResult,
  CircuitBreaker,
  CircuitOutcome,
  CircuitPermit,
  CircuitPermitResult,
  CoordinationLease,
  ProviderConcurrencyController,
  RequestAdmissionController,
  ResolvedRoute,
} from '@genchi/domain';

export interface RedisCommandClient {
  eval(
    script: string,
    options: {
      readonly keys: readonly string[];
      readonly arguments: readonly string[];
    },
  ): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

export interface RedisCircuitOptions {
  readonly failureThreshold: number;
  readonly rollingWindowMs: number;
  readonly openDurationMs: number;
  readonly halfOpenMaxCalls: number;
}

const requestAcquireScript = `
local rate = tonumber(redis.call('GET', KEYS[1]) or '0')
if rate >= tonumber(ARGV[1]) then
  return {0, 1, math.max(redis.call('PTTL', KEYS[1]), 1000)}
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[5])
local inflight = redis.call('ZCARD', KEYS[2])
if inflight >= tonumber(ARGV[2]) then
  return {0, 2, 1000}
end
local next_rate = redis.call('INCR', KEYS[1])
if next_rate == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
redis.call('ZADD', KEYS[2], tonumber(ARGV[5]) + tonumber(ARGV[4]), ARGV[6])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[4]) + 1000)
return {1, 0, 0}
`;

const providerAcquireScript = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[4])
local global = redis.call('ZCARD', KEYS[1])
local provider = redis.call('ZCARD', KEYS[2])
if global >= tonumber(ARGV[1]) or provider >= tonumber(ARGV[2]) then
  return {0, 2, 1000}
end
local expires_at = tonumber(ARGV[4]) + tonumber(ARGV[3])
redis.call('ZADD', KEYS[1], expires_at, ARGV[5])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) + 1000)
redis.call('ZADD', KEYS[2], expires_at, ARGV[5])
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]) + 1000)
return {1, 0, 0}
`;

const releaseScript = `
for _, key in ipairs(KEYS) do
  redis.call('ZREM', key, ARGV[1])
end
return 1
`;

const circuitAcquireScript = `
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local open_until = tonumber(redis.call('HGET', KEYS[1], 'open_until') or '0')
local now = tonumber(ARGV[1])
if state == 'open' and open_until > now then
  return {0, 0, open_until - now}
end
if state == 'open' then
  state = 'half_open'
  redis.call('HSET', KEYS[1], 'state', state, 'probes', 0)
end
if state == 'half_open' then
  local probes = tonumber(redis.call('HGET', KEYS[1], 'probes') or '0')
  if probes >= tonumber(ARGV[2]) then return {0, 0, 1000} end
  redis.call('HINCRBY', KEYS[1], 'probes', 1)
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return {1, 1, 0}
end
return {1, 0, 0}
`;

const circuitRecordScript = `
local outcome = ARGV[1]
local probe = ARGV[2] == '1'
local now = tonumber(ARGV[3])
if outcome == 'success' then
  if probe then redis.call('DEL', KEYS[1], KEYS[2]) end
  return 1
end
if outcome == 'neutral' then
  if probe then
    local probes = tonumber(redis.call('HGET', KEYS[1], 'probes') or '0')
    if probes > 0 then redis.call('HINCRBY', KEYS[1], 'probes', -1) end
  end
  return 1
end
if probe then
  redis.call('HSET', KEYS[1], 'state', 'open', 'open_until', now + tonumber(ARGV[5]), 'probes', 0)
  redis.call('DEL', KEYS[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[7])
  return 1
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[4]))
redis.call('ZADD', KEYS[2], now, ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[8]) then
  redis.call('HSET', KEYS[1], 'state', 'open', 'open_until', now + tonumber(ARGV[5]), 'probes', 0)
  redis.call('DEL', KEYS[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[7])
end
return 1
`;

function resultTuple(value: unknown): readonly [number, number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    !value.slice(0, 3).every((item) => typeof item === 'number')
  ) {
    return null;
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function safeKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function routeKey(route: ResolvedRoute): string {
  return safeKey(`${route.providerRef}\u0000${route.providerModel}`);
}

function rejection(tuple: readonly [number, number, number]): AdmissionResult {
  return {
    ok: false,
    reason: tuple[1] === 1 ? 'rate_limited' : 'concurrency_limited',
    retryAfterSeconds: Math.max(1, Math.ceil(tuple[2] / 1_000)),
  };
}

function redisLease(
  client: RedisCommandClient,
  keys: readonly string[],
  token: string,
): CoordinationLease {
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client.eval(releaseScript, { keys, arguments: [token] });
    },
  };
}

/** Redis-backed distributed request limits, concurrency, and circuit state. */
export class RedisCoordination
  implements
    RequestAdmissionController,
    ProviderConcurrencyController,
    CircuitBreaker
{
  public constructor(
    private readonly client: RedisCommandClient,
    private readonly circuit: RedisCircuitOptions,
    private readonly clock: () => number = Date.now,
  ) {}

  public acquire(
    input:
      | {
          readonly apiKeyId: string;
          readonly requestsPerMinute: number;
          readonly maxConcurrentRequests: number;
          readonly leaseTtlMs: number;
        }
      | {
          readonly route: ResolvedRoute;
          readonly globalLimit: number;
          readonly providerLimit: number;
          readonly leaseTtlMs: number;
        },
  ): Promise<AdmissionResult>;
  public acquire(route: ResolvedRoute): Promise<CircuitPermitResult>;
  public async acquire(
    input:
      | ResolvedRoute
      | {
          readonly apiKeyId: string;
          readonly requestsPerMinute: number;
          readonly maxConcurrentRequests: number;
          readonly leaseTtlMs: number;
        }
      | {
          readonly route: ResolvedRoute;
          readonly globalLimit: number;
          readonly providerLimit: number;
          readonly leaseTtlMs: number;
        },
  ): Promise<AdmissionResult | CircuitPermitResult> {
    if ('providerRef' in input) return this.acquireCircuit(input);
    if ('apiKeyId' in input) return this.acquireRequest(input);
    return this.acquireProvider(input);
  }

  public async record(
    permit: CircuitPermit,
    outcome: CircuitOutcome,
  ): Promise<void> {
    const key = routeKey(permit.route);
    const ttl = Math.max(
      this.circuit.rollingWindowMs,
      this.circuit.openDurationMs * 2,
    );
    await this.client.eval(circuitRecordScript, {
      keys: [`genchi:circuit:${key}`, `genchi:circuit-failures:${key}`],
      arguments: [
        outcome,
        permit.probe ? '1' : '0',
        String(this.clock()),
        String(this.circuit.rollingWindowMs),
        String(this.circuit.openDurationMs),
        permit.token,
        String(ttl),
        String(this.circuit.failureThreshold),
      ],
    });
  }

  public async check(): Promise<{ readonly ready: boolean }> {
    try {
      return { ready: (await this.client.ping()) === 'PONG' };
    } catch {
      return { ready: false };
    }
  }

  public async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // Process shutdown remains bounded if Redis has already disconnected.
    }
  }

  private async acquireRequest(input: {
    readonly apiKeyId: string;
    readonly requestsPerMinute: number;
    readonly maxConcurrentRequests: number;
    readonly leaseTtlMs: number;
  }): Promise<AdmissionResult> {
    const now = this.clock();
    const bucket = Math.floor(now / 60_000);
    const key = safeKey(input.apiKeyId);
    const concurrencyKey = `genchi:key-concurrency:${key}`;
    const keys = [`genchi:rate:${key}:${String(bucket)}`, concurrencyKey];
    const token = randomUUID();
    try {
      const value = await this.client.eval(requestAcquireScript, {
        keys,
        arguments: [
          String(input.requestsPerMinute),
          String(input.maxConcurrentRequests),
          String(Math.max(1_000, (bucket + 1) * 60_000 - now)),
          String(input.leaseTtlMs),
          String(now),
          token,
        ],
      });
      const tuple = resultTuple(value);
      if (tuple === null) throw new TypeError('Invalid Redis script result');
      return tuple[0] === 1
        ? { ok: true, lease: redisLease(this.client, [concurrencyKey], token) }
        : rejection(tuple);
    } catch {
      return { ok: false, reason: 'coordination_unavailable' };
    }
  }

  private async acquireProvider(input: {
    readonly route: ResolvedRoute;
    readonly globalLimit: number;
    readonly providerLimit: number;
    readonly leaseTtlMs: number;
  }): Promise<AdmissionResult> {
    const keys = [
      'genchi:provider-concurrency:global',
      `genchi:provider-concurrency:${safeKey(input.route.providerRef)}`,
    ];
    const token = randomUUID();
    try {
      const value = await this.client.eval(providerAcquireScript, {
        keys,
        arguments: [
          String(input.globalLimit),
          String(input.providerLimit),
          String(input.leaseTtlMs),
          String(this.clock()),
          token,
        ],
      });
      const tuple = resultTuple(value);
      if (tuple === null) throw new TypeError('Invalid Redis script result');
      return tuple[0] === 1
        ? { ok: true, lease: redisLease(this.client, keys, token) }
        : rejection(tuple);
    } catch {
      return { ok: false, reason: 'coordination_unavailable' };
    }
  }

  private async acquireCircuit(
    route: ResolvedRoute,
  ): Promise<CircuitPermitResult> {
    const key = routeKey(route);
    try {
      const value = await this.client.eval(circuitAcquireScript, {
        keys: [`genchi:circuit:${key}`],
        arguments: [
          String(this.clock()),
          String(this.circuit.halfOpenMaxCalls),
          String(
            Math.max(
              this.circuit.rollingWindowMs,
              this.circuit.openDurationMs * 2,
            ),
          ),
        ],
      });
      const tuple = resultTuple(value);
      if (tuple === null) throw new TypeError('Invalid Redis script result');
      return tuple[0] === 1
        ? {
            ok: true,
            permit: {
              route,
              probe: tuple[1] === 1,
              token: randomUUID(),
            },
          }
        : {
            ok: false,
            reason: 'open',
            retryAfterSeconds: Math.max(1, Math.ceil(tuple[2] / 1_000)),
          };
    } catch {
      return { ok: false, reason: 'coordination_unavailable' };
    }
  }
}

/** Connects a Redis client without logging its URL or credentials. */
export async function createRedisCoordination(options: {
  readonly redisUrl: string;
  readonly connectTimeoutMs: number;
  readonly circuit: RedisCircuitOptions;
}): Promise<RedisCoordination> {
  const client = createClient({
    url: options.redisUrl,
    socket: { connectTimeout: options.connectTimeoutMs },
  });
  client.on('error', () => {
    // Operations fail closed through their typed coordination result.
  });
  try {
    await client.connect();
  } catch {
    client.destroy();
    throw new Error('Redis coordination connection failed');
  }
  const commands: RedisCommandClient = {
    eval: (script, input) =>
      client.eval(script, {
        keys: [...input.keys],
        arguments: [...input.arguments],
      }),
    ping: () => client.ping(),
    quit: () => client.quit(),
  };
  return new RedisCoordination(commands, options.circuit);
}
