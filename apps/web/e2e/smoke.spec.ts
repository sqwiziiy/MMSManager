import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const screenshotDir = resolve(process.cwd(), '../../reports/screenshots')
mkdirSync(screenshotDir, { recursive: true })

const adminPassword = process.env['MMSMANAGER_E2E_ADMIN_PASSWORD']!
const memberPassword = process.env['MMSMANAGER_E2E_MEMBER_PASSWORD']!
const browserSessionPath = resolve(process.env['MMSMANAGER_DATA_DIR']!, 'browser-session.json')

test.use({
  storageState: async (_fixtures, use) => {
    await use(existsSync(browserSessionPath) ? browserSessionPath : undefined)
  },
})
async function signIn(page: Page, username = 'stage-admin', password = adminPassword): Promise<void> {
  await page.goto('/login')
  const authHeading = page.getByRole('heading', { name: /^(Dashboard|Sign in to MMSManager)$/ })
  await expect(authHeading).toBeVisible()
  if (await page.getByRole('heading', { name: 'Sign in to MMSManager' }).isVisible()) {
    await page.getByLabel('Username').fill(username)
    await page.locator('input[name="password"]').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.locator('.profile-trigger')).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    if (username === 'stage-admin') await page.context().storageState({ path: browserSessionPath })
  }
}

async function signOut(page: Page): Promise<void> {
  await page.locator('.profile-trigger').click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
}

async function expectNoHorizontalOverflow(page: Page, route: string): Promise<void> {
  const size = await page.evaluate(() => ({ viewport: window.innerWidth, content: document.documentElement.scrollWidth }))
  expect(size.content, `horizontal overflow on ${route}`).toBeLessThanOrEqual(size.viewport)
}

test('first-run administrator setup creates the protected local workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole('heading', { name: 'Create your administrator' })).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-setup-desktop.png'), fullPage: true })

  const token = readFileSync(resolve(process.env['MMSMANAGER_DATA_DIR']!, 'bootstrap-token'), 'utf8').trim()
  await page.getByLabel('One-time setup key').fill(token)
  await page.getByLabel('Username').fill('stage-admin')
  await page.getByLabel('Display name').fill('Stage Administrator')
  await page.locator('input[name="password"]').fill(adminPassword)
  await page.getByLabel('Confirm password').fill(adminPassword)
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('Server records are DEMO')).toBeVisible()
  await page.context().storageState({ path: browserSessionPath })
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-dashboard-desktop.png'), fullPage: true })
  expect(page.url()).not.toContain('/setup')
})

test('desktop navigation keeps server pages clearly in preview mode', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
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
  await signIn(page)
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

test('mobile dashboard, account screens and navigation fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  const routes = [
    ['/', 'Dashboard'], ['/servers', 'Servers'], ['/servers/alder-smp/overview', 'Server overview'],
    ['/servers/alder-smp/logs', 'Log history'], ['/servers/alder-smp/mods', 'Installed mods'],
    ['/servers/alder-smp/properties', 'Visual properties'], ['/machine', 'Machine'],
    ['/users', 'Users'], ['/profile', 'Profile'], ['/settings', 'Settings'],
  ] as const
  for (const [route, heading] of routes) {
    await page.goto(route)
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible()
    await expectNoHorizontalOverflow(page, route)
    if (route === '/machine') await page.screenshot({ path: resolve(screenshotDir, 'stage-03-machine-mobile.png'), fullPage: true })
    if (route === '/users') await page.screenshot({ path: resolve(screenshotDir, 'stage-03-users-mobile.png'), fullPage: true })
    if (route === '/profile') await page.screenshot({ path: resolve(screenshotDir, 'stage-03-profile-mobile.png'), fullPage: true })
    if (route === '/settings') await page.screenshot({ path: resolve(screenshotDir, 'stage-03-settings-mobile.png'), fullPage: true })
  }
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.locator('.sidebar.mobile-open .nav-link[href="/machine"]').click()
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
})

test('local host metrics and history remain protected and visibly local', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  await expect(page.getByText('LIVE', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Servers online · DEMO')).toBeVisible()
  await expect(page.getByText('Local CPU · LIVE')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-dashboard-authenticated-desktop.png'), fullPage: true })

  await page.goto('/machine')
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
  await expect(page.getByText('Local API connected')).toBeVisible()
  await expect(page.getByText('Collected from this local machine only.')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-machine-desktop.png'), fullPage: true })

  await page.goto('/machine/history?month=2001-01&date=2001-01-01')
  await expect(page.getByText('No machine samples saved')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-history-no-data-desktop.png'), fullPage: true })
})

test('local accounts enforce administrator-only management and member access', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  await page.goto('/users')
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  await expect(page.locator('.account-users-table .data-table-row').filter({ hasText: '@stage-admin' })).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-users-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Add user' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a user' })
  await dialog.getByLabel('Username').fill('stage-member')
  await dialog.getByLabel('Display name').fill('Stage Member')
  await dialog.getByLabel('Initial password').fill(memberPassword)
  await dialog.getByLabel('Role').selectOption('member')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(page.locator('.account-users-table .data-table-row').filter({ hasText: '@stage-member' })).toBeVisible()

  await signOut(page)
  await signIn(page, 'stage-member', memberPassword)
  await page.goto('/users')
  await expect(page.getByRole('heading', { name: 'Administrator access required' })).toBeVisible()
  const forbiddenStatus = await page.evaluate(async () => (await fetch('/api/v1/admin/users')).status)
  expect(forbiddenStatus).toBe(403)
  await page.goto('/profile')
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()
})

test('profile, avatar and personal preferences persist; password change revokes the session', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  await page.goto('/profile')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-profile-desktop.png'), fullPage: true })
  await page.getByLabel('Display name').fill('Stage Owner Updated')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByRole('heading', { name: 'Stage Owner Updated' })).toBeVisible()

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPI7Q35D8IMMAYAT+wJNX0Qn/AAAAAASUVORK5CYII=', 'base64')
  await page.getByLabel('Choose profile image').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png })
  await expect(page.locator('.account-avatar img').first()).toBeVisible()

  await page.goto('/settings')
  await page.getByRole('button', { name: 'Personal' }).click()
  await page.locator('.account-switch').click()
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await expect(page.getByRole('checkbox', { name: 'Compact navigation' })).toBeChecked()
  await page.reload()
  await page.getByRole('button', { name: 'Personal' }).click()
  await expect(page.getByRole('checkbox', { name: 'Compact navigation' })).toBeChecked()

  const newPassword = `${adminPassword}Changed!`
  await page.goto('/profile')
  await page.getByLabel('Current password').fill(adminPassword)
  const newPasswordFields = page.locator('.account-password-form input[autocomplete="new-password"]')
  await newPasswordFields.nth(0).fill(newPassword)
  await newPasswordFields.nth(1).fill(newPassword)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Sign in to MMSManager' })).toBeVisible()
  await page.getByLabel('Username').fill('stage-admin')
  await page.locator('input[name="password"]').fill(newPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('.profile-trigger')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()
})
