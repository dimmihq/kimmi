import { defineConfig, devices } from '@playwright/test';

// The real thing end to end: a running kimmi (`docker compose up --build`), the React example built against it,
// a browser acting as visitors, then the dashboard and the API. Not part of CI: it needs the stack.
//   pnpm --filter @kimmi/browser test:stack
export const KIMMI = process.env.KIMMI_URL ?? 'http://localhost:8700';
export const SHOP_PORT = 5294;
export const HOOK_PORT = 5295;
// A fixed public key (not a secret), so the example can be built before the project is looked up.
export const KEY = `km_pub_${'e2e0'.repeat(4)}`;

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalSetup: './setup.ts',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: `pnpm run build && pnpm exec vite preview --port ${SHOP_PORT} --strictPort`,
      cwd: '../../../../examples/react-spa',
      url: `http://localhost:${SHOP_PORT}`,
      env: { VITE_KIMMI_KEY: KEY, VITE_KIMMI_HOST: KIMMI },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
