import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests share one database; running files in parallel would
    // let them see each other's rows.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
