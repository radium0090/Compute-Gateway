import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export const genchiResolve = {
  alias: {
    '@genchi/api-contract': fromRoot('./packages/api-contract/src/index.ts'),
    '@genchi/application': fromRoot('./packages/application/src/index.ts'),
    '@genchi/auth': fromRoot('./packages/auth/src/index.ts'),
    '@genchi/config': fromRoot('./packages/config/src/index.ts'),
    '@genchi/coordination-redis': fromRoot(
      './packages/coordination-redis/src/index.ts',
    ),
    '@genchi/domain': fromRoot('./packages/domain/src/index.ts'),
    '@genchi/observability': fromRoot('./packages/observability/src/index.ts'),
    '@genchi/persistence-postgres': fromRoot(
      './packages/persistence-postgres/src/index.ts',
    ),
    '@genchi/provider-anthropic': fromRoot(
      './packages/provider-anthropic/src/index.ts',
    ),
    '@genchi/provider-gemini': fromRoot(
      './packages/provider-gemini/src/index.ts',
    ),
    '@genchi/provider-openai': fromRoot(
      './packages/provider-openai/src/index.ts',
    ),
    '@genchi/router': fromRoot('./packages/router/src/index.ts'),
    '@genchi/testkit': fromRoot('./packages/testkit/src/index.ts'),
  },
} as const;

export default defineConfig({
  resolve: genchiResolve,
  test: {
    coverage: {
      reporter: ['text', 'lcov'],
      thresholds: {
        branches: 66,
        functions: 81,
        lines: 76,
        statements: 74,
      },
    },
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
