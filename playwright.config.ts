import { defineConfig } from '@playwright/test'

// End-to-end tests load the built extension (dist/) into Chromium.
// `npm run test:e2e` builds first.
export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { trace: 'retain-on-failure' },
})
