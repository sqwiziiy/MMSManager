import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const screenshotDir = resolve(process.cwd(), '../../reports/screenshots')
mkdirSync(screenshotDir, { recursive: true })

const adminPassword = process.env['MMSMANAGER_E2E_ADMIN_PASSWORD']!
const memberPassword = process.env['MMSMANAGER_E2E_MEMBER_PASSWORD']!
const browserSessionPath = resolve(process.env['MMSMANAGER_DATA_DIR']!, 'browser-session.json')

test.use({
  storageState: async ({ browser: _browser }, use) => {
    void _browser
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

async function mockLocalServer(page: Page) {
  const serverId = 'e03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const backupId = 'c03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const now = new Date().toISOString()
  const server = { id: serverId, name: 'Local Fixture', source: 'created', software: 'paper', version: '1.21.4', jarName: 'server.jar', javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096, port: 25565, eula: 'accepted', managed: true, worldFolders: ['world'], createdAt: now, runtimeStatus: 'running' }
  let settings = { motd: 'A local fixture', gameMode: 'survival', difficulty: 'normal', maxPlayers: 20, viewDistance: 10, simulationDistance: 8, spawnProtection: 16, pvp: true, whiteList: false, allowNether: true }
  let restartRequired = false
  const properties = () => ({ settings, unknownKeys: ['online-mode', 'server-ip', 'level-seed'], backups: restartRequired ? [{ id: backupId, createdAt: now, sha256: 'a'.repeat(64) }] : [], restartRequired })
  const consoleResponse = { entries: [
    { id: 1, occurredAt: now, source: 'system', severity: 'info', message: 'MMSManager launched this local process.' },
    { id: 2, occurredAt: now, source: 'stdout', severity: 'info', message: 'Done (1.2s)! For help, type "help"' },
  ], nextAfter: null }
  await page.route('**/api/v1/servers', (route) => route.fulfill({ json: { servers: [server] } }))
  await page.route('**/api/v1/admin/servers', (route) => route.fulfill({ json: { servers: [{ ...server, directory: '/tmp/mmsmanager-e2e/local-fixture', javaPath: '/tmp/fake-java' }], managedRoot: '/tmp/mmsmanager-e2e/servers', importRoots: ['/tmp/mmsmanager-e2e/servers'] } }))
  await page.route(`**/api/v1/servers/${serverId}/runtime`, (route) => route.fulfill({ json: { runtime: { serverId, status: 'running', startedAt: now, uptimeSeconds: 153, memoryRssBytes: 536870912, cpuPercent: null, ready: true, playersOnline: null, eula: 'accepted', restartRequired, lastExitCode: null, errorMessage: null } } }))
  await page.route(`**/api/v1/servers/${serverId}/status`, (route) => route.fulfill({ json: { status: { serverId, checkedAt: now, source: 'local-status-ping', state: 'reachable', playersOnline: 3, playersMax: 20, versionName: 'Paper 1.21.4', description: 'Local fixture', latencyMs: 4, errorCode: null, authoritativePlayerList: false } } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/players`, (route) => route.fulfill({ json: { players: { serverId, state: 'authoritative', source: 'owned-console-list', sampledAt: now, names: ['FixturePlayer'], reason: null } } }))
  const modItems = [{ id: 'fixture-plugin.jar', fileName: 'fixture-plugin.jar', sizeBytes: 768, state: 'enabled', metadataKind: 'paper', metadataState: 'known', modId: 'FixturePlugin', name: 'Fixture Plugin', artifactVersion: '1.3.0', minecraftConstraint: '1.21', loaderConstraint: null, dependencies: ['LuckPerms'] }]
  const modsInventory = () => ({ serverId, supported: true, loader: 'paper', loadDirectory: 'plugins', items: modItems, truncated: false, restartRequired, runtimeStatus: 'running' })
  await page.route(`**/api/v1/servers/${serverId}/mods`, (route) => route.fulfill({ json: { mods: modsInventory() } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/mods**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/mods')) {
      const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
      const fileName = /filename="([^"]+)"/.exec(body)?.[1] ?? 'uploaded-fixture.jar'
      modItems.push({ id: fileName, fileName, sizeBytes: 512, state: 'enabled', metadataKind: 'unknown', metadataState: 'unknown', modId: null, name: null, artifactVersion: null, minecraftConstraint: null, loaderConstraint: null, dependencies: [] })
      restartRequired = true
      return route.fulfill({ status: 201, json: { mods: modsInventory() } })
    }
    const restore = /\/quarantine\/([0-9a-f-]{36})\/restore$/.exec(path)
    if (restore) {
      const item = modItems.find((candidate) => candidate.id === restore[1])
      if (item) item.state = 'enabled'
    } else {
      const fileName = decodeURIComponent(path.split('/').at(-2) ?? '')
      const item = modItems.find((candidate) => candidate.fileName === fileName)
      if (item) {
        if (path.endsWith('/disable')) item.state = 'disabled'
        else if (path.endsWith('/enable')) item.state = 'enabled'
        else if (path.endsWith('/quarantine')) { item.state = 'quarantined'; item.id = 'c03c1cf8-e2a1-4a4e-9de4-4536c7796091' }
      }
    }
    restartRequired = true
    return route.fulfill({ json: { mods: modsInventory() } })
  })
  await page.route(`**/api/v1/servers/${serverId}/console?*`, (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0)
    return route.fulfill({ json: { entries: consoleResponse.entries.filter((entry) => entry.id > after), nextAfter: null } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/properties`, async (route) => {
    if (route.request().method() === 'PATCH') {
      settings = { ...settings, ...(route.request().postDataJSON() as Partial<typeof settings>) }
      restartRequired = true
    }
    return route.fulfill({ json: { properties: properties() } })
  })
  let submittedCommand: string | undefined
  let submittedPlayerAction: { action?: string; username?: string } | undefined
  await page.route(`**/api/v1/admin/servers/${serverId}/player-actions`, async (route) => {
    submittedPlayerAction = route.request().postDataJSON() as { action?: string; username?: string }
    return route.fulfill({ json: { state: 'unverified', action: submittedPlayerAction.action, username: submittedPlayerAction.username ?? null, submittedAt: now, confirmedAt: null } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/console`, async (route) => {
    submittedCommand = (route.request().postDataJSON() as { command?: string }).command
    return route.fulfill({ status: 202, json: { ok: true } })
  })
  return { serverId, get submittedCommand() { return submittedCommand }, get submittedPlayerAction() { return submittedPlayerAction } }
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
  await expect(page.getByText('Local server registry connected')).toBeVisible()
  await expect(page.getByText('No servers registered on this computer.')).toBeVisible()
  await page.context().storageState({ path: browserSessionPath })
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-dashboard-desktop.png'), fullPage: true })
  await page.screenshot({ path: resolve(screenshotDir, 'stage-05a-dashboard-empty-desktop.png'), fullPage: true })
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
  await expect(page.getByRole('link', { name: /Alder SMP/ })).toHaveCount(0)
  await page.goto('/servers/alder-smp/overview')
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

test('admin creates a server through mocked provider responses', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page)
  const operationId = '3fc0b937-3e7f-4938-b432-5cc98a529e7c'
  const serverId = 'f03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  let pollCount = 0
  let submitted: Record<string, unknown> | null = null
  await page.route('**/api/v1/admin/java', (route) => route.fulfill({ json: { runtimes: [{ path: '/tmp/mmsmanager-e2e-java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered' }] } }))
  await page.route('**/api/v1/admin/servers', (route) => route.fulfill({ json: { servers: [], managedRoot: '/tmp/mmsmanager-stage3-e2e-servers', importRoots: ['/tmp/mmsmanager-stage3-e2e-servers'] } }))
  await page.route('**/api/v1/admin/server-installs/catalog?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill({ json: { software: 'vanilla', versions: ['1.21.4'], loaders: [], builds: [], installerVersion: null, requiredJavaMajor: url.searchParams.has('version') ? 21 : null } })
  })
  await page.route('**/api/v1/admin/server-installs', async (route) => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ status: 202, json: { operation: { id: operationId, name: 'Local community server', directoryName: 'community-server', software: 'vanilla', version: '1.21.4', status: 'pending', progress: 1, phase: 'queued', serverId: null, artifactUrl: null, artifactSize: null, artifactSha256: null, error: null, partialDirectory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } })
    }
    return route.fulfill({ json: { operations: [] } })
  })
  await page.route(`**/api/v1/admin/server-installs/${operationId}`, (route) => {
    pollCount += 1
    const completed = pollCount > 1
    return route.fulfill({ json: { operation: { id: operationId, name: 'Local community server', directoryName: 'community-server', software: 'vanilla', version: '1.21.4', status: completed ? 'completed' : 'downloading', progress: completed ? 100 : 48, phase: completed ? 'complete' : 'downloading', serverId: completed ? serverId : null, artifactUrl: completed ? 'https://piston-data.mojang.com/server.jar' : null, artifactSize: completed ? 9 : null, artifactSha256: completed ? 'a'.repeat(64) : null, error: null, partialDirectory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } })
  })
  await page.getByRole('button', { name: 'Create server', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Create server' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByLabel('Minecraft release')).toBeEnabled()
  await expect(page.getByText('Mojang metadata requires Java 21 or newer')).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('New local server · stopped after install')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04b-install-review-desktop.png') })
  await page.getByRole('button', { name: 'Install server' }).click()
  await expect(page.getByText('Installation in progress')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04b-install-progress-desktop.png') })
  await expect(page.getByText('Installation complete')).toBeVisible({ timeout: 5000 })
  expect(submitted).toMatchObject({ software: 'vanilla', version: '1.21.4', eulaAccepted: false, directoryName: 'community-server' })
  expect(page.url()).not.toContain('/servers/')
  await page.getByRole('button', { name: 'Open server' }).click()
  await expect(page.getByRole('dialog', { name: 'Create server' })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Create server', exact: true }).click()
  const mobileWizard = page.getByRole('dialog', { name: 'Create server' })
  await expect(mobileWizard).toBeVisible()
  await expectNoHorizontalOverflow(page, 'mobile install wizard details')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04b-install-mobile.png'), animations: 'disabled' })
  await mobileWizard.getByRole('button', { name: 'Continue' }).click()
  await expect(mobileWizard.getByLabel('Minecraft release')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'mobile install wizard software')
})

test('failed installs preserve partial files and retry into a new directory', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page)
  const failedId = '4fc0b937-3e7f-4938-b432-5cc98a529e7c'
  const completedId = '5fc0b937-3e7f-4938-b432-5cc98a529e7c'
  const serverId = '6fc0b937-3e7f-4938-b432-5cc98a529e7c'
  const sent: Record<string, unknown>[] = []
  await page.route('**/api/v1/admin/java', (route) => route.fulfill({ json: { runtimes: [{ path: '/tmp/mmsmanager-e2e-java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered' }] } }))
  await page.route('**/api/v1/admin/servers', (route) => route.fulfill({ json: { servers: [], managedRoot: '/tmp/mmsmanager-stage3-e2e-servers', importRoots: ['/tmp/mmsmanager-stage3-e2e-servers'] } }))
  await page.route('**/api/v1/admin/server-installs/catalog?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill({ json: { software: 'vanilla', versions: ['1.21.4'], loaders: [], builds: [], installerVersion: null, requiredJavaMajor: url.searchParams.has('version') ? 21 : null } })
  })
  await page.route('**/api/v1/admin/server-installs', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { operations: [] } })
    const input = route.request().postDataJSON() as Record<string, unknown>
    sent.push(input)
    const id = sent.length === 1 ? failedId : completedId
    return route.fulfill({ status: 202, json: { operation: { id, name: 'Retry Fixture', directoryName: input['directoryName'], software: 'vanilla', version: '1.21.4', status: 'pending', progress: 1, phase: 'queued', serverId: null, artifactUrl: null, artifactSize: null, artifactSha256: null, error: null, partialDirectory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } })
  })
  await page.route(`**/api/v1/admin/server-installs/${failedId}`, (route) => route.fulfill({ json: { operation: { id: failedId, name: 'Retry Fixture', directoryName: 'retry-fixture', software: 'vanilla', version: '1.21.4', status: 'failed', progress: 50, phase: 'failed', serverId: null, artifactUrl: null, artifactSize: null, artifactSha256: null, error: { code: 'CHECKSUM_MISMATCH', message: 'The provider checksum did not match.' }, partialDirectory: '/tmp/mmsmanager-stage3-e2e-servers/retry-fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } }))
  await page.route(`**/api/v1/admin/server-installs/${completedId}`, (route) => route.fulfill({ json: { operation: { id: completedId, name: 'Retry Fixture', directoryName: String(sent[1]?.['directoryName'] ?? 'retry-fixture-2'), software: 'vanilla', version: '1.21.4', status: 'completed', progress: 100, phase: 'complete', serverId, artifactUrl: 'https://piston-data.mojang.com/server.jar', artifactSize: 9, artifactSha256: 'b'.repeat(64), error: null, partialDirectory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } }))

  await page.getByRole('button', { name: 'Create server', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create server' })
  await dialog.getByLabel('New directory name').fill('retry-fixture')
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByLabel('Minecraft release')).toBeEnabled()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Install server' }).click()
  await expect(dialog.getByText('Installation stopped')).toBeVisible({ timeout: 5000 })
  await expect(dialog.getByText('Partial files were preserved for review under the managed root.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Review and retry' }).click()
  const retryDirectory = await dialog.getByLabel('New directory name').inputValue()
  expect(retryDirectory).toMatch(/^retry-fixture-retry-/)
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByLabel('Minecraft release')).toBeEnabled()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Install server' }).click()
  await expect(dialog.getByText('Installation complete')).toBeVisible({ timeout: 5000 })
  expect(sent).toHaveLength(2)
  expect(sent[0]?.['directoryName']).toBe('retry-fixture')
  expect(sent[1]?.['directoryName']).toBe(retryDirectory)
})

test('admin imports a disposable local folder through a read-only preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const serverDirectory = join(process.env['MMSMANAGER_DATA_DIR']!, 'servers', 'e2e-import')
  mkdirSync(serverDirectory, { recursive: true })
  writeFileSync(join(serverDirectory, 'server.properties'), '# fixture only\nserver-port=25571\n')
  writeFileSync(join(serverDirectory, 'server.jar'), 'not a real Minecraft archive')

  await page.goto('/servers')
  await page.getByRole('button', { name: 'Import existing' }).click()
  const dialog = page.getByRole('dialog', { name: 'Import an existing server' })
  await dialog.getByLabel('Absolute server folder path').fill(serverDirectory)
  await dialog.getByRole('button', { name: 'Inspect folder' }).click()
  await expect(dialog.getByText('Vanilla')).toBeVisible()
  await expect(dialog.getByText('25571')).toBeVisible()
  await expect(dialog.locator('.server-import-facts').getByText('Not found').first()).toBeVisible()
  await dialog.getByLabel('Display name').fill('Temporary Smoke Server')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04a-import-dialog-desktop.png') })
  await dialog.getByRole('button', { name: 'Add to local registry' }).click()
  await expect(page.getByText('Temporary Smoke Server')).toBeVisible()
  await expect(page.getByText(serverDirectory, { exact: true })).toBeVisible()
  expect(existsSync(join(serverDirectory, 'server.properties'))).toBe(true)
  expect(existsSync(join(serverDirectory, 'server.jar'))).toBe(true)
  expect(existsSync(join(serverDirectory, 'eula.txt'))).toBe(false)
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04a-servers-desktop.png'), fullPage: true })
})

test('local server overview, console and visual properties use mocked API data', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const fixture = await mockLocalServer(page)
  await page.goto('/servers')
  await page.getByRole('link', { name: /Local Fixture/ }).click()
  await expect(page.getByRole('heading', { name: 'Local Fixture' })).toBeVisible()
  await expect(page.getByText('Running', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Players online').locator('..')).toContainText('3')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04c-local-server-desktop.png'), fullPage: true })
  await page.getByRole('link', { name: 'Players' }).click()
  await expect(page.getByRole('heading', { name: 'Online identities' })).toBeVisible()
  await expect(page.getByText('FixturePlayer', { exact: true })).toBeVisible()
  await expect(page.getByText('The status ping never proves player identities', { exact: false })).toBeVisible()
  await page.getByLabel('Player action').selectOption('ban')
  await page.getByLabel('Minecraft username').fill('FixturePlayer')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Send player command' }).click()
  await expect.poll(() => fixture.submittedPlayerAction).toEqual({ action: 'ban', username: 'FixturePlayer' })
  await expect(page.getByText(/command was sent, but the server response was not recognized/)).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-05a-local-players-desktop.png'), fullPage: true })
  await page.getByRole('link', { name: 'Overview' }).click()

  await page.getByRole('link', { name: 'Console' }).click()
  await expect(page.getByText('Connected to owned process')).toBeVisible()
  await expect(page.getByText('Done (1.2s)! For help, type "help"')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04c-local-console-desktop.png'), fullPage: true })
  await page.getByRole('textbox', { name: 'Minecraft server command' }).fill('say browser fixture')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => fixture.submittedCommand).toBe('say browser fixture')

  await page.getByRole('link', { name: 'Logs' }).click()
  await expect(page.getByRole('heading', { name: 'Process output' })).toBeVisible()
  await expect(page.getByText('Done (1.2s)! For help, type "help"').first()).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04c-local-logs-desktop.png'), fullPage: true })

  await page.getByRole('link', { name: 'Properties' }).click()
  await expect(page.getByRole('heading', { name: 'Server properties', level: 3 })).toBeVisible()
  await expect(page.getByText('3 other properties preserved')).toBeVisible()
  await page.getByLabel('Message of the day').fill('Changed in browser fixture')
  await page.getByRole('button', { name: 'Save properties' }).click()
  await expect(page.getByText('Saved with a recovery copy.')).toBeVisible()
  await expect(page.getByText('Restart required').first()).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04d-properties-desktop.png'), fullPage: true })
})

test('local server detail and property controls fit a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  await page.goto(`/servers/${serverId}/overview`)
  await expect(page.getByRole('heading', { name: 'Local Fixture' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server mobile overview')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04c-local-server-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('link', { name: 'Properties' }).click()
  await expect(page.getByLabel('Message of the day')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server mobile properties')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04d-properties-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('link', { name: 'Console' }).click()
  await expect(page.getByRole('textbox', { name: 'Minecraft server command' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server mobile console')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-04c-local-console-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('link', { name: 'Players' }).click()
  await expect(page.getByRole('heading', { name: 'Online identities' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server mobile players')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-05a-local-players-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('local Paper plugin inventory uploads and disables only acknowledged files', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  await page.goto(`/servers/${serverId}/mods`)
  await expect(page.getByRole('heading', { name: 'Paper plugins' })).toBeVisible()
  await expect(page.getByText('Fixture Plugin')).toBeVisible()
  await expect(page.getByText('LuckPerms')).toBeVisible()
  await page.locator('input[name="mod-file"]').setInputFiles({ name: 'new-addon.jar', mimeType: 'application/java-archive', buffer: Buffer.from('mock archive fixture') })
  await page.getByRole('button', { name: 'Upload JAR' }).click()
  await expect(page.locator('.local-mod-row').filter({ hasText: 'new-addon.jar' })).toBeVisible()
  await expect(page.getByText('JAR installed. Restart required before it is loaded.')).toBeVisible()
  const fixtureRow = page.locator('.local-mod-row').filter({ hasText: 'Fixture Plugin' })
  await fixtureRow.getByRole('button', { name: 'Disable' }).click()
  await expect(fixtureRow.getByText('disabled', { exact: true })).toBeVisible()
  await expect(page.getByText('Restart required').first()).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-05b-paper-plugins-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'local Paper plugins mobile')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-05b-paper-plugins-mobile.png'), fullPage: true, animations: 'disabled' })
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
    if (route === '/servers') await page.screenshot({ path: resolve(screenshotDir, 'stage-04a-servers-mobile.png'), fullPage: true })
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
  await expect(page.getByText('Running servers')).toBeVisible()
  await expect(page.getByText('Local CPU · LIVE')).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-03-dashboard-authenticated-desktop.png'), fullPage: true })

  await page.goto('/machine')
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
  await expect(page.getByText('Local API connected')).toBeVisible()
  await expect(page.getByText('Collected from this local machine only.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Java runtime inventory' })).toBeVisible()
  await expect(page.getByText('Reading checked runtimes…')).toHaveCount(0, { timeout: 10_000 })
  await page.route('**/api/v1/admin/java/scan', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ runtimes: [{ path: '/test/java-21/bin/java', version: '21.0.4', major: 21, vendor: 'Temurin', source: 'discovered' }] }),
  }))
  await page.getByRole('button', { name: 'Scan standard paths' }).click()
  await expect(page.getByText('Temurin 21')).toBeVisible()
  await page.locator('.java-inventory-card').screenshot({ path: resolve(screenshotDir, 'stage-04a-java-inventory-desktop.png') })
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
  await page.goto('/servers')
  await expect(page.getByText('Temporary Smoke Server')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import existing' })).toHaveCount(0)
  await expect(page.getByText(join(process.env['MMSMANAGER_DATA_DIR']!, 'servers', 'e2e-import'), { exact: true })).toHaveCount(0)
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
