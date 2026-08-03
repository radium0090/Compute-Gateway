import { defineConfig } from 'vitest/config';

import { genchiResolve } from './vitest.config.js';

export default defineConfig({
  resolve: genchiResolve,
  test: {
    include: ['apps/**/*.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
