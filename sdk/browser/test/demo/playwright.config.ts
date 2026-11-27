import { defineConfig } from '@playwright/test';

// Demo data: a browser acts as a few hundred different visitors of the example shop, against a kimmi started
// with KIMMI_TEST_HOOKS=1 (visits are spread over the past two weeks). Run through `make demo`.
export const KIMMI = process.env.KIMMI_URL ?? 'http://localhost:8700';
/** The shop built for the project with analytics on, and for the replay-only project. */
export const SHOPS = { rich: 'http://localhost:5225', replay: 'http://localhost:5226' } as const;

export default defineConfig({
  testDir: '.',
  // `DEMO_PART` picks what runs: the visitors (default), the closing `tour`, or the page `review`
  // (timings and screenshots).
  testMatch: `${process.env.DEMO_PART ?? 'visitors'}.spec.ts`,
  timeout: 120_000,
  fullyParallel: true,
  workers: Number(process.env.DEMO_WORKERS ?? 6),
  retries: 1,
  reporter: 'dot',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
