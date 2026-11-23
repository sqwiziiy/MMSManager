import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5183',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --dir ../.. dev',
    url: 'http://127.0.0.1:5183',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      MMSMANAGER_DATA_DIR: '/tmp/mmsmanager-e2e-data',
      MMSMANAGER_TIME_ZONE: 'Europe/Paris',
      MMSMANAGER_API_PORT: '4183',
      MMSMANAGER_WEB_PORT: '5183',
    },
  },
})
