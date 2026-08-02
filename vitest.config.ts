import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const fromRoot = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@genchi/api-contract': fromRoot('./packages/api-contract/src/index.ts'),
      '@genchi/auth': fromRoot('./packages/auth/src/index.ts'),
      '@genchi/config': fromRoot('./packages/config/src/index.ts'),
      '@genchi/domain': fromRoot('./packages/domain/src/index.ts'),
      '@genchi/observability': fromRoot(
        './packages/observability/src/index.ts',
      ),
      '@genchi/persistence-postgres': fromRoot(
        './packages/persistence-postgres/src/index.ts',
      ),
    },
  },
  test: {
    coverage: {
      reporter: ['text', 'lcov'],
    },
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
