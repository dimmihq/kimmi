import { defineConfig, devices } from '@playwright/test';

// Ports of their own: the examples' dev servers may already be running on 5220 and 5230.
export const MOCK_PORT = 5291;
export const REACT_PORT = 5292;
export const NEXT_PORT = 5293;
const mock = `http://localhost:${MOCK_PORT}`;

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'node mock-server.ts',
      url: `${mock}/_health`,
      env: { MOCK_PORT: String(MOCK_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `pnpm run build && pnpm exec vite preview --port ${REACT_PORT} --strictPort`,
      cwd: '../../../../examples/react-spa',
      url: `http://localhost:${REACT_PORT}`,
      env: { VITE_KIMMI_KEY: 'km_pub_react', VITE_KIMMI_HOST: mock },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm run build && pnpm exec next start -p ${NEXT_PORT}`,
      cwd: '../../../../examples/nextjs',
      url: `http://localhost:${NEXT_PORT}`,
      env: { NEXT_PUBLIC_KIMMI_KEY: 'km_pub_next', NEXT_PUBLIC_KIMMI_HOST: mock, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
