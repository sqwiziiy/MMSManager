import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const screenshotDir = resolve(process.cwd(), '../../reports/screenshots')
mkdirSync(screenshotDir, { recursive: true })

test('desktop navigation covers server detail screens without browser errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('Server records are DEMO')).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Search pages' })).toBeVisible()
  await page.getByPlaceholder('Search pages and servers').fill('Machine')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()

  await page.getByRole('link', { name: 'Servers' }).click()
  await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible()
  await page.getByRole('link', { name: /Alder SMP/ }).click()
  await expect(page.getByRole('heading', { name: 'Server overview' })).toBeVisible()
  await page.getByRole('link', { name: 'Console' }).click()
  await expect(page.getByText('Sample console stream')).toBeVisible()
  await page.getByRole('link', { name: 'Logs' }).click()
  await expect(page.getByRole('heading', { name: 'Log history' })).toBeVisible()
  await page.getByRole('link', { name: 'Players' }).click()
  await expect(page.getByRole('heading', { name: 'Player directory' })).toBeVisible()
  await page.getByRole('link', { name: 'Mods' }).click()
  await expect(page.getByRole('heading', { name: 'Installed mods' })).toBeVisible()
  await page.getByRole('link', { name: 'Properties' }).click()
  await expect(page.getByRole('heading', { name: 'Visual properties' })).toBeVisible()
  expect(errors).toEqual([])
})

test('server wizard stays a preview through all steps', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Create server', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Create server' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: /Paper/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Prepare preview' }).click()
  await expect(page.getByRole('heading', { name: 'Setup summary is ready' })).toBeVisible()
  await expect(page.getByText('No server was created')).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog', { name: 'Create server' })).toHaveCount(0)
})

test('mobile navigation works and dashboard has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  const width = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }))
  expect(width.content).toBeLessThanOrEqual(width.viewport)
  const routes = [
    '/servers', '/servers/alder-smp/overview', '/servers/alder-smp/logs',
    '/servers/alder-smp/mods', '/servers/alder-smp/properties', '/machine',
    '/users', '/profile', '/settings',
  ]
  for (const route of routes) {
    await page.goto(route)
    if (route === '/machine') {
      await page.screenshot({ path: resolve(screenshotDir, 'stage-02-machine-mobile.png'), fullPage: true })
    }
    const size = await page.evaluate(() => {
      const overflowing = [...document.querySelectorAll('body *')]
        .map((element) => ({ element, bounds: element.getBoundingClientRect() }))
        .filter(({ bounds }) => bounds.right > window.innerWidth + 1)
        .slice(0, 8)
        .map(({ element, bounds }) => ({
          tag: element.tagName,
          className: typeof element.className === 'string' ? element.className : '',
          right: Math.round(bounds.right),
          text: element.textContent?.trim().slice(0, 60),
        }))
      return { viewport: window.innerWidth, content: document.documentElement.scrollWidth, overflowing }
    })
    expect(size.content, `horizontal overflow on ${route}: ${JSON.stringify(size.overflowing)}`).toBeLessThanOrEqual(size.viewport)
  }
  await page.goto('/')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.locator('.sidebar.mobile-open .nav-link[href="/machine"]').click()
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
})

test('local host dashboard and machine overview show collected telemetry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('LIVE', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Servers online · DEMO')).toBeVisible()
  await expect(page.getByText('Local CPU · LIVE')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-02-dashboard-desktop.png'), fullPage: true })

  await page.goto('/machine')
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
  await expect(page.getByText('Local API connected')).toBeVisible()
  await expect(page.getByText('Collected from this local machine only.')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-02-machine-desktop.png'), fullPage: true })
})

test('history renders honest no-data and partial-day states', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/machine/history?month=2001-01&date=2001-01-01')
  await expect(page.getByText('No machine samples saved')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-02-history-no-data-desktop.png'), fullPage: true })

  const partialDay = {
    date: '2001-01-01',
    timeZone: 'Europe/Paris',
    status: 'partial',
    summary: {
      sampleCount: 2,
      firstSampleAt: '2001-01-01T00:00:00+01:00',
      lastSampleAt: '2001-01-01T00:00:10+01:00',
      coveragePercent: 1,
      cpuAveragePercent: 40,
      cpuMaximumPercent: 55,
      memoryPeakUsedBytes: 1024,
      memoryTotalBytes: 2048,
      memoryPeakPercent: 50,
      storageSnapshotUsedBytes: 4096,
      storagePeakUsedBytes: 4096,
      storageTotalBytes: 8192,
      networkReceivedBytes: 100,
      networkTransmittedBytes: 50,
    },
    points: [],
    events: [],
    window: {
      from: '2000-12-31T23:00:00.000Z',
      to: '2001-01-01T23:00:00.000Z',
      durationMs: 86_400_000,
    },
  }
  await page.route('**/api/v1/machine/day/2001-01-01', (route) => route.fulfill({ json: partialDay }))
  await page.reload()
  await expect(page.getByText(/Partial collection · 1% observed/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Monday, January 1, 2001' })).toBeVisible()
})

test('mobile history stays within the viewport and local API outage stays explicit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/machine/history?month=2001-01&date=2001-01-01')
  await expect(page.getByRole('heading', { name: 'Machine history' })).toBeVisible()
  const historySize = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }))
  expect(historySize.content).toBeLessThanOrEqual(historySize.viewport)
  await page.screenshot({ path: resolve(screenshotDir, 'stage-02-history-mobile.png'), fullPage: true })

  await page.route('**/api/v1/machine/current', (route) => route.abort())
  await page.goto('/')
  await expect(page.getByRole('status').getByText('Local metrics are unavailable')).toBeVisible()
  await expect(page.getByText('Local CPU · LIVE')).toBeVisible()
  await expect(page.getByText('Unavailable').first()).toBeVisible()
})
