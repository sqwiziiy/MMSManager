import { defineConfig } from '@playwright/test'

const dataDirectory = process.env['MMSMANAGER_DATA_DIR']
const chromiumPath = process.env['MMSMANAGER_E2E_CHROMIUM_PATH']
const webPort = Number(process.env['MMSMANAGER_E2E_WEB_PORT'] ?? 5184)
const apiPort = Number(process.env['MMSMANAGER_E2E_API_PORT'] ?? 4184)
if (!dataDirectory?.startsWith('/tmp/mmsmanager-stage3-e2e-')) {
  throw new Error('Run browser checks with the web package e2e script so test data stays isolated.')
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName: 'chromium',
    headless: true,
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --dir ../.. dev',
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      MMSMANAGER_DATA_DIR: dataDirectory,
      MMSMANAGER_TIME_ZONE: 'Europe/Paris',
      MMSMANAGER_API_PORT: String(apiPort),
      MMSMANAGER_WEB_PORT: String(webPort),
      MMSMANAGER_E2E: '1',
    },
  },
})
