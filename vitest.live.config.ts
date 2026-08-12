import { defineConfig } from 'vitest/config';

import { raxComputeGatewayResolve } from './vitest.config.js';

export default defineConfig({
  resolve: raxComputeGatewayResolve,
  test: {
    include: ['apps/**/*.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
