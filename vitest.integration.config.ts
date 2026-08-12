import { configDefaults, defineConfig } from 'vitest/config';

import { raxComputeGatewayResolve } from './vitest.config.js';

export default defineConfig({
  resolve: raxComputeGatewayResolve,
  test: {
    exclude: configDefaults.exclude,
    include: ['packages/**/*.integration.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
