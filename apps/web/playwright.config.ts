import { defineConfig } from '@playwright/test'

const dataDirectory = process.env['MMSMANAGER_DATA_DIR']
const chromiumPath = process.env['MMSMANAGER_E2E_CHROMIUM_PATH']
if (!dataDirectory?.startsWith('/tmp/mmsmanager-stage3-e2e-')) {
  throw new Error('Run browser checks with the web package e2e script so test data stays isolated.')
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5184',
    browserName: 'chromium',
    headless: true,
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --dir ../.. dev',
    url: 'http://127.0.0.1:5184',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      MMSMANAGER_DATA_DIR: dataDirectory,
      MMSMANAGER_TIME_ZONE: 'Europe/Paris',
      MMSMANAGER_API_PORT: '4184',
      MMSMANAGER_WEB_PORT: '5184',
    },
  },
})
