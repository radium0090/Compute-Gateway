import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export const raxComputeGatewayResolve = {
  alias: {
    '@rax-digital/api-contract': fromRoot(
      './packages/api-contract/src/index.ts',
    ),
    '@rax-digital/application': fromRoot('./packages/application/src/index.ts'),
    '@rax-digital/auth': fromRoot('./packages/auth/src/index.ts'),
    '@rax-digital/config': fromRoot('./packages/config/src/index.ts'),
    '@rax-digital/coordination-redis': fromRoot(
      './packages/coordination-redis/src/index.ts',
    ),
    '@rax-digital/domain': fromRoot('./packages/domain/src/index.ts'),
    '@rax-digital/observability': fromRoot(
      './packages/observability/src/index.ts',
    ),
    '@rax-digital/persistence-postgres': fromRoot(
      './packages/persistence-postgres/src/index.ts',
    ),
    '@rax-digital/provider-anthropic': fromRoot(
      './packages/provider-anthropic/src/index.ts',
    ),
    '@rax-digital/provider-gemini': fromRoot(
      './packages/provider-gemini/src/index.ts',
    ),
    '@rax-digital/provider-openai': fromRoot(
      './packages/provider-openai/src/index.ts',
    ),
    '@rax-digital/router': fromRoot('./packages/router/src/index.ts'),
    '@rax-digital/testkit': fromRoot('./packages/testkit/src/index.ts'),
  },
} as const;

export default defineConfig({
  resolve: raxComputeGatewayResolve,
  test: {
    coverage: {
      // PostgreSQL adapters are exercised by the real-service integration suite;
      // importing them through the composition root must not count as uncovered
      // unit-test code.
      exclude: [
        'packages/persistence-postgres/src/admin-repository.ts',
        'packages/persistence-postgres/src/demo-claim-repository.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        branches: 66,
        functions: 81,
        lines: 76,
        statements: 74,
      },
    },
    exclude: [
      ...configDefaults.exclude,
      '**/*.integration.test.ts',
      '**/*.live.test.ts',
      '**/*.rc.test.ts',
    ],
    include: [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'sdk/typescript/**/*.test.ts',
    ],
    testTimeout: 10_000,
  },
});
