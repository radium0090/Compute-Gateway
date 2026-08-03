import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { buildGateway } from '../apps/gateway/src/app.js';
import { loadConfig } from '../packages/config/src/index.js';
import { createLogger } from '../packages/observability/src/index.js';

interface Reference {
  readonly schema_version: number;
  readonly scenario: string;
  readonly warmup_requests: number;
  readonly measured_requests: number;
  readonly concurrency: number;
  readonly p95_threshold_ms: number;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function reference(value: unknown): Reference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('benchmark reference must be an object');
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    candidate.schema_version !== 1 ||
    candidate.scenario !== 'loopback_non_streaming_stub_provider'
  ) {
    throw new Error('unsupported benchmark reference');
  }
  return {
    schema_version: 1,
    scenario: candidate.scenario,
    warmup_requests: positiveInteger(
      candidate.warmup_requests,
      'warmup_requests',
    ),
    measured_requests: positiveInteger(
      candidate.measured_requests,
      'measured_requests',
    ),
    concurrency: positiveInteger(candidate.concurrency, 'concurrency'),
    p95_threshold_ms: positiveInteger(
      candidate.p95_threshold_ms,
      'p95_threshold_ms',
    ),
  };
}

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * quantile) - 1] ?? Number.NaN;
}

const root = path.resolve(import.meta.dirname, '..');
const baseline = reference(
  JSON.parse(
    await readFile(path.join(root, 'benchmarks', 'reference.json'), 'utf8'),
  ) as unknown,
);
const config = loadConfig({
  GENCHI_ENVIRONMENT: 'test',
  GENCHI_DATABASE_URL: 'postgresql://genchi:fake@localhost:5432/genchi',
  GENCHI_KEY_HASH_PEPPER: 'fake-pepper-with-at-least-32-characters',
});
const app = await buildGateway({
  config,
  logger: createLogger({ environment: 'test', level: 'error' }),
  readinessProbe: { check: () => Promise.resolve({ ready: true }) },
  chatCompletionService: {
    execute: () =>
      Promise.resolve({
        ok: true,
        response: {
          content: 'ok',
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        route: {
          providerRef: 'benchmark',
          provider: 'openai',
          providerModel: 'benchmark-model',
        },
        attempts: 1,
      }),
    executeStream: () => Promise.reject(new Error('not used')),
  },
});

await app.listen({ host: '127.0.0.1', port: 0 });
try {
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gateway did not expose a TCP address');
  }
  const target = `http://127.0.0.1:${String(address.port)}/v1/chat/completions`;
  const payload = JSON.stringify({
    model: 'genchi/benchmark',
    messages: [{ role: 'user', content: 'benchmark' }],
  });
  const request = async (): Promise<number> => {
    const started = performance.now();
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        authorization: 'Bearer benchmark-placeholder',
        'content-type': 'application/json',
      },
      body: payload,
    });
    await response.arrayBuffer();
    if (response.status !== 200) {
      throw new Error(`benchmark request returned ${String(response.status)}`);
    }
    return performance.now() - started;
  };
  for (let index = 0; index < baseline.warmup_requests; index += 1) {
    await request();
  }
  const samples: number[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: baseline.concurrency }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= baseline.measured_requests) return;
        samples.push(await request());
      }
    }),
  );
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const result = {
    scenario: baseline.scenario,
    runtime: process.version,
    samples: samples.length,
    concurrency: baseline.concurrency,
    p50_ms: Number(p50.toFixed(2)),
    p95_ms: Number(p95.toFixed(2)),
    threshold_ms: baseline.p95_threshold_ms,
    passed: p95 < baseline.p95_threshold_ms,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
} finally {
  await app.close();
}
