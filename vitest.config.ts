import { defineConfig } from 'vitest/config';

// The whole suite talks to ONE shared Postgres (real DB, structural guarantees).
// Run single-threaded / single-fork so integration + concurrency specs don't
// stomp each other's rows; concurrency inside a single spec is driven explicitly
// with Promise.all against separate connections from the pool.
export default defineConfig({
  test: {
    globalSetup: ['./test/setup/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // config.ts validates these at import time; db.ts points at the test DB.
    env: {
      DATABASE_URL: 'postgres://kira:kira@localhost:5433/kira',
      API_KEY: 'test-api-key',
      WEBHOOK_SECRET: 'test-webhook-secret',
      CONFIRMATIONS: '12',
      PORT: '3999',
    },
  },
});
