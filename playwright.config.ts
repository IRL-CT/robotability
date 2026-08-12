import { defineConfig } from '@playwright/test';

// Playwright configuration. The web server serves the built site from dist/.
// Run `pnpm build` before the tests.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4321',
  },
  webServer: {
    command: 'pnpm preview --port 4321',
    port: 4321,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
