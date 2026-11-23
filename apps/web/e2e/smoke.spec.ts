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
  await expect(page.getByText('Preview workspace')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-01-desktop.png'), fullPage: true })
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
  await page.screenshot({ path: resolve(screenshotDir, 'stage-01-server.png'), fullPage: true })
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
  await page.screenshot({ path: resolve(screenshotDir, 'stage-01-create-review.png') })
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
  await page.screenshot({ path: resolve(screenshotDir, 'stage-01-mobile.png'), fullPage: true })
  const routes = [
    '/servers', '/servers/alder-smp/overview', '/servers/alder-smp/logs',
    '/servers/alder-smp/mods', '/servers/alder-smp/properties', '/machine',
    '/users', '/profile', '/settings',
  ]
  for (const route of routes) {
    await page.goto(route)
    const size = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }))
    expect(size.content, `horizontal overflow on ${route}`).toBeLessThanOrEqual(size.viewport)
  }
  await page.goto('/')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.locator('.sidebar.mobile-open .nav-link[href="/machine"]').click()
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
})
