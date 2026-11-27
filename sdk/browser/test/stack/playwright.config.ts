import { defineConfig, devices } from '@playwright/test';

// The real thing end to end: a running kimmi (`docker compose up --build`), the examples built against it,
// a browser acting as visitors, then the dashboard and the API. Not part of CI: it needs the stack.
//   pnpm --filter @kimmi/browser test:stack
// Against a kimmi that is not the compose container (one on SQLite, say), set KIMMI_URL, KIMMI_BIN (the binary,
// run with this shell's KIMMI_* environment to create the projects) and KIMMI_HOOK_HOST=localhost.
export const KIMMI = process.env.KIMMI_URL ?? 'http://localhost:8700';
export const SHOP_PORT = 5294;
export const HOOK_PORT = 5295;
// A fixed public key (not a secret), so the example can be built before the project is looked up.
export const KEY = `km_pub_${'e2e0'.repeat(4)}`;
export const NEXT_PORT = 5296;
export const NEXT_KEY = `km_pub_${'e2e1'.repeat(4)}`;

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalSetup: './setup.ts',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: `pnpm exec vite build --outDir .stack-shop && node ../../sdk/browser/test/stack/serve.mjs .stack-shop ${SHOP_PORT}`,
      cwd: '../../../../examples/react-spa',
      url: `http://localhost:${SHOP_PORT}`,
      env: { VITE_KIMMI_KEY: KEY, VITE_KIMMI_HOST: KIMMI },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm run build && pnpm exec next start -p ${NEXT_PORT}`,
      cwd: '../../../../examples/nextjs',
      url: `http://localhost:${NEXT_PORT}`,
      env: { NEXT_PUBLIC_KIMMI_KEY: NEXT_KEY, NEXT_PUBLIC_KIMMI_HOST: KIMMI, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
