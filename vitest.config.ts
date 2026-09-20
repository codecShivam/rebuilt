import { defineConfig } from 'vitest/config';

// the real-claude file is its own suite: `npm run test:real` sets the variable and runs only
// it, and `npm test` never includes it, because every run spends the subscription window
const real = process.env['SITE_REAL_CLAUDE'] === '1';

export default defineConfig({
  test: {
    include: real
      ? ['test/real/**/*.test.ts']
      : ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: real ? 4 * 3_600_000 : 120_000,
    hookTimeout: real ? 1_800_000 : 120_000,
    pool: 'forks',
    // one file at a time. an integration file drives its own chromium and a dev server, and
    // several of the assertions are about wall clock (a worker's timeout, the overlap of two
    // scheduled units, the window a kill lands in): run in parallel they measure the load on
    // the machine instead of the thing under test.
    fileParallelism: false,
  },
});
