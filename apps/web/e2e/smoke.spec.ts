import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { ServerAutomation, ServerRestartScheduleUpdate } from '@mmsmanager/shared'
import { isLocalizedText } from '../src/i18n/catalog'

const screenshotDir = resolve(process.env['MMSMANAGER_E2E_SCREENSHOT_DIR'] ?? resolve(process.cwd(), '../../reports/screenshots'))
function screenshotPath(name: string): string { return resolve(screenshotDir, `stage-06h-${name}`) }
mkdirSync(screenshotDir, { recursive: true })
const captureReadme = process.env['MMSMANAGER_CAPTURE_README'] === '1'
const captureReadmeAbout = process.env['MMSMANAGER_CAPTURE_README_ABOUT'] === '1'
const captureReadmeMobile = process.env['MMSMANAGER_CAPTURE_README_MOBILE'] === '1'
const captureReadmeLoaders = process.env['MMSMANAGER_CAPTURE_README_LOADERS'] === '1'

let adminPassword = process.env['MMSMANAGER_E2E_ADMIN_PASSWORD']!
const memberPassword = process.env['MMSMANAGER_E2E_MEMBER_PASSWORD']!
const browserSessionPath = resolve(process.env['MMSMANAGER_DATA_DIR']!, 'browser-session.json')
const adminPasswordPath = resolve(process.env['MMSMANAGER_DATA_DIR']!, 'admin-password.txt')
const changedPasswords = new Map<string, string>()

test.use({
  storageState: async ({ browser: _browser }, use) => {
    void _browser
    await use(existsSync(browserSessionPath) ? browserSessionPath : undefined)
  },
})
async function signIn(page: Page, username = 'stage-admin', password = adminPassword): Promise<void> {
  await page.goto('/login')
  const authHeading = page.getByRole('heading', { name: /^(Dashboard|Обзор|Sign in to MMSManager)$/ })
  await expect(authHeading).toBeVisible()
  if (await page.getByRole('heading', { name: 'Sign in to MMSManager' }).isVisible()) {
    await page.getByLabel('Username').fill(username)
    const savedAdminPassword = username === 'stage-admin' && existsSync(adminPasswordPath) ? readFileSync(adminPasswordPath, 'utf8') : password
    await page.locator('input[name="password"]').fill(changedPasswords.get(username) ?? savedAdminPassword)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.locator('.profile-trigger').or(page.locator('#required-password-title'))).toBeVisible()
    if (await page.locator('#required-password-title').isVisible()) {
      const nextPassword = `MMSManager ${username} private update 2026!`
      await page.locator('input[name="currentPassword"]').fill(changedPasswords.get(username) ?? password)
      await page.locator('input[name="newPassword"]').fill(nextPassword)
      await page.locator('input[name="confirmPassword"]').fill(nextPassword)
      await page.getByRole('button', { name: 'Change password' }).click()
      changedPasswords.set(username, nextPassword)
    }
    await expect(page.locator('.profile-trigger')).toBeVisible()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /^(Dashboard|Обзор)$/ })).toBeVisible()
    if (username === 'stage-admin') await page.context().storageState({ path: browserSessionPath })
  }
}

async function signOut(page: Page): Promise<void> {
  await page.locator('.profile-trigger').click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
}

async function restoreEnglishPreferences(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const csrfCookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('mmsmanager_csrf='))
    const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.slice('mmsmanager_csrf='.length)) : ''
    const response = await fetch('/api/v1/profile/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mms-csrf': csrfToken }, body: JSON.stringify({ language: 'en' }) })
    return response.status
  })
  expect(status).toBe(200)
  await page.goto('/settings')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
}

test.afterEach(async ({ page }) => {
  const shouldRestore = await page.evaluate(() => document.documentElement.lang === 'ru' && Boolean(document.querySelector('.profile-trigger'))).catch(() => false)
  if (shouldRestore) await restoreEnglishPreferences(page)
})

async function expectNoHorizontalOverflow(page: Page, route: string): Promise<void> {
  const size = await page.evaluate(() => {
    const viewport = window.innerWidth
    const offenders = [...document.querySelectorAll<HTMLElement>('body *')]
      .map((element) => {
        const bounds = element.getBoundingClientRect()
        const chain: string[] = []
        let scrollContainer = ''
        let parent: HTMLElement | null = element
        while (parent && chain.length < 4) {
          chain.push(`${parent.tagName.toLowerCase()}.${String(parent.className).split(/\s+/).filter(Boolean).join('.')}`)
          const overflowX = getComputedStyle(parent).overflowX
          if (!scrollContainer && ['auto', 'scroll', 'hidden', 'clip'].includes(overflowX)) scrollContainer = `${parent.tagName.toLowerCase()}.${String(parent.className).split(/\s+/).filter(Boolean).join('.')}`
          parent = parent.parentElement
        }
        return { element: chain.join(' < '), scrollContainer, right: Math.round(bounds.right), left: Math.round(bounds.left), width: Math.round(bounds.width), text: element.textContent?.trim().slice(0, 60) ?? '', position: getComputedStyle(element).position }
      })
      .filter((item) => item.right > viewport + 1 && !item.scrollContainer)
      .sort((left, right) => right.right - left.right)
      .slice(0, 5)
    return { viewport, content: document.documentElement.scrollWidth, scrollX: window.scrollX, offenders }
  })
  expect(size.content, `horizontal overflow on ${route}: ${JSON.stringify(size.offenders)}`).toBeLessThanOrEqual(size.viewport)
}

async function expectAccessBadgeFits(page: Page, route: string): Promise<void> {
  const geometry = await page.locator('.local-access-heading > .badge').evaluate((badge) => {
    const card = badge.closest<HTMLElement>('.local-access-card')!
    const bounds = card.getBoundingClientRect()
    const paddingRight = Number.parseFloat(getComputedStyle(card).paddingRight)
    return { badgeRight: badge.getBoundingClientRect().right, contentRight: bounds.right - paddingRight }
  })
  expect(geometry.badgeRight, `Administrator badge clipped on ${route}: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.contentRight + 1)
}

async function findUnaccentedGreenUi(page: Page): Promise<string[]> {
  return page.locator('.app-frame').evaluate((frame) => {
    const intentionalColorAreas = '.world-blocks, .world-scene, .template-visual, .metric-delta, .timeline-change'
    const properties = ['color', 'backgroundColor', 'borderColor', 'accentColor', 'fill', 'stroke', 'backgroundImage'] as const
    const findings: string[] = []
    const colorPattern = /rgba?\([^)]*\)|#[\da-f]{3,8}\b/gi
    for (const element of frame.querySelectorAll<HTMLElement>('*')) {
      if (!element.getClientRects().length || element.closest(intentionalColorAreas)) continue
      const style = getComputedStyle(element)
      if (style.visibility === 'hidden') continue
      const label = `${element.tagName.toLowerCase()}.${String(element.className ?? '').trim().replace(/\s+/g, '.')}`
      for (const property of properties) {
        for (const color of style[property].match(colorPattern) ?? []) {
          const channels = color.startsWith('#')
            ? color.slice(1).match(/[\da-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16)) ?? []
            : color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
          if (channels.length < 3) continue
          const [red, green, blue] = channels.map((channel) => channel / 255)
          const maximum = Math.max(red!, green!, blue!)
          const minimum = Math.min(red!, green!, blue!)
          const delta = maximum - minimum
          const saturation = maximum === 0 ? 0 : delta / maximum
          if (saturation < .18 || maximum < .12) continue
          let hue = 0
          if (delta > 0) {
            if (maximum === red) hue = 60 * (((green! - blue!) / delta) % 6)
            else if (maximum === green) hue = 60 * ((blue! - red!) / delta + 2)
            else hue = 60 * ((red! - green!) / delta + 4)
          }
          if (hue < 0) hue += 360
          if (hue >= 65 && hue <= 165) findings.push(`${label} ${property}=${color}`)
        }
      }
    }
    return findings.slice(0, 12)
  })
}

async function mockLocalServer(page: Page, runtimeStatus = 'running') {
  const serverId = 'e03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const backupId = 'c03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const now = new Date().toISOString()
  const server = { id: serverId, name: 'Local Fixture', source: 'created', software: 'paper', version: '1.21.4', jarName: 'server.jar', javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096, port: 25565, portStatus: 'valid' as const, portErrorCode: null, eula: 'accepted', managed: true, worldFolders: ['world'], createdAt: now, runtimeStatus }
  let settings = { onlineMode: true, motd: 'A local fixture', gameMode: 'survival', difficulty: 'normal', maxPlayers: 20, viewDistance: 10, simulationDistance: 8, spawnProtection: 16, pvp: true, whiteList: false, allowNether: true }
  let advancedProperties: Record<string, string> = { 'server-port': '25565', 'allow-flight': 'false' }
  let propertyHash = 'c'.repeat(64)
  let restartRequired = false
  let runtimeSettings = {
    serverId, javaPath: '/tmp/mmsmanager-e2e-java-21', javaMajor: 21, requiredJavaMajor: 21,
    javaSelectionMode: 'auto' as const, javaSelectionReason: 'automatic-exact-minimum' as const, javaCompatibilityOverrideConfirmed: false,
    minMemoryMb: 1024, maxMemoryMb: 4096,
    jvmOptions: { collector: 'default' as const, maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false },
    compatibility: 'meets-minimum' as const, runtimeStatus, restartRequired: false, startScript: 'synchronized' as const,
  }
  const missedJobId = 'd03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const consoleSessionIds = ['a03c1cf8-e2a1-4a4e-9de4-4536c7796091', 'b13c1cf8-e2a1-4a4e-9de4-4536c7796091']
  let currentConsoleSessionId = consoleSessionIds[0]!
  const consoleSessionRows: Array<{ id: string; startedAt: string; endedAt: string | null; outcome: 'running' | 'stopped'; entryCount: number; oldestEntryId: number | null; latestEntryId: number | null; live: boolean }> = []
  const consoleEntrySession = new Map<number, string>()
  let automation: ServerAutomation = {
    serverId, enabled: false, frequency: 'daily' as const, localTime: '03:00', weekday: null,
    timeZone: 'Europe/Paris', nextRunAt: null, lastRunAt: now, lastStatus: 'missed' as const,
    lastError: 'The API was unavailable past the catch-up window. No backup was run.', unacknowledgedCount: 1,
    jobs: [{ id: missedJobId, kind: 'backup' as const, scheduledFor: now, status: 'missed' as const, startedAt: null, finishedAt: now, backupId: null, errorMessage: 'The API was unavailable past the catch-up window. No backup was run.', acknowledgedAt: null, createdAt: now }],
    restartSchedule: { enabled: false, frequency: 'daily', localTime: '03:00', weekday: null, timeZone: 'Europe/Paris', onlyWhenEmpty: true, waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30, nextRunAt: null, lastRunAt: null, lastStatus: null, lastOutcome: null },
    restartJobs: [],
  }
  const properties = () => ({
    settings, advancedProperties, sha256: propertyHash, serverVersion: server.version, serverSoftware: server.software,
    configuredPort: server.port, portStatus: server.portStatus, portErrorCode: server.portErrorCode,
    presentKeys: ['online-mode', 'motd', 'gamemode', 'difficulty', 'max-players', 'view-distance', 'simulation-distance', 'spawn-protection', 'pvp', 'white-list', 'allow-nether', ...Object.keys(advancedProperties), 'server-ip'],
    unknownKeys: ['custom.fixture-key'], protectedProperties: [{ key: 'server-ip', reason: 'The panel keeps server binding settings separate from the local web interface.', configured: true }],
    unsupportedKeys: [], backups: restartRequired ? [{ id: backupId, createdAt: now, sha256: 'a'.repeat(64) }] : [], restartRequired,
  })
  const consoleResponse = { entries: [
    { id: 1, occurredAt: now, source: 'system', severity: 'info', message: 'MMSManager launched this local process.' },
    { id: 2, occurredAt: now, source: 'stdout', severity: 'info', message: 'Done (1.2s)! For help, type "help"' },
  ], nextAfter: null }
  for (let id = 3; id <= 42; id += 1) consoleResponse.entries.push({ id, occurredAt: now, source: id % 9 === 0 ? 'stderr' : 'stdout', severity: id % 9 === 0 ? 'warn' : 'info', message: `Fixture process output line ${id}` })
  consoleResponse.entries.forEach((entry) => consoleEntrySession.set(entry.id, currentConsoleSessionId))
  consoleSessionRows.push({ id: currentConsoleSessionId, startedAt: now, endedAt: runtimeStatus === 'running' ? null : now, outcome: runtimeStatus === 'running' ? 'running' : 'stopped', entryCount: consoleResponse.entries.length, oldestEntryId: 1, latestEntryId: 42, live: runtimeStatus === 'running' })
  await page.route('**/api/v1/servers', (route) => route.fulfill({ json: { servers: [server] } }))
  const allAccess = { viewServer: true, viewLogs: true, sendConsoleCommands: false, controlLifecycle: false, startServer: true, stopServer: true, restartServer: true, viewPlayers: true, moderatePlayers: true, viewMods: true, manageMods: true, viewFiles: true, manageFiles: true, viewSettings: true, manageSettings: true, viewWorlds: true, viewBackups: true, createBackups: true }
  await page.route(`**/api/v1/servers/${serverId}/access`, (route) => route.fulfill({ json: { administrator: true, permissions: allAccess } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/access`, (route) => route.fulfill({ json: { users: [] } }))
  await page.route('**/api/v1/admin/servers', (route) => route.fulfill({ json: { servers: [{ ...server, directory: '/tmp/mmsmanager-e2e/local-fixture', javaPath: '/tmp/fake-java' }], managedRoot: '/tmp/mmsmanager-e2e/servers', importRoots: ['/tmp/mmsmanager-e2e/servers'] } }))
  await page.route('**/api/v1/admin/java', (route) => route.fulfill({ json: { runtimes: [
    { path: '/tmp/mmsmanager-e2e-java-21', version: '21.0.4', major: 21, vendor: 'Temurin', source: 'discovered' },
    { path: '/tmp/mmsmanager-e2e-java-8', version: '1.8.0_402', major: 8, vendor: 'Temurin', source: 'discovered' },
  ] } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/runtime-settings`, async (route) => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON() as Partial<typeof runtimeSettings> & { confirmCompatibilityOverride?: boolean }
      const { confirmCompatibilityOverride, ...savedInput } = input
      runtimeSettings = { ...runtimeSettings, ...savedInput, javaSelectionReason: savedInput.javaSelectionMode === 'auto' ? 'automatic-exact-minimum' : 'manual-selection', javaCompatibilityOverrideConfirmed: Boolean(confirmCompatibilityOverride), compatibility: savedInput.javaPath?.includes('java-8') ? 'below-minimum' : 'meets-minimum', restartRequired: runtimeStatus === 'running' }
      restartRequired = runtimeSettings.restartRequired
    }
    return route.fulfill({ json: { settings: { ...runtimeSettings, runtimeStatus } } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/automation`, async (route) => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON() as Pick<typeof automation, 'enabled' | 'frequency' | 'localTime' | 'weekday'>
      automation = { ...automation, ...input, nextRunAt: input.enabled ? new Date(Date.now() + 86_400_000).toISOString() : null }
    }
    return route.fulfill({ json: { automation } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/automation/restart-schedule`, async (route) => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON() as ServerRestartScheduleUpdate
      automation = { ...automation, restartSchedule: {
        ...automation.restartSchedule, ...input, timeZone: 'Europe/Paris',
        nextRunAt: input.enabled ? new Date(Date.now() + 86_400_000).toISOString() : null,
      } }
    }
    return route.fulfill({ json: { automation } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/automation/jobs/${missedJobId}/acknowledge`, (route) => {
    automation = { ...automation, unacknowledgedCount: 0, jobs: automation.jobs.map((job) => job.id === missedJobId ? { ...job, acknowledgedAt: now } : job) }
    return route.fulfill({ json: { automation } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/restart`, (route) => {
    const previousSession = consoleSessionRows.find((session) => session.id === currentConsoleSessionId)
    if (previousSession) { previousSession.endedAt = now; previousSession.outcome = 'stopped'; previousSession.live = false }
    currentConsoleSessionId = consoleSessionIds[1]!
    consoleSessionRows.unshift({ id: currentConsoleSessionId, startedAt: now, endedAt: null, outcome: 'running', entryCount: 1, oldestEntryId: 43, latestEntryId: 43, live: true })
    consoleResponse.entries.push({ id: 43, occurredAt: now, source: 'system', severity: 'info', message: 'A new panel-owned process session started.' })
    consoleEntrySession.set(43, currentConsoleSessionId)
    runtimeStatus = 'running'
    runtimeSettings = { ...runtimeSettings, runtimeStatus, restartRequired: false }
    restartRequired = false
    return route.fulfill({ json: { runtime: { serverId, status: runtimeStatus, startedAt: now, uptimeSeconds: 0, memoryRssBytes: null, cpuPercent: null, ready: true, playersOnline: null, eula: 'accepted', configuredPort: server.port, processPort: server.port, portStatus: server.portStatus, portErrorCode: server.portErrorCode, restartRequired: false, lastExitCode: 0, errorMessage: null } } })
  })
  await page.route(`**/api/v1/servers/${serverId}/runtime`, (route) => route.fulfill({ json: { runtime: { serverId, status: runtimeStatus, startedAt: runtimeStatus === 'running' ? now : null, uptimeSeconds: runtimeStatus === 'running' ? 153 : null, memoryRssBytes: null, cpuPercent: null, ready: runtimeStatus === 'running', playersOnline: null, eula: 'accepted', configuredPort: server.port, processPort: runtimeStatus === 'running' ? server.port : null, portStatus: server.portStatus, portErrorCode: server.portErrorCode, restartRequired, lastExitCode: null, errorMessage: null } } }))
  await page.route(`**/api/v1/servers/${serverId}/status`, (route) => route.fulfill({ json: { status: { serverId, checkedAt: now, source: 'local-status-ping', state: 'reachable', configuredPort: server.port, processPort: runtimeStatus === 'running' ? server.port : null, portStatus: server.portStatus, portErrorCode: server.portErrorCode, restartRequired, playersOnline: 3, playersMax: 20, versionName: 'Paper 1.21.4', description: 'Local fixture', latencyMs: 4, errorCode: null, authoritativePlayerList: false } } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/players`, (route) => route.fulfill({ json: { players: { serverId, state: 'authoritative', source: 'owned-console-list', sampledAt: now, names: ['FixturePlayer'], reason: null } } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/worlds`, (route) => route.fulfill({ json: { worlds: {
    serverId, status: 'available', levelName: 'maple-valley', levelNameSource: 'server.properties', reason: null,
    entries: [
      { name: 'maple-valley', path: 'maple-valley', dimension: 'overworld', state: 'available', sizeBytes: 7340032, sizeComplete: true, modifiedAt: now, backupAvailable: false, reason: null },
      { name: 'maple-valley_nether', path: 'maple-valley_nether', dimension: 'nether', state: 'missing', sizeBytes: null, sizeComplete: false, modifiedAt: null, backupAvailable: false, reason: 'No directory exists at the configured server-relative world path.' },
    ],
  } } }))
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
  await page.route(`**/api/v1/servers/${serverId}/console/sessions`, (route) => {
    const sessions = consoleSessionRows.map((session) => ({ ...session, live: session.id === currentConsoleSessionId && runtimeStatus === 'running', endedAt: session.id === currentConsoleSessionId && runtimeStatus === 'running' ? null : session.endedAt ?? now }))
    return route.fulfill({ json: { sessions } })
  })
  await page.route(`**/api/v1/servers/${serverId}/console?*`, (route) => {
    const url = new URL(route.request().url())
    const sessionId = url.searchParams.get('sessionId') ?? currentConsoleSessionId
    const after = Number(url.searchParams.get('after') ?? 0)
    const before = Number(url.searchParams.get('before') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? 200)
    if (after > 0 && runtimeStatus === 'running' && sessionId === currentConsoleSessionId) {
      const id = (consoleResponse.entries.at(-1)?.id ?? 0) + 1
      consoleResponse.entries.push({ id, occurredAt: new Date().toISOString(), source: 'stdout', severity: 'info', message: `Live fixture output ${id}` })
      consoleEntrySession.set(id, sessionId)
      const session = consoleSessionRows.find((item) => item.id === sessionId)
      if (session) { session.entryCount += 1; session.latestEntryId = id }
    }
    const all = consoleResponse.entries.filter((entry) => consoleEntrySession.get(entry.id) === sessionId && (!before || entry.id < before) && (!after || entry.id > after))
    const descending = before > 0 || after === 0
    const ordered = descending ? [...all].sort((a, b) => b.id - a.id).slice(0, limit + 1) : [...all].sort((a, b) => a.id - b.id).slice(0, limit + 1)
    const more = ordered.length > limit
    const selected = ordered.slice(0, limit)
    if (descending) selected.reverse()
    return route.fulfill({ json: { sessionId, entries: selected, nextAfter: before === 0 && after > 0 && more ? selected.at(-1)?.id ?? null : null, olderThan: descending && more ? selected[0]?.id ?? null : null } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/properties`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON() as Partial<typeof settings> & { advancedProperties?: Record<string, string> }
      settings = { ...settings, ...Object.fromEntries(Object.entries(input).filter(([key]) => key in settings)) }
      advancedProperties = { ...advancedProperties, ...(input.advancedProperties ?? {}) }
      propertyHash = 'd'.repeat(64)
      restartRequired = true
    }
    return route.fulfill({ json: { properties: properties() } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/properties/backups/${backupId}/preview`, (route) => route.fulfill({ json: { preview: {
    backupId, createdAt: now, checksumValid: true, backupSha256: 'a'.repeat(64), currentSha256: 'c'.repeat(64), running: true, restartRequiredAfterRestore: true, otherContentDiffers: false,
    changedSettings: [{ key: 'motd', current: settings.motd, restored: 'A previous fixture message' }],
  } } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/properties/backups/${backupId}/restore`, async (route) => {
    settings = { ...settings, motd: 'A previous fixture message' }
    propertyHash = 'e'.repeat(64)
    restartRequired = true
    return route.fulfill({ json: { properties: properties(), recoveryBackupId: 'd03c1cf8-e2a1-4a4e-9de4-4536c7796091' } })
  })

  const serverBackupId = 'b03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const safetyBackupId = 'a03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const backupRecord = (id: string, kind: 'manual' | 'pre-restore') => ({ id, serverId, kind, origin: kind === 'pre-restore' ? 'system' : 'manual', createdAt: now, archiveSizeBytes: 512, archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), entryCount: 3, fileCount: 2, totalFileBytes: 200, excludedCount: 0 })
  let backupItems = [backupRecord(serverBackupId, 'manual')]
  await page.route(`**/api/v1/admin/servers/${serverId}/backups**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path.endsWith('/preview')) return route.fulfill({ json: { preview: {
      backup: backupItems.find((item) => item.id === path.split('/').at(-2)) ?? backupRecord(serverBackupId, 'manual'),
      integrityValid: true, serverStopped: runtimeStatus === 'stopped', canRestore: runtimeStatus === 'stopped', confirmationText: 'RESTORE Local Fixture', issue: null,
      entries: [{ path: 'server.properties', kind: 'file', sizeBytes: 64, sha256: 'c'.repeat(64) }, { path: 'world', kind: 'directory', sizeBytes: 0, sha256: null }, { path: 'world/level.dat', kind: 'file', sizeBytes: 136, sha256: 'd'.repeat(64) }],
      entriesTruncated: false, excludedPaths: [], excludedPathsTruncated: false,
    } } })
    if (path.endsWith('/download')) return route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${serverBackupId}.mmsbackup"` }, body: Buffer.from('MMSBACK1 fixture archive') })
    if (path.endsWith('/restore')) {
      const input = request.postDataJSON() as { confirmation: string }
      if (input.confirmation !== 'RESTORE Local Fixture') return route.fulfill({ status: 409, json: { error: { code: 'RESTORE_CONFIRMATION_FAILED', message: 'Type RESTORE Local Fixture exactly to confirm replacement.' } } })
      backupItems = [backupItems[0]!, backupRecord(safetyBackupId, 'pre-restore')]
      return route.fulfill({ json: { ok: true, restoreId: '903c1cf8-e2a1-4a4e-9de4-4536c7796091', backupId: serverBackupId, safetyBackupId, restoredFileCount: 2, restoredDirectoryCount: 1, restoredBytes: 200, completedAt: now, rollbackCleanupPending: false } })
    }
    if (request.method() === 'POST') return route.fulfill({ status: 201, json: { backup: backupRecord(serverBackupId, 'manual') } })
    return route.fulfill({ json: { serverId, items: backupItems, truncated: false, storageUsedBytes: backupItems.length * 512, storageLimitBytes: 107374182400, storageAvailableBytes: 500 * 1024 ** 3, quotaWarning: false, runtimeStatus } })
  })

  const filePath = 'config/server-note.txt'
  let fileText = 'Fixture notes from the managed server.\n'
  let fileHash = 'b'.repeat(64)
  let fileRecoveryText = 'Earlier fixture notes.\n'
  let filePresent = true
  let fileParent = 'config'
  let fileName = 'server-note.txt'
  let folderCreated = false
  let fileRecoveries: Array<{ id: string; path: string; sizeBytes: number; sha256: string; createdAt: string }> = []
  let fileTrash: Array<{ id: string; name: string; originalPath: string; kind: 'file' | 'folder'; sizeBytes: number | null; deletedAt: string }> = []
  const uploadedPaths = new Set<string>()
  const uploadRequests: Array<{ path: string; body: string }> = []
  const renameRequests: Array<{ path: string; newName: string }> = []
  const moveRequests: Array<{ sourcePath: string; destinationDirectory: string }> = []
  const safeFileEntry = (name: string, path: string) => ({ name, path, kind: 'file' as const, sizeBytes: fileText.length, modifiedAt: now, contentState: 'editable' as const, reason: null, canDownload: true, canEdit: true, canRename: true, canTrash: true })
  const fileInventory = (path: string) => ({
    serverId, path, breadcrumbs: path.split('/').filter(Boolean).map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join('/') })),
    entries: path === '' ? [
      { name: 'config', path: 'config', kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'read-only', reason: null, canDownload: false, canEdit: false, canRename: true, canTrash: true },
      { name: 'server.properties', path: 'server.properties', kind: 'file', sizeBytes: 180, modifiedAt: now, contentState: 'protected', reason: 'Use the typed Properties editor for this configuration file.', canDownload: false, canEdit: false, canRename: false, canTrash: false },
      { name: 'versions', path: 'versions', kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'protected', reason: 'Minecraft runtime files and loader metadata are protected from generic file operations.', canDownload: false, canEdit: false, canRename: false, canTrash: false },
      { name: 'libraries', path: 'libraries', kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'protected', reason: 'Minecraft runtime files and loader metadata are protected from generic file operations.', canDownload: false, canEdit: false, canRename: false, canTrash: false },
      { name: '.fabric', path: '.fabric', kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'protected', reason: 'Minecraft runtime files and loader metadata are protected from generic file operations.', canDownload: false, canEdit: false, canRename: false, canTrash: false },
      { name: 'user_jvm_args.txt', path: 'user_jvm_args.txt', kind: 'file', sizeBytes: 12, modifiedAt: now, contentState: 'protected', reason: 'Minecraft runtime files and loader metadata are protected from generic file operations.', canDownload: false, canEdit: false, canRename: false, canTrash: false },
      ...(fileParent === '' && filePresent ? [safeFileEntry(fileName, fileName)] : []),
      ...Array.from(uploadedPaths).filter((entry) => !entry.includes('/')).map((entry) => ({ name: entry, path: entry, kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'read-only', reason: null, canDownload: false, canEdit: false, canRename: true, canTrash: true })),
    ] : [
      ...(filePresent && path === fileParent ? [safeFileEntry(fileName, `${fileParent ? `${fileParent}/` : ''}${fileName}`)] : []),
      ...(folderCreated ? [{ name: 'notes', path: 'config/notes', kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'read-only', reason: null, canDownload: false, canEdit: false, canRename: true, canTrash: true }] : []),
      ...Array.from(uploadedPaths).filter((entry) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/')).map((entry) => {
        const name = entry.slice(path.length + 1)
        return uploadedPaths.has(`${entry}/`) || Array.from(uploadedPaths).some((other) => other.startsWith(`${entry}/`))
          ? { name, path: entry, kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'read-only', reason: null, canDownload: false, canEdit: false, canRename: true, canTrash: true }
          : safeFileEntry(name, entry)
      }),
    ],
    truncated: false, trashCount: fileTrash.length,
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/files**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()
    if (method === 'GET' && pathname.endsWith('/files/read')) return route.fulfill({ json: { path: filePath, sizeBytes: fileText.length, modifiedAt: now, sha256: fileHash, text: fileText, contentState: 'editable', reason: null } })
    if (method === 'GET' && pathname.endsWith('/files/recoveries')) return route.fulfill({ json: { items: fileRecoveries } })
    if (method === 'GET' && pathname.endsWith('/files/trash')) return route.fulfill({ json: { items: fileTrash } })
    if (method === 'GET' && pathname.endsWith('/files/download')) return route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''server-note.txt` }, body: Buffer.from(fileText) })
    if (method === 'GET') return route.fulfill({ json: fileInventory(url.searchParams.get('path') ?? '') })
    if (method === 'PUT') {
      fileRecoveryText = fileText
      fileRecoveries = [{ id: 'f03c1cf8-e2a1-4a4e-9de4-4536c7796091', path: filePath, sizeBytes: fileText.length, sha256: fileHash, createdAt: now }, ...fileRecoveries]
      fileText = (request.postDataJSON() as { text: string }).text
      fileHash = 'd'.repeat(64)
      return route.fulfill({ json: { path: filePath, sizeBytes: fileText.length, modifiedAt: now, sha256: fileHash, text: fileText, contentState: 'editable', reason: null } })
    }
    if (method === 'POST' && pathname.endsWith('/files/recoveries/f03c1cf8-e2a1-4a4e-9de4-4536c7796091/restore')) {
      const previous = fileText
      fileText = fileRecoveryText
      fileRecoveryText = previous
      fileHash = 'e'.repeat(64)
      return route.fulfill({ json: { path: filePath, sizeBytes: fileText.length, modifiedAt: now, sha256: fileHash, text: fileText, contentState: 'editable', reason: null } })
    }
    if (method === 'POST' && pathname.endsWith('/files/trash/f03c1cf8-e2a1-4a4e-9de4-4536c7796091/restore')) {
      fileTrash = []
      filePresent = true
      return route.fulfill({ json: fileInventory('config') })
    }
    if (method === 'POST' && pathname.endsWith('/files/create')) {
      const input = request.postDataJSON() as { path: string; kind: 'file' | 'folder' }
      if (input.path.endsWith('/notes') && input.kind === 'folder') folderCreated = true
      return route.fulfill({ status: 201, json: fileInventory(input.path.includes('/') ? input.path.split('/').slice(0, -1).join('/') : '') })
    }
    if (method === 'POST' && pathname.endsWith('/files/rename')) {
      const input = request.postDataJSON() as { path: string; newName: string }
      renameRequests.push(input)
      fileName = input.newName
      return route.fulfill({ json: fileInventory(fileParent) })
    }
    if (method === 'POST' && pathname.endsWith('/files/move')) {
      const input = request.postDataJSON() as { sourcePath: string; destinationDirectory: string }
      moveRequests.push(input)
      fileParent = input.destinationDirectory
      return route.fulfill({ json: fileInventory(input.sourcePath.split('/').slice(0, -1).join('/')) })
    }
    if (method === 'POST' && pathname.endsWith('/files/upload-batch')) {
      const body = request.postDataBuffer()?.toString('utf8') ?? ''
      uploadRequests.push({ path: url.searchParams.get('path') ?? '', body })
      const marker = body.indexOf('name="manifest"')
      const valueStart = body.indexOf('\r\n\r\n', marker) + 4
      const valueEnd = body.indexOf('\r\n', valueStart)
      const manifest = JSON.parse(body.slice(valueStart, valueEnd)) as { files: string[]; directories: string[] }
      const base = url.searchParams.get('path') ?? ''
      for (const directory of manifest.directories) uploadedPaths.add([base, directory].filter(Boolean).join('/'))
      for (const relativeFile of manifest.files) {
        const parts = relativeFile.split('/')
        for (let index = 1; index < parts.length; index += 1) uploadedPaths.add([base, ...parts.slice(0, index)].filter(Boolean).join('/'))
        uploadedPaths.add([base, relativeFile].filter(Boolean).join('/'))
      }
      return route.fulfill({ status: 201, json: fileInventory(base) })
    }
    if (method === 'POST' && pathname.endsWith('/files/upload')) return route.fulfill({ status: 201, json: fileInventory(url.searchParams.get('path') ?? '') })
    if (method === 'DELETE') {
      const input = request.postDataJSON() as { path: string }
      filePresent = false
      fileTrash = [{ id: 'f03c1cf8-e2a1-4a4e-9de4-4536c7796091', name: 'server-note.txt', originalPath: input.path, kind: 'file', sizeBytes: fileText.length, deletedAt: now }]
      return route.fulfill({ json: { item: fileTrash[0], inventory: fileInventory('config') } })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Unmapped file fixture.' } } })
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
  return { serverId, get submittedCommand() { return submittedCommand }, get submittedPlayerAction() { return submittedPlayerAction }, get uploadRequests() { return uploadRequests }, get renameRequests() { return renameRequests }, get moveRequests() { return moveRequests } }
}

test('first-run administrator setup creates the protected local workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole('heading', { name: 'Create your administrator' })).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-03-setup-desktop.png'), fullPage: true })

  const token = readFileSync(resolve(process.env['MMSMANAGER_DATA_DIR']!, 'bootstrap-token'), 'utf8').trim()
  await page.getByLabel('One-time setup key').fill(token)
  await page.getByLabel('Username').fill('stage-admin')
  await page.getByLabel('Display name').fill('Stage Administrator')
  await page.locator('input[name="password"]').fill(adminPassword)
  await page.getByLabel('Confirm password').fill(adminPassword)
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('Local server registry connected')).toHaveCount(0)
  await expect(page.getByText('No servers registered on this computer.')).toBeVisible()
  await page.context().storageState({ path: browserSessionPath })
  await page.screenshot({ path: screenshotPath('stage-03-dashboard-desktop.png'), fullPage: true })
  await page.screenshot({ path: screenshotPath('stage-05a-dashboard-empty-desktop.png'), fullPage: true })
  expect(page.url()).not.toContain('/setup')
})

test('About presents release identity to administrators and members', async ({ page }) => {
  let mockRole: 'administrator' | 'member' = 'administrator'
  await page.route('**/api/v1/machine/current', (route) => route.fulfill({ json: {
    status: 'collecting', timeZone: 'Etc/UTC', host: null, sample: null,
    lastSuccessfulAt: null, intervalMs: 1000, provenance: 'LOCAL_HOST',
  } }))
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const meUrl = new URL('/api/v1/auth/me', page.url()).toString()
  const meResponse = await page.request.get(meUrl)
  expect(meResponse.ok()).toBeTruthy()
  const demoSnapshot = await meResponse.json() as {
    user: { displayName: string; username: string; role: 'administrator' | 'member'; preferences: { language: 'en' | 'ru' } }
    workspace: { displayName: string }
  }
  demoSnapshot.user.displayName = 'Demo Administrator'
  demoSnapshot.user.username = 'demo-admin'
  demoSnapshot.workspace.displayName = 'MMSManager Demo'
  await page.route('**/api/v1/auth/me', (route) => {
    const body = structuredClone(demoSnapshot)
    body.user.role = mockRole
    if (mockRole === 'member') body.user.preferences.language = 'ru'
    return route.fulfill({ json: body })
  })
  await page.reload()
  await page.goto('/settings')
  await page.getByRole('button', { name: 'About', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MMSManager', level: 3 })).toBeVisible()
  await expect(page.getByText('0.1.0-alpha.2', { exact: true })).toBeVisible()
  await expect(page.getByText('GNU General Public License v3.0 only', { exact: true })).toBeVisible()
  await expect(page.getByText('GPL-3.0-only', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'GitHub author' })).toHaveAttribute('href', 'https://github.com/sqwiziiy')
  await expect(page.getByRole('link', { name: 'Project repository' })).toHaveAttribute('href', 'https://github.com/sqwiziiy/MMSManager')
  expect(await page.title()).toBe('MMSManager')
  const favicon = await page.evaluate(async () => {
    const response = await fetch('/favicon.svg')
    return { status: response.status, type: response.headers.get('content-type'), source: await response.text() }
  })
  expect(favicon.status).toBe(200)
  expect(favicon.type).toContain('image/svg+xml')
  expect(favicon.source).toContain('<svg')

  if (captureReadme || captureReadmeAbout) {
    const directory = resolve(process.cwd(), '../../assets/readme')
    mkdirSync(directory, { recursive: true })
    await page.screenshot({ path: resolve(directory, 'about-desktop.png'), fullPage: true })
  }
  if (captureReadme) {
    const directory = resolve(process.cwd(), '../../assets/readme')
    await page.goto('/servers')
    await expect(page.getByRole('heading', { name: 'Servers', exact: true })).toBeVisible()
    await expect(page.getByText('No local servers registered', { exact: true })).toBeVisible()
    await page.screenshot({ path: resolve(directory, 'servers-desktop.png'), fullPage: true })
    await page.goto('/settings')
    await page.getByRole('button', { name: 'About', exact: true }).click()
  }

  await page.getByRole('button', { name: 'Language & appearance', exact: true }).click()
  await page.getByLabel('Language').selectOption('en')
  await page.getByRole('button', { name: 'About', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MMSManager', level: 3 })).toBeVisible()
  await expect(page.getByText('Version', { exact: true })).toBeVisible()
  await expect(page.getByText('Developer', { exact: true })).toBeVisible()
  await expect(page.getByText('GNU General Public License v3.0 only', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const closeNavigation = page.locator('.close-mobile')
  await expect(closeNavigation).toBeVisible()
  await closeNavigation.click()
  await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/)
  await expect(page.locator('.mobile-scrim')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.waitForTimeout(250)
  if (captureReadme || captureReadmeMobile) {
    const directory = resolve(process.cwd(), '../../assets/readme')
    await page.screenshot({ path: resolve(directory, 'about-mobile.png'), fullPage: true })
  }

  mockRole = 'member'
  await page.reload()
  await expect(page.getByRole('button', { name: 'О проекте', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'О проекте', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'MMSManager', level: 3 })).toBeVisible()
  await expect(page.getByText('Версия', { exact: true })).toBeVisible()
  await expect(page.getByText('0.1.0-alpha.2', { exact: true })).toBeVisible()
  await expect(page.getByText('Разработчик', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toHaveCount(0)
  mockRole = 'administrator'
})

test('backup settings show installed capacity and save configurable limits', async ({ page }) => {
  await signIn(page)
  const defaults = {
    maxArchiveBytes: 20 * 1024 ** 3,
    storageQuotaBytes: 100 * 1024 ** 3,
    maxEntries: 100_000,
    maxDurationMinutes: 30,
    storageUsedBytes: 2 * 1024 ** 3,
    storageAvailableBytes: 500 * 1024 ** 3,
  }
  let settings = { ...defaults }
  let saved: typeof defaults | null = null
  await page.route('**/api/v1/admin/backup-settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON() as Omit<typeof defaults, 'storageUsedBytes' | 'storageAvailableBytes'>
      saved = { ...settings, ...input }
      settings = saved
    }
    await route.fulfill({ json: settings })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/settings?section=backup')
  await expect(page.getByRole('button', { name: 'Backup', exact: true })).toBeVisible()
  await expect(page.getByLabel('Maximum archive size')).toHaveValue('20')
  await expect(page.getByLabel('Maximum files and folders')).toHaveValue('100000')
  await expect(page.getByText('2 GiB', { exact: true })).toBeVisible()
  await expect(page.getByText('500 GiB', { exact: true })).toBeVisible()
  await page.getByLabel('Maximum archive size').fill('24')
  await page.getByLabel('Maximum files and folders').fill('200000')
  await page.getByLabel('Maximum operation duration').fill('90')
  await page.locator('.backup-quota-control .account-switch').click()
  await expect(page.getByRole('checkbox', { name: 'Disable shared quota' })).toBeChecked()
  await page.getByRole('button', { name: 'Save backup limits' }).click()
  await expect.poll(() => saved).toMatchObject({
    maxArchiveBytes: 24 * 1024 ** 3,
    storageQuotaBytes: null,
    maxEntries: 200_000,
    maxDurationMinutes: 90,
  })
  await expect(page.getByText('Backup limits were saved.')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'backup settings mobile')
})

test('administrators can restore a retained unregistered server from the Servers page', async ({ page }) => {
  await signIn(page)
  const serverId = 'd4d927f2-bb4a-4f46-a2f5-665ac5ed4771'
  let restored = false
  await page.route('**/api/v1/admin/servers/unregistered', (route) => route.fulfill({ json: {
    servers: restored ? [] : [{ id: serverId, name: 'Retained Fixture', version: '1.21.4', removedAt: '2026-11-25T16:00:00.000Z', folderAvailable: true }],
  } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/restore-registration`, async (route) => {
    expect(route.request().method()).toBe('POST')
    restored = true
    await route.fulfill({ json: { ok: true, serverId } })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/servers')
  await expect(page.getByRole('heading', { name: 'Unregistered servers' })).toBeVisible()
  const retainedRow = page.locator('.unregistered-server-row')
  await expect(retainedRow.getByText('Retained Fixture')).toBeVisible()
  await expect(retainedRow.getByText('1.21.4')).toBeVisible()
  await expect(retainedRow.getByRole('button', { name: 'Restore' })).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'unregistered servers mobile')
  await retainedRow.getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('.unregistered-server-row')).toHaveCount(0)
  expect(restored).toBe(true)
})

test('Stage 5G removes demo records from operational pages', async ({ page }) => {
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
  await expect(page.getByText('Players online').locator('..')).toContainText('0')
  await expect(page.getByText('query unavailable')).toHaveCount(0)

  await page.getByRole('link', { name: 'Servers' }).click()
  await expect(page.getByRole('heading', { name: 'Servers', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /Alder SMP/ })).toHaveCount(0)
  await expect(page.getByText('No local servers registered', { exact: true })).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-05g-servers-empty-desktop.png'), fullPage: true })
  await page.goto('/servers/alder-smp/overview')
  await expect(page.getByRole('heading', { name: 'Server not found' })).toBeVisible()
  await expect(page.getByText('Alder SMP', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: screenshotPath('stage-05g-legacy-server-route-desktop.png'), fullPage: true })
  await page.goto('/activity')
  await expect(page.getByText('Administrator setup completed', { exact: true })).toBeVisible()
  await expect(page.getByText('MiraWoods', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: screenshotPath('stage-05g-activity-empty-desktop.png'), fullPage: true })
  await page.goto('/backups')
  await expect(page.getByText('No managed servers available', { exact: true })).toBeVisible()
  await expect(page.getByText('Alder SMP', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: screenshotPath('stage-05g-backups-empty-desktop.png'), fullPage: true })
  await page.goto('/templates')
  await expect(page.getByText('No templates saved', { exact: true })).toBeVisible()
  await expect(page.getByText('Survival community', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: screenshotPath('stage-05g-templates-empty-desktop.png'), fullPage: true })
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
    return route.fulfill({ json: { software: 'vanilla', versions: ['1.21.4'], loaders: [], experimentalLoaders: [], builds: [], installerVersion: null, requiredJavaMajor: url.searchParams.has('version') ? 21 : null } })
  })
  await page.route('**/api/v1/admin/server-installs', async (route) => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ status: 202, json: { operation: { id: operationId, name: 'Local community server', directoryName: 'community-server', software: 'vanilla', version: '1.21.4', loaderVersion: null, status: 'pending', progress: 1, phase: 'queued', installerLog: '', serverId: null, artifactUrl: null, artifactSize: null, artifactSha256: null, checksumType: null, error: null, partialDirectory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } })
    }
    return route.fulfill({ json: { operations: [] } })
  })
  await page.route(`**/api/v1/admin/server-installs/${operationId}`, (route) => {
    pollCount += 1
    const completed = pollCount > 1
    return route.fulfill({ json: { operation: { id: operationId, name: 'Local community server', directoryName: 'community-server', software: 'vanilla', version: '1.21.4', loaderVersion: null, status: completed ? 'completed' : 'downloading', progress: completed ? 100 : 48, phase: completed ? 'complete' : 'downloading', installerLog: '', serverId: completed ? serverId : null, artifactUrl: completed ? 'https://piston-data.mojang.com/server.jar' : null, artifactSize: completed ? 9 : null, artifactSha256: completed ? 'a'.repeat(64) : null, checksumType: completed ? 'sha256' : null, error: null, partialDirectory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } })
  })
  await page.getByRole('button', { name: 'Create server', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Create server' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByLabel('Minecraft release')).toBeEnabled()
  await expect(page.getByText('Mojang metadata requires Java 21 or newer')).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('New server · stopped after install')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-04b-install-review-desktop.png') })
  await page.getByRole('button', { name: 'Install server' }).click()
  await expect(page.getByText('Installation in progress')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-04b-install-progress-desktop.png') })
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
  await page.screenshot({ path: screenshotPath('stage-04b-install-mobile.png'), animations: 'disabled' })
  await mobileWizard.getByRole('button', { name: 'Continue' }).click()
  await expect(mobileWizard.getByLabel('Minecraft release')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'mobile install wizard software')
})

test('Forge and NeoForge choices show official builds and fit the mobile setup wizard', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page)
  await page.route('**/api/v1/admin/java', (route) => route.fulfill({ json: { runtimes: [{ path: '/tmp/mmsmanager-e2e-java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered' }] } }))
  await page.route('**/api/v1/admin/server-installs/catalog?*', (route) => {
    const query = new URL(route.request().url()).searchParams
    const software = query.get('software') ?? 'vanilla'
    const version = query.get('version')
    const versions = software === 'neoforge' ? ['1.21.1'] : software === 'forge' ? ['1.20.1'] : ['1.21.4']
    const loaders = software === 'forge' && version ? ['47.4.28'] : software === 'neoforge' && version ? ['21.1.268'] : []
    return route.fulfill({ json: { software, versions, loaders, experimentalLoaders: [], builds: [], installerVersion: null, requiredJavaMajor: version ? (version === '1.20.1' ? 17 : 21) : null } })
  })
  await page.getByRole('button', { name: 'Create server', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create server' })
  await dialog.getByLabel('New directory name').fill('forge-preview')
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByRole('heading', { name: 'Mod loaders' })).toBeVisible()
  await expect(dialog.locator('.software-option.unsupported[aria-disabled="true"]')).toHaveCount(3)
  await expect(dialog.getByRole('button', { name: /Forge Official Forge mod loader/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /NeoForge Community-led Forge successor/ })).toBeVisible()
  if (captureReadmeLoaders) {
    const directory = resolve(process.cwd(), '../../assets/readme')
    mkdirSync(directory, { recursive: true })
    await dialog.screenshot({ path: resolve(directory, 'server-software.png'), animations: 'disabled' })
  }
  await dialog.getByRole('button', { name: /Forge Official Forge mod loader/ }).click()
  await expect(dialog.getByLabel('Minecraft release')).toHaveValue('1.20.1')
  await expect(dialog.getByLabel('Forge version')).toHaveValue('47.4.28')
  await expect(dialog.locator('.software-option.selected img')).toBeVisible()
  await expect(dialog.getByText('The installer runs from its official provider in a private, resource-limited folder.', { exact: false })).toBeVisible()
  await page.screenshot({ path: screenshotPath('forge-loader-wizard-desktop.png'), fullPage: true, animations: 'disabled' })

  await dialog.getByRole('button', { name: /NeoForge Community-led Forge successor/ }).click()
  await expect(dialog.getByLabel('Minecraft release')).toHaveValue('1.21.1')
  await expect(dialog.getByLabel('NeoForge version')).toHaveValue('21.1.268')
  await page.setViewportSize({ width: 390, height: 844 })
  await dialog.getByLabel('NeoForge version').scrollIntoViewIfNeeded()
  await expect(dialog.getByLabel('NeoForge version')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await page.screenshot({ path: screenshotPath('forge-loader-wizard-mobile.png'), fullPage: true, animations: 'disabled' })
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
    return route.fulfill({ json: { software: 'vanilla', versions: ['1.21.4'], loaders: [], experimentalLoaders: [], builds: [], installerVersion: null, requiredJavaMajor: url.searchParams.has('version') ? 21 : null } })
  })
  await page.route('**/api/v1/admin/server-installs', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { operations: [] } })
    const input = route.request().postDataJSON() as Record<string, unknown>
    sent.push(input)
    const id = sent.length === 1 ? failedId : completedId
    return route.fulfill({ status: 202, json: { operation: { id, name: 'Retry Fixture', directoryName: input['directoryName'], software: 'vanilla', version: '1.21.4', loaderVersion: null, status: 'pending', progress: 1, phase: 'queued', installerLog: '', serverId: null, artifactUrl: null, artifactSize: null, artifactSha256: null, checksumType: null, error: null, partialDirectory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } })
  })
  await page.route(`**/api/v1/admin/server-installs/${failedId}`, (route) => route.fulfill({ json: { operation: { id: failedId, name: 'Retry Fixture', directoryName: 'retry-fixture', software: 'vanilla', version: '1.21.4', loaderVersion: null, status: 'failed', progress: 50, phase: 'failed', installerLog: '', serverId: null, artifactUrl: null, artifactSize: null, artifactSha256: null, checksumType: null, error: { code: 'CHECKSUM_MISMATCH', message: 'The provider checksum did not match.' }, partialDirectory: '/tmp/mmsmanager-stage3-e2e-servers/retry-fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } }))
  await page.route(`**/api/v1/admin/server-installs/${completedId}`, (route) => route.fulfill({ json: { operation: { id: completedId, name: 'Retry Fixture', directoryName: String(sent[1]?.['directoryName'] ?? 'retry-fixture-2'), software: 'vanilla', version: '1.21.4', loaderVersion: null, status: 'completed', progress: 100, phase: 'complete', installerLog: '', serverId, artifactUrl: 'https://piston-data.mojang.com/server.jar', artifactSize: 9, artifactSha256: 'b'.repeat(64), checksumType: 'sha256', error: null, partialDirectory: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } }))

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
  await page.getByRole('button', { name: 'Import from ZIP' }).click()
  const importDialog = page.getByRole('dialog', { name: 'Import a server archive' })
  await importDialog.getByText('Advanced: register a folder already on this machine').click()
  await importDialog.getByRole('button', { name: 'Register host folder' }).click()
  const dialog = page.getByRole('dialog', { name: 'Register a server folder' })
  await dialog.getByLabel('Server folder path').fill(serverDirectory)
  await dialog.getByRole('button', { name: 'Inspect folder' }).click()
  await expect(dialog.getByText('Vanilla')).toBeVisible()
  await expect(dialog.getByText('25571')).toBeVisible()
  await expect(dialog.locator('.server-import-facts').getByText('Not found').first()).toBeVisible()
  await dialog.getByLabel('Display name').fill('Temporary Smoke Server')
  await page.screenshot({ path: screenshotPath('stage-04a-import-dialog-desktop.png') })
  await dialog.getByRole('button', { name: 'Add to inventory' }).click()
  await expect(page.getByText('Temporary Smoke Server')).toBeVisible()
  await expect(page.getByText(serverDirectory, { exact: true })).toHaveCount(0)
  expect(existsSync(join(serverDirectory, 'server.properties'))).toBe(true)
  expect(existsSync(join(serverDirectory, 'server.jar'))).toBe(true)
  expect(existsSync(join(serverDirectory, 'eula.txt'))).toBe(false)
  await page.screenshot({ path: screenshotPath('stage-04a-servers-desktop.png'), fullPage: true })
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
  await page.screenshot({ path: screenshotPath('stage-04c-local-server-desktop.png'), fullPage: true })
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
  await page.screenshot({ path: screenshotPath('stage-05a-local-players-desktop.png'), fullPage: true })
  await page.getByRole('link', { name: 'Overview' }).click()

  await page.getByRole('link', { name: 'Console' }).click()
  await expect(page.getByText('Connected to owned process')).toBeVisible()
  await expect(page.getByText('Done (1.2s)! For help, type "help"')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-04c-local-console-desktop.png'), fullPage: true })
  await page.getByRole('textbox', { name: 'Minecraft server command' }).fill('say browser fixture')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => fixture.submittedCommand).toBe('say browser fixture')

  await page.getByRole('link', { name: 'Logs' }).click()
  await expect(page.getByRole('heading', { name: 'Process output' })).toBeVisible()
  await expect(page.getByText('Done (1.2s)! For help, type "help"').first()).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-04c-local-logs-desktop.png'), fullPage: true })

  await page.getByRole('link', { name: 'Properties' }).click()
  await expect(page.getByRole('heading', { name: 'Server properties', level: 3 })).toBeVisible()
  await expect(page.getByText('Unrecognized keys', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Basic properties' })).toBeVisible()
  await page.getByLabel('Message of the day').fill('Changed in browser fixture')
  await page.getByRole('tab', { name: 'Advanced properties' }).click()
  await expect(page.getByText('Operator command level', { exact: true })).toBeVisible()
  const hardcoreToggle = page.getByRole('checkbox', { name: /Hardcore/ })
  await page.locator('label.property-toggle').filter({ has: hardcoreToggle }).click()
  await page.getByRole('button', { name: 'Save properties' }).click()
  await expect(page.getByText('Saved with a recovery copy.')).toBeVisible()
  await expect(page.getByText('Restart required').first()).toBeVisible()
  await expect(hardcoreToggle).toBeChecked()
  await expect(page.getByText('Saved in file').first()).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-06hr-properties-advanced-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('tab', { name: 'Basic properties' }).click()
  await expect(page.getByLabel('Message of the day')).toHaveValue('Changed in browser fixture')
  await page.getByRole('button', { name: 'Preview restore' }).click()
  const propertyRestore = page.getByRole('dialog', { name: 'Restore properties' })
  await expect(propertyRestore.getByText('A previous fixture message')).toBeVisible()
  await expect(propertyRestore.getByText('The server is running. Restored values apply after its next restart.')).toBeVisible()
  await propertyRestore.getByRole('button', { name: 'Restore this version' }).click()
  await expect(page.getByLabel('Message of the day')).toHaveValue('A previous fixture message')
  await page.screenshot({ path: screenshotPath('stage-04d-properties-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('tab', { name: 'Advanced properties' }).click()
  await expect(hardcoreToggle).toBeChecked()
  await expectNoHorizontalOverflow(page, 'advanced properties mobile')
  await page.screenshot({ path: screenshotPath('stage-06hr-properties-advanced-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('R7 console follows active output and keeps stopped history read only', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  await page.goto(`/servers/${serverId}/console`)
  const consoleView = page.locator('.local-console-output')
  await expect(page.getByText('Connected to owned process')).toBeVisible()
  await expect.poll(() => consoleView.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await expect.poll(() => consoleView.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(10)
  await consoleView.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  await expect(page.getByRole('button', { name: 'Auto-follow off' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: /Jump to latest/ }).click()
  await expect(page.getByRole('button', { name: 'Auto-follow on' })).toBeVisible()
  await expect.poll(() => consoleView.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(10)
  await page.getByRole('link', { name: 'Logs' }).click()
  await expect(page.getByLabel('Choose process session')).toBeVisible()
  await expect(page.getByText('Done (1.2s)! For help, type "help"')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'R7 process logs desktop')
  await page.screenshot({ path: screenshotPath('stage-06hr-live-logs-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/servers/${serverId}/console`)
  await expect(page.getByRole('textbox', { name: 'Minecraft server command' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'R7 console mobile')
  await page.screenshot({ path: screenshotPath('stage-06hr-live-console-mobile.png'), fullPage: true, animations: 'disabled' })

  const stoppedPage = await page.context().newPage()
  try {
    const stoppedFixture = await mockLocalServer(stoppedPage, 'stopped')
    await stoppedPage.goto(`/servers/${stoppedFixture.serverId}/console`)
    await expect(stoppedPage.getByText('Console unavailable', { exact: true })).toBeVisible()
    await expect(stoppedPage.getByRole('link', { name: 'Console' })).toHaveCount(0)
    await expect(stoppedPage.getByRole('link', { name: 'Logs' })).toBeVisible()
    await stoppedPage.goto(`/servers/${stoppedFixture.serverId}/logs`)
    await expect(stoppedPage.getByText('Done (1.2s)! For help, type "help"')).toBeVisible()
    await stoppedPage.goto(`/servers/${stoppedFixture.serverId}/players`)
    await expect(stoppedPage.getByText('Players unavailable', { exact: true })).toBeVisible()
    await expect(stoppedPage.getByRole('button', { name: 'Refresh list' })).toHaveCount(0)
    await expectNoHorizontalOverflow(stoppedPage, 'R7 stopped server players')
  } finally { await stoppedPage.close() }
})

test('R8 administrators can grant server permissions with dependent access enabled', async ({ page }) => {
  test.setTimeout(60_000)
  await signIn(page)
  await page.goto('/users')
  await page.getByRole('button', { name: 'Add user' }).click()
  const addMember = page.getByRole('dialog', { name: 'Add a user' })
  await addMember.getByLabel('Username').fill('r8-member')
  await addMember.getByLabel('Display name').fill('R8 Member')
  await addMember.getByLabel('Initial password').fill(memberPassword)
  await addMember.getByLabel('Role').selectOption('member')
  await addMember.getByRole('button', { name: 'Create user' }).click()
  await expect(page.locator('.account-users-table .data-table-row').filter({ hasText: '@r8-member' })).toBeVisible()
  const { serverId } = await mockLocalServer(page, 'stopped')
  const allCapabilities = {
    viewServer: true, viewLogs: true, sendConsoleCommands: false, controlLifecycle: false, startServer: true, stopServer: true, restartServer: true, viewPlayers: true,
    moderatePlayers: true, viewMods: true, manageMods: true, viewFiles: true, manageFiles: true,
    viewSettings: true, manageSettings: true, viewWorlds: true, viewBackups: true, createBackups: true,
  }
  let memberPermissions = Object.fromEntries(Object.keys(allCapabilities).map((key) => [key, false])) as typeof allCapabilities
  let savedPayload: { userId: string; permissions: typeof allCapabilities } | null = null
  let administrator = true
  const members = () => [{ userId: 'b13c1cf8-e2a1-4a4e-9de4-4536c7796091', username: 'r8-member', displayName: 'R8 Member', role: 'member', enabled: true, permissions: memberPermissions }]
  await page.route(`**/api/v1/servers/${serverId}/access`, (route) => route.fulfill({ json: { administrator, permissions: administrator ? allCapabilities : memberPermissions } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/access`, async (route) => {
    if (route.request().method() === 'PUT') {
      savedPayload = route.request().postDataJSON() as { userId: string; permissions: typeof allCapabilities }
      memberPermissions = savedPayload.permissions
    }
    return route.fulfill({ json: { users: members() } })
  })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto(`/servers/${serverId}/access`)
  await expect(page.getByRole('heading', { name: 'Access policy' })).toBeVisible()
  const backupsGroup = page.getByRole('checkbox', { name: 'Backups' })
  await expect(backupsGroup).not.toBeChecked()
  await page.getByRole('button', { name: 'Advanced' }).click()
  const viewBackups = page.getByRole('checkbox', { name: /View and download backups/ })
  const createBackups = page.getByRole('checkbox', { name: /Create backups/ })
  await createBackups.check()
  await expect(viewBackups).toBeChecked()
  await page.getByRole('button', { name: 'Basic' }).click()
  await expect(backupsGroup).toBeChecked()
  await page.getByRole('button', { name: 'Advanced' }).click()
  await expect(viewBackups).toBeChecked()
  await expect(createBackups).toBeChecked()
  await createBackups.uncheck()
  await page.getByRole('button', { name: 'Basic' }).click()
  await expect(backupsGroup).toHaveAttribute('aria-checked', 'mixed')
  await backupsGroup.check()
  await expect(backupsGroup).toBeChecked()
  await page.getByRole('button', { name: 'Advanced' }).click()
  await expect(viewBackups).toBeChecked()
  await expect(createBackups).toBeChecked()
  await expect(page.getByText('Unrestricted Minecraft console commands', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Administrator only', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save permissions' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save permissions' }).click()
  await expect(page.getByText('Permissions saved and active immediately.')).toBeVisible()
  expect(savedPayload).toMatchObject({ userId: 'b13c1cf8-e2a1-4a4e-9de4-4536c7796091', permissions: { viewServer: true, viewBackups: true, createBackups: true } })
  await page.screenshot({ path: screenshotPath('r8-access-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.goto('/settings')
  await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
  let appearance = page.locator('form.appearance-form')
  await appearance.locator('select').nth(0).selectOption('ru')
  await appearance.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  await page.goto(`/servers/${serverId}/access`)
  await expect(page.getByRole('heading', { name: 'Правила доступа' }).first()).toBeVisible()
  await expect(page.getByText('Доступ к серверу', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Сохранить права' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Базовый' })).toBeVisible()
  await page.getByRole('button', { name: 'Расширенный' }).click()
  await expect(page.getByText('Неограниченные команды консоли Minecraft', { exact: true })).toBeVisible()
  await expect(page.getByText('Только администраторам', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: screenshotPath('r8-access-admin-ru-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'R8 Access policy at 390px')
  await page.screenshot({ path: screenshotPath('r8-access-admin-ru-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Язык и оформление' }).click()
  appearance = page.locator('form.appearance-form')
  await appearance.locator('select').nth(0).selectOption('en')
  await appearance.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await signOut(page)
  administrator = false
  await signIn(page, 'r8-member', memberPassword)
  await page.goto(`/servers/${serverId}/access`)
  await expect(page.getByRole('heading', { name: 'Your server permissions' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Choose member account' })).toHaveCount(0)
  await expect(page.getByText('Create backups', { exact: true })).toBeVisible()
  await expect(page.getByText('Granted', { exact: true })).toHaveCount(3)
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/settings')
  await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
  appearance = page.locator('form.appearance-form')
  await appearance.locator('select').nth(0).selectOption('ru')
  await appearance.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  await page.goto(`/servers/${serverId}/access`)
  await expect(page.getByRole('heading', { name: 'Правила доступа' }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Ваши права на сервер' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'R8 Access at 390px')
  await page.screenshot({ path: screenshotPath('r8-access-member-ru-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('R3 sidebar preference survives rapid toggles, keyboard, navigation and reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page)
  const frame = page.locator('.app-frame')
  const toggle = page.locator('.collapse-sidebar')
  const initiallyCollapsed = await frame.evaluate((element) => element.classList.contains('sidebar-collapsed'))
  expect(await frame.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain('0.28s')
  await toggle.click()
  await toggle.click()
  await expect(frame).toHaveClass(initiallyCollapsed ? /sidebar-collapsed/ : /(?!.*sidebar-collapsed)/)
  await expect(toggle).toHaveAttribute('aria-busy', 'false')
  await page.reload()
  await expect(frame).toHaveClass(initiallyCollapsed ? /sidebar-collapsed/ : /(?!.*sidebar-collapsed)/)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reducedDurationMs = await frame.evaluate((element) => {
    const duration = getComputedStyle(element).transitionDuration.split(',')[0]!.trim()
    const value = Number.parseFloat(duration)
    return duration.endsWith('ms') ? value : value * 1000
  })
  expect(reducedDurationMs).toBeLessThanOrEqual(0.02)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(page.locator('.app-frame')).toHaveClass(/sidebar-collapsed/)
  await page.waitForTimeout(80)
  const sidebarTrackDuringCollapse = await frame.evaluate((element) => Number.parseFloat(getComputedStyle(element).gridTemplateColumns.split(' ')[0]!))
  expect(sidebarTrackDuringCollapse).toBeGreaterThan(76)
  expect(sidebarTrackDuringCollapse).toBeLessThan(256)
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false')
  await page.goto('/settings')
  await expect(page.locator('.app-frame')).toHaveClass(/sidebar-collapsed/)
  await page.reload()
  await expect(page.locator('.app-frame')).toHaveClass(/sidebar-collapsed/)
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(page.locator('.app-frame')).not.toHaveClass(/sidebar-collapsed/)
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await page.reload()
  await expect(page.locator('.app-frame')).toHaveClass(/sidebar-collapsed/)
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await page.reload()
  await expect(page.locator('.app-frame')).not.toHaveClass(/sidebar-collapsed/)
  await page.locator('.collapse-sidebar').focus()
  await page.keyboard.press('Enter')
  await expect(frame).toHaveClass(/sidebar-collapsed/)
  await expect(toggle).toHaveAttribute('aria-busy', 'false')
  await page.keyboard.press('Enter')
  await expect(frame).not.toHaveClass(/sidebar-collapsed/)
  await expect(toggle).toHaveAttribute('aria-busy', 'false')
})

test('R3 workspace and server screens fit the 390/768/1280/1920px layout matrix', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  const workspaceRoutes = ['/', '/servers', '/machine', '/machine/history', '/activity', '/backups', '/templates', '/users', '/profile', '/settings']
  const workspaceScreenshotRoutes = new Set(['/', '/servers', '/machine', '/settings'])
  const serverScreenshotSections = new Set(['overview', 'console', 'properties', 'backups', 'access'])
  for (const width of [390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 980 })
    for (const route of workspaceRoutes) {
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.page-content')).toBeVisible()
      if (workspaceScreenshotRoutes.has(route)) {
        const routeName = route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '-')
        await page.screenshot({ path: screenshotPath(`r3-${routeName}-${width}.png`), fullPage: true, animations: 'disabled' })
      }
      await expectNoHorizontalOverflow(page, `${route} at ${width}px`)
    }
  }

  const { serverId } = await mockLocalServer(page)
  const serverSections = ['overview', 'console', 'logs', 'players', 'mods', 'files', 'properties', 'worlds', 'runtime', 'backups', 'automation', 'access', 'danger-zone']
  for (const width of [390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 980 })
    for (const section of serverSections) {
      const route = `/servers/${serverId}/${section}`
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.page-content')).toBeVisible()
      if (section === 'access') await expectAccessBadgeFits(page, `${section} at ${width}px`)
      if (serverScreenshotSections.has(section)) await page.screenshot({ path: screenshotPath(`r3-server-${section}-${width}.png`), fullPage: true, animations: 'disabled' })
      await expectNoHorizontalOverflow(page, `${section} at ${width}px`)
    }
  }

  const zoomWidths = [{ zoom: 125, width: 1024 }, { zoom: 150, width: 853 }]
  for (const { zoom, width } of zoomWidths) {
    await page.setViewportSize({ width, height: 980 })
    for (const route of workspaceRoutes) {
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.page-content')).toBeVisible()
      await expectNoHorizontalOverflow(page, `${route} at ${zoom}% zoom (effective ${width}px)`)
      if (['/', '/servers', '/settings'].includes(route)) {
        const routeName = route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '-')
        await page.screenshot({ path: screenshotPath(`r3-zoom-${zoom}-${routeName}.png`), fullPage: true, animations: 'disabled' })
      }
    }
    for (const section of serverSections) {
      const route = `/servers/${serverId}/${section}`
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.page-content')).toBeVisible()
      if (section === 'access') await expectAccessBadgeFits(page, `${section} at ${zoom}% zoom`)
      await expectNoHorizontalOverflow(page, `${section} at ${zoom}% zoom (effective ${width}px)`)
      if (['access', 'players', 'files', 'properties'].includes(section)) {
        await page.screenshot({ path: screenshotPath(`r3-zoom-${zoom}-server-${section}.png`), fullPage: true, animations: 'disabled' })
      }
    }
  }
})

test('administrator monitoring settings persist and apply without a restart', async ({ page }) => {
  await signIn(page)
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Monitoring' }).click()
  const values = page.locator('.settings-content input[type="number"]')
  await expect(values.nth(0)).toHaveValue('1')
  await expect(values.nth(1)).toHaveValue('10')
  await expect(values.nth(2)).toHaveValue('30')
  await expect(values.nth(3)).toHaveValue('15')
  await values.nth(0).fill('2')
  await values.nth(1).fill('15')
  await values.nth(2).fill('45')
  await values.nth(3).fill('25')
  await page.getByRole('button', { name: 'Apply monitoring' }).click()
  await expect(page.getByText('Monitoring settings were applied.')).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Monitoring' }).click()
  await expect(values.nth(0)).toHaveValue('2')
  await expect(values.nth(1)).toHaveValue('15')
  await expect(values.nth(2)).toHaveValue('45')
  await expect(values.nth(3)).toHaveValue('25')
  await values.nth(0).fill('1')
  await values.nth(1).fill('10')
  await values.nth(2).fill('30')
  await values.nth(3).fill('15')
  await page.getByRole('button', { name: 'Apply monitoring' }).click()
  await expect(page.getByText('Monitoring settings were applied.')).toBeVisible()
})

test('dashboard player totals distinguish stopped and unavailable servers', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page)
  const stopped = await mockLocalServer(page, 'stopped')
  let playerSummaryResponse = { playersOnline: 0, complete: true, registeredServerCount: 1, pollIntervalMs: 15_000, checkedAt: new Date().toISOString() }
  await page.route('**/api/v1/dashboard/players', (route) => route.fulfill({ json: { summary: playerSummaryResponse } }))
  await page.goto('/')
  await expect(page.getByText('Players online').locator('..')).toContainText('0')
  await expect(page.getByText('Players online').locator('..')).toContainText('none online')

  await page.route(`**/api/v1/servers/${stopped.serverId}/status`, (route) => route.fulfill({ status: 503, json: { error: { code: 'STATUS_UNAVAILABLE', message: 'Status is unavailable.' } } }))
  playerSummaryResponse = { ...playerSummaryResponse, playersOnline: null, complete: false, checkedAt: new Date().toISOString() }
  await page.route('**/api/v1/servers', (route) => route.fulfill({ json: { servers: [{
    id: stopped.serverId, name: 'Local Fixture', source: 'created', software: 'paper', version: '1.21.4', jarName: 'server.jar',
    javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096, port: 25565, portStatus: 'valid', portErrorCode: null, eula: 'accepted', managed: true,
    worldFolders: ['world'], createdAt: new Date().toISOString(), runtimeStatus: 'running',
  }] } }))
  await page.reload()
  const playerSummary = page.getByText('Players online').locator('..')
  await expect(playerSummary).toContainText('unavailable')
  await expect(playerSummary).toContainText('—')
  await expect(playerSummary).not.toContainText('0')
})

test('local server detail and property controls fit a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  await page.goto(`/servers/${serverId}/overview`)
  await expect(page.getByRole('heading', { name: 'Local Fixture' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server mobile overview')
  await page.screenshot({ path: screenshotPath('stage-04c-local-server-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('link', { name: 'Properties' }).click()
  await expect(page.getByLabel('Message of the day')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server mobile properties')
  await page.screenshot({ path: screenshotPath('stage-04d-properties-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('link', { name: 'Console' }).click()
  await expect(page.getByRole('textbox', { name: 'Minecraft server command' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server mobile console')
  await page.screenshot({ path: screenshotPath('stage-04c-local-console-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('link', { name: 'Players' }).click()
  await expect(page.getByRole('heading', { name: 'Online identities' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server mobile players')
  await page.screenshot({ path: screenshotPath('stage-05a-local-players-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('runtime settings, safe restart, backup schedule and restart schedule work on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  await page.goto(`/servers/${serverId}/runtime`)
  await expect(page.getByRole('heading', { name: 'Runtime profile' })).toBeVisible()
  await expect(page.getByLabel('Java selection')).toHaveValue('auto')
  await expect(page.getByText('Auto selected the exact declared minimum.')).toBeVisible()
  await expect(page.getByText('Java 21', { exact: true })).toBeVisible()
  await page.screenshot({ path: screenshotPath('i6-runtime-auto-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.getByLabel('Java selection').selectOption('manual')
  await expect(page.getByLabel('Selected Java executable')).toHaveValue('/tmp/mmsmanager-e2e-java-21')
  await page.getByLabel('Selected Java executable').selectOption('/tmp/mmsmanager-e2e-java-8')
  await expect(page.getByText('This runtime is below the declared Java minimum.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save runtime settings' })).toBeDisabled()
  await page.getByLabel('Confirm manual compatibility exception').check()
  await page.getByLabel('Selected Java executable').selectOption('/tmp/mmsmanager-e2e-java-21')
  await page.getByLabel('Minimum memory').fill('1536')
  await page.getByLabel('Maximum memory').fill('6144')
  await page.getByLabel('Garbage collector').selectOption('g1')
  await page.getByLabel('Maximum GC pause').fill('200')
  await page.getByRole('button', { name: 'Save runtime settings' }).click()
  await expect(page.getByText('Settings saved. Restart required before the running process uses them.')).toBeVisible()
  await expect(page.getByText('Restart required', { exact: true })).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-05f-runtime-desktop.png'), fullPage: true })

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(page.getByText('Restart required', { exact: true })).toHaveCount(0)

  await page.getByRole('link', { name: 'Automation' }).click()
  await expect(page.getByRole('heading', { name: 'Scheduled tasks' })).toBeVisible()
  await expect(page.getByText('1 missed backup needs review.')).toBeVisible()
  await page.getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.getByText('Missed backup acknowledged. No backup was created for that time.')).toBeVisible()
  await page.locator('.local-automation-toggle input').first().check()
  await page.getByLabel('Backup frequency').selectOption('weekly')
  await page.getByLabel('Backup weekday').selectOption('3')
  await page.getByLabel('Backup local time').fill('04:15')
  await page.getByRole('button', { name: 'Save backup schedule' }).click()
  await expect(page.getByText('Schedule saved in Europe/Paris. The next backup will run only if the managed server is stopped.')).toBeVisible()
  await expect(page.getByLabel('Backup frequency')).toHaveValue('weekly')
  await expect(page.getByRole('heading', { name: 'Scheduled restarts' })).toBeVisible()
  const restartCard = page.locator('.local-automation-settings-card').filter({ has: page.getByRole('heading', { name: 'Scheduled restarts' }) })
  await expect(restartCard.locator('.local-automation-toggle input').nth(1)).toBeChecked()
  await restartCard.locator('.local-automation-toggle input').nth(0).check()
  await restartCard.getByLabel('Restart local time').fill('03:30')
  await restartCard.getByLabel('Restart wait policy').selectOption('retry')
  await restartCard.getByLabel('Retry interval, minutes').fill('5')
  await restartCard.getByLabel('Wait deadline, minutes').fill('30')
  await restartCard.getByRole('button', { name: 'Save restart schedule' }).click()
  await expect(page.getByText('Restart schedule saved. It remains limited to a running server managed by MMSManager.')).toBeVisible()
  await expect(restartCard.locator('.local-automation-toggle input').nth(1)).toBeChecked()
  await page.screenshot({ path: screenshotPath('i5-restart-schedule-en-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Language & appearance' }).click()
  const appearanceForm = page.locator('form.appearance-form')
  const appearanceFields = appearanceForm.locator('select')
  await appearanceFields.nth(0).selectOption('ru')
  await appearanceForm.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  await page.goto(`/servers/${serverId}/automation`)
  await expect(page.getByRole('heading', { name: 'Перезапуски по расписанию' })).toBeVisible()
  await expect(page.getByLabel('Местное время перезапуска')).toHaveValue('03:30')
  await expect(page.getByLabel('Ожидание перед перезапуском')).toHaveValue('retry')
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'Russian scheduled restart on mobile')
  await page.screenshot({ path: screenshotPath('i5-restart-schedule-ru-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.goto(`/servers/${serverId}/runtime`)
  await expect(page.getByRole('heading', { name: 'Профиль запуска' })).toBeVisible()
  await expect(page.getByLabel('Выбор Java')).toHaveValue('manual')
  await expect(page.getByText('Память Minecraft')).toBeVisible()
  await expectNoHorizontalOverflow(page, 'Russian Java runtime on mobile')
  await page.screenshot({ path: screenshotPath('i6-runtime-ru-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Язык и оформление' }).click()
  await page.locator('form.appearance-form select').first().selectOption('en')
  await page.locator('form.appearance-form .settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/servers/${serverId}/runtime`)
  await expect(page.getByRole('heading', { name: 'Runtime profile' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server runtime mobile')
  await page.screenshot({ path: screenshotPath('stage-05f-runtime-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.goto(`/servers/${serverId}/automation`)
  await expect(page.getByRole('heading', { name: 'Scheduled tasks' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'local server automation mobile')
  await page.screenshot({ path: screenshotPath('stage-05f-automation-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('managed server backups preview, download and restore at desktop and mobile widths', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page, 'stopped')
  await page.goto('/backups')
  await expect(page.getByRole('heading', { name: 'Recent snapshots' })).toBeVisible()
  await expect(page.getByText('Local Fixture ·', { exact: false }).first()).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-05g-backups-registered-desktop.png'), fullPage: true })
  await page.goto(`/servers/${serverId}/backups`)
  await expect(page.getByRole('heading', { name: 'Private server snapshots' })).toBeVisible()
  await expect(page.getByText('No auto-delete')).toBeVisible()
  await expect(page.getByText('SHA-256 aaaaaaaaaaaaaaaa…')).toBeVisible()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download' }).click()
  expect((await downloadEvent).suggestedFilename()).toContain('.mmsbackup')

  await page.getByRole('button', { name: 'Preview restore' }).click()
  const restoreDialog = page.getByRole('dialog', { name: 'Preview server restore' })
  await expect(restoreDialog.getByText('Archive, manifest and per-file checksums verified.')).toBeVisible()
  await expect(restoreDialog.getByText('world/level.dat')).toBeVisible()
  const restoreButton = restoreDialog.getByRole('button', { name: 'Restore Local Fixture' })
  await expect(restoreButton).toBeDisabled()
  await page.screenshot({ path: screenshotPath('stage-05e-backup-restore-preview-desktop.png'), fullPage: true })
  await restoreDialog.locator('.local-backup-confirmation input').fill('RESTORE Local Fixture')
  await expect(restoreButton).toBeEnabled()
  await restoreButton.click()
  await expect(page.getByText(/Restore complete · safety snapshot/)).toBeVisible()
  await expect(page.getByText('Pre-restore safety')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-05e-backups-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/servers/${serverId}/backups`)
  await expect(page.getByRole('heading', { name: 'Private server snapshots' })).toBeVisible()
  await expectNoHorizontalOverflow(page, 'managed server backups mobile')
  await page.screenshot({ path: screenshotPath('stage-05e-backups-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('workspace backups retains healthy inventories when one managed server fails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  const now = new Date().toISOString()
  const unavailableId = 'f03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const unavailable = {
    id: unavailableId, name: 'Unavailable Fixture', source: 'created', software: 'paper', version: '1.21.4',
    jarName: 'server.jar', javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096, port: 25566,
    portStatus: 'valid', portErrorCode: null, eula: 'accepted', managed: true, worldFolders: ['world'], createdAt: now, runtimeStatus: 'stopped',
  }
  await page.route('**/api/v1/servers', (route) => route.fulfill({ json: { servers: [
    { id: serverId, name: 'Local Fixture', source: 'created', software: 'paper', version: '1.21.4', jarName: 'server.jar', javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096, port: 25565, portStatus: 'valid', portErrorCode: null, eula: 'accepted', managed: true, worldFolders: ['world'], createdAt: now, runtimeStatus: 'stopped' },
    unavailable,
  ] } }))
  await page.route(`**/api/v1/admin/servers/${unavailableId}/backups`, (route) => route.fulfill({
    status: 500,
    headers: { 'x-mms-request-id': 'fixture-request-6h1' },
    json: { error: { code: 'INTERNAL_ERROR', message: 'The local data request failed.' } },
  }))

  await page.goto('/backups')
  await expect(page.getByRole('alert')).toContainText('1 server inventory is unavailable')
  await expect(page.getByRole('alert')).toContainText('INTERNAL_ERROR')
  await expect(page.getByRole('alert')).toContainText('fixture-request-6h1')
  await expect(page.getByRole('link', { name: 'Open server backups' })).toBeVisible()
  await expect(page.getByText('Local Fixture ·', { exact: false })).toBeVisible()
  await expect(page.getByText('Unavailable Fixture ·', { exact: false })).toHaveCount(0)
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
  await page.screenshot({ path: screenshotPath('stage-05b-paper-plugins-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'local Paper plugins mobile')
  await page.screenshot({ path: screenshotPath('stage-05b-paper-plugins-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('managed files edit with recovery, trash and restore at desktop and mobile widths', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const fixture = await mockLocalServer(page)
  const { serverId } = fixture
  await page.goto(`/servers/${serverId}/files`)
  await expect(page.locator('.local-files-card h3', { hasText: 'Files' })).toBeVisible()
  await expect(page.getByText('server.properties')).toBeVisible()
  await expect(page.getByText('Protected', { exact: true }).first()).toBeVisible()
  for (const name of ['versions', 'libraries', '.fabric', 'user_jvm_args.txt']) {
    const protectedRow = page.locator('.local-file-row').filter({ hasText: name })
    await expect(protectedRow.getByRole('button', { name: new RegExp(`Rename ${name}`) })).toHaveCount(0)
    await expect(protectedRow.getByRole('button', { name: new RegExp(`Move ${name}`) })).toHaveCount(0)
    await expect(protectedRow.getByRole('button', { name: new RegExp(`Move to trash ${name}`) })).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'config', exact: true }).click()
  await page.getByRole('button', { name: 'server-note.txt', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Edit config/server-note.txt' })
  await editor.getByRole('textbox', { name: 'Text file contents' }).fill('Edited through the local file manager.\n')
  await editor.getByRole('button', { name: 'Save text' }).click()
  await expect(editor.getByText('Private recovery copies')).toBeVisible()
  await page.once('dialog', (confirm) => void confirm.accept())
  await editor.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Text file contents' })).toHaveValue('Fixture notes from the managed server.\n')
  await editor.getByRole('button', { name: 'Close' }).click()

  await page.once('dialog', (confirm) => void confirm.accept())
  await page.getByRole('button', { name: 'Move to trash server-note.txt' }).click()
  const trashToggle = page.locator('.local-files-header-actions').getByRole('button', { name: /Trash/ })
  await trashToggle.click()
  await expect(page.getByText('config/server-note.txt')).toBeVisible()
  await page.once('dialog', (confirm) => void confirm.accept())
  await page.locator('.local-file-trash-row').getByRole('button', { name: /^Restore config\/server-note\.txt$/ }).click()
  await expect(page.getByRole('button', { name: 'server-note.txt', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'New folder' }).click()
  const createFolder = page.getByRole('dialog', { name: 'Create folder' })
  await createFolder.getByLabel('Name').fill('notes')
  await createFolder.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('button', { name: 'notes', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Rename server-note.txt' }).click()
  const renameDialog = page.getByRole('dialog', { name: 'Rename item' })
  await renameDialog.getByLabel('New name').fill('renamed-note.txt')
  await renameDialog.getByRole('button', { name: 'Rename item' }).click()
  expect(fixture.renameRequests.at(-1)).toEqual({ path: 'config/server-note.txt', newName: 'renamed-note.txt' })
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Move renamed-note.txt' }).click()
  const moveDialog = page.getByRole('dialog', { name: 'Move item' })
  await moveDialog.getByLabel('Destination folder').fill('')
  await moveDialog.getByRole('button', { name: 'Move item' }).click()
  expect(fixture.moveRequests.at(-1)).toEqual({ sourcePath: 'config/renamed-note.txt', destinationDirectory: '' })
  await page.getByRole('button', { name: 'Server root', exact: true }).click()
  await expect(page.getByRole('button', { name: 'renamed-note.txt', exact: true })).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-05c-file-manager-desktop.png'), fullPage: true })

  const languageStatus = await page.evaluate(async () => {
    const csrfCookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('mmsmanager_csrf='))
    const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.slice('mmsmanager_csrf='.length)) : ''
    const response = await fetch('/api/v1/profile/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mms-csrf': csrfToken }, body: JSON.stringify({ language: 'ru' }) })
    return response.status
  })
  expect(languageStatus).toBe(200)

  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/servers/${serverId}/files`)
    await expect(page.getByRole('button', { name: 'config', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Переименовать renamed-note.txt' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Переместить renamed-note.txt' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'В корзину renamed-note.txt' })).toBeVisible()
    await expectNoHorizontalOverflow(page, 'managed file manager mobile')
    await page.screenshot({ path: screenshotPath('stage-05c-file-manager-mobile.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: 'Переименовать renamed-note.txt' }).click()
    const russianRenameDialog = page.getByRole('dialog', { name: 'Переименовать элемент' })
    await expect(russianRenameDialog.getByLabel('Новое имя')).toBeVisible()
    await expectNoHorizontalOverflow(page, 'Russian rename dialog mobile')
    await page.screenshot({ path: screenshotPath('stage-06i-04-rename-russian-mobile.png'), fullPage: true, animations: 'disabled' })
  } finally {
    await restoreEnglishPreferences(page)
  }
})

test('managed files upload multiple files and preserve selected folder hierarchy', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const fixture = await mockLocalServer(page)
  await page.goto(`/servers/${fixture.serverId}/files`)
  await page.getByRole('button', { name: 'config', exact: true }).click()

  const multipleInput = page.getByTestId('server-file-upload-input')
  await multipleInput.setInputFiles([
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('MULTI-UPLOAD-FIRST') },
    { name: 'second.dat', mimeType: 'application/octet-stream', buffer: Buffer.from('MULTI-UPLOAD-SECOND') },
  ])
  await expect(page.getByText('Upload complete.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'first.txt', exact: true })).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-06hr-r05-files-desktop.png'), fullPage: true })
  expect(fixture.uploadRequests[0]?.path).toBe('config')
  expect(fixture.uploadRequests[0]?.body).toContain('MULTI-UPLOAD-FIRST')
  expect(fixture.uploadRequests[0]?.body).toContain('MULTI-UPLOAD-SECOND')

  const scratch = mkdtempSync(join(tmpdir(), 'mmsmanager-stage6hr-upload-'))
  const selectedFolder = join(scratch, 'upload-pack')
  mkdirSync(join(selectedFolder, 'nested'), { recursive: true })
  writeFileSync(join(selectedFolder, 'root.txt'), 'FOLDER-UPLOAD-ROOT')
  writeFileSync(join(selectedFolder, 'nested', 'nested.bin'), 'FOLDER-UPLOAD-NESTED')
  try {
    const folderInput = page.getByTestId('server-folder-upload-input')
    await expect(folderInput).toBeEnabled()
    await folderInput.setInputFiles(selectedFolder)
    await expect(page.getByText('Upload complete.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'upload-pack', exact: true }).click()
    await expect(page.getByRole('button', { name: 'nested', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'nested', exact: true }).click()
    await expect(page.getByRole('button', { name: 'nested.bin', exact: true })).toBeVisible()
    const folderRequest = fixture.uploadRequests.at(-1)
    expect(folderRequest?.path).toBe('config')
    expect(folderRequest?.body).toContain('upload-pack/root.txt')
    expect(folderRequest?.body).toContain('upload-pack/nested/nested.bin')

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/servers/${fixture.serverId}/files`)
    await page.getByRole('button', { name: 'config', exact: true }).click()
    await page.getByRole('button', { name: 'upload-pack', exact: true }).click()
    await expectNoHorizontalOverflow(page, 'uploaded folder hierarchy mobile')
    await page.screenshot({ path: screenshotPath('stage-06hr-r05-files-mobile.png'), fullPage: true, animations: 'disabled' })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('managed worlds and server history use isolated real-data API fixtures', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  const timeZone = 'Europe/Paris'
  const first = '2026-03-29T00:05:00.000Z'
  const last = '2026-03-29T21:55:00.000Z'
  await page.route('**/api/v1/admin/server-history/calendar?*', (route) => {
    const url = new URL(route.request().url())
    const scope = url.searchParams.get('scope') ?? 'all'
    const year = Number(url.searchParams.get('year'))
    const month = Number(url.searchParams.get('month'))
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const days = Array.from({ length: daysInMonth }, (_, index) => {
      const day = (index + 1).toString().padStart(2, '0')
      const date = `${year}-${month.toString().padStart(2, '0')}-${day}`
      return { date, status: date === '2026-03-29' ? 'partial' : 'no-data', sampleCount: date === '2026-03-29' ? 2 : 0, eventCount: date === '2026-03-29' ? 1 : 0, firstSampleAt: date === '2026-03-29' ? first : null, lastSampleAt: date === '2026-03-29' ? last : null, coveragePercent: date === '2026-03-29' ? 0.15 : 0 }
    })
    return route.fulfill({ json: { calendar: { scope, year, month, timeZone, days } } })
  })
  await page.route('**/api/v1/admin/server-history/day?*', (route) => {
    const scope = new URL(route.request().url()).searchParams.get('scope') ?? 'all'
    return route.fulfill({ json: { day: {
    scope, date: '2026-03-29', timeZone, status: 'partial', window: { from: '2026-03-28T23:00:00.000Z', to: '2026-03-29T22:00:00.000Z', durationMs: 82_800_000 },
    summary: { sampleCount: 2, firstSampleAt: first, lastSampleAt: last, coveragePercent: 0.15, cpuAveragePercent: 14.2, cpuMaximumPercent: 38.7, memoryPeakBytes: 805306368, playersPeak: 4, uptimeSeconds: 82_800, sessionCount: 1 },
    points: [{ observedAt: first, sampleCount: 1, serverCount: 1, cpuAveragePercent: 14.2, memoryPeakBytes: 805306368, playersPeak: 2, uptimePeakSeconds: 82000 }, { observedAt: last, sampleCount: 1, serverCount: 1, cpuAveragePercent: 38.7, memoryPeakBytes: 780000000, playersPeak: 4, uptimePeakSeconds: 82800 }],
    events: [{ id: 5, serverId, serverName: 'Local Fixture', occurredAt: '2026-03-29T10:00:00.000Z', category: 'player', eventType: 'player_joined', description: 'MiraWoods joined the server.', rawMessage: '[Server thread/INFO]: MiraWoods joined the game', confidence: 'high', source: 'owned-log' }],
    eventsTruncated: false,
    sessions: [{ id: 'f03c1cf8-e2a1-4a4e-9de4-4536c7796091', serverId, serverName: 'Local Fixture', startedAt: '2026-03-28T22:00:00.000Z', endedAt: '2026-03-30T00:00:00.000Z', outcome: 'stopped', uptimeSeconds: 93600, durationInDaySeconds: 82_800 }],
    sessionsTruncated: false,
  } } })
  })

  await page.goto(`/servers/${serverId}/worlds`)
  await expect(page.getByRole('heading', { name: 'World folders' })).toBeVisible()
  await expect(page.getByText('maple-valley', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('7.0 MiB')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-05d-worlds-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'managed worlds mobile')
  await page.screenshot({ path: screenshotPath('stage-05d-worlds-mobile.png'), fullPage: true, animations: 'disabled' })

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`/machine/history?source=${serverId}&month=2026-03&date=2026-03-29`)
  await expect(page.getByRole('heading', { name: 'Server history' })).toBeVisible()
  await expect(page.getByText('Partial collection · <1% observed')).toBeVisible()
  await expect(page.getByText('MiraWoods joined the server.')).toBeVisible()
  await expect(page.getByText('Original log line')).toBeVisible()
  await expect(page.getByText('Uptime in selected day')).toBeVisible()
  await expect(page.getByText('<1% minute coverage')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-05d-server-history-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'server history mobile')
  await page.screenshot({ path: screenshotPath('stage-05d-server-history-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByLabel('History source').selectOption('all')
  await expect(page.getByRole('heading', { name: 'Server history' })).toBeVisible()
  await expect(page.getByLabel('History source')).toHaveValue('all')

  await page.getByLabel('History source').selectOption('local')
  await expect(page.getByRole('heading', { name: 'Machine history' })).toBeVisible()
  await expect(page.getByText('No machine samples saved')).toBeVisible()
})

test('operational notifications can be reviewed and marked read on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  await mockLocalServer(page)
  const eventId = 'server-action:fixture-start-failure'
  const event = {
    id: eventId, occurredAt: new Date().toISOString(), category: 'server', title: 'Server start failed',
    description: 'The local process exited before the server became ready.', outcome: 'failure', source: 'server-action',
    serverId: 'e03c1cf8-e2a1-4a4e-9de4-4536c7796091', serverName: 'Local Fixture', actor: null, redacted: false,
  }
  let readAt: string | null = null
  await page.route('**/api/v1/notifications**', async (route) => {
    if (route.request().method() === 'PATCH') readAt = new Date().toISOString()
    return route.fulfill({ json: { items: [{ eventId, event, readAt }], unreadCount: readAt ? 0 : 1 } })
  })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(page.getByText('Server start failed')).toBeVisible()
  await expect(page.getByText('1 unread notification')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-06c-notifications-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: 'Mark read' }).click()
  await expect(page.getByText('0 unread notifications')).toBeVisible()
  await expect(page.getByText('Read', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'notifications mobile')
  await page.screenshot({ path: screenshotPath('stage-06c-notifications-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('online-mode edits require stopped state and an explicit confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page, 'stopped')
  let propertyUpdate: Record<string, unknown> | null = null
  let onlineModeEnabled = true
  let propertyHash = 'a'.repeat(64)
  const baseSettings = { onlineMode: true, motd: 'A local fixture', gameMode: 'survival', difficulty: 'normal', maxPlayers: 20, viewDistance: 10, simulationDistance: 8, spawnProtection: 16, pvp: true, whiteList: false, allowNether: true }
  const onlineProperties = (restartRequired: boolean) => ({ properties: {
    settings: { ...baseSettings, onlineMode: onlineModeEnabled }, advancedProperties: {}, sha256: propertyHash, serverVersion: '1.21.4', serverSoftware: 'paper',
    configuredPort: 25565, portStatus: 'valid', portErrorCode: null,
    presentKeys: ['online-mode', 'motd', 'gamemode', 'difficulty', 'max-players', 'view-distance', 'simulation-distance', 'spawn-protection', 'pvp', 'white-list', 'allow-nether', 'server-ip'],
    unknownKeys: [], protectedProperties: [{ key: 'server-ip', reason: 'The local web binding is managed separately.', configured: true }], unsupportedKeys: [], backups: [], restartRequired,
  } })
  await page.route(`**/api/v1/admin/servers/${serverId}/properties`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON() as Record<string, unknown>
      propertyUpdate = input
      onlineModeEnabled = input.onlineMode === false ? false : true
      propertyHash = 'b'.repeat(64)
      return route.fulfill({ json: onlineProperties(true) })
    }
    return route.fulfill({ json: onlineProperties(false) })
  })
  await page.goto(`/servers/${serverId}/properties`)
  await expect(page.getByLabel('Online mode')).toBeChecked()
  await page.locator('.local-properties-grid .field').filter({ hasText: 'Online mode' }).locator('label.property-toggle').click()
  await expect(page.getByRole('group', { name: 'Online-mode change' })).toContainText('different player UUIDs')
  await expect(page.getByRole('group', { name: 'Online-mode change' })).toContainText('does not change MMSManager sign-in')
  const save = page.getByRole('button', { name: 'Save properties' })
  await expect(save).toBeDisabled()
  await page.screenshot({ path: screenshotPath('stage-06c-online-mode-confirmation-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.getByLabel('I understand and confirm this change').check()
  await expect(save).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 844 })
  const confirmation = page.getByRole('group', { name: 'Online-mode change' })
  await confirmation.scrollIntoViewIfNeeded()
  await expectNoHorizontalOverflow(page, 'online-mode settings mobile')
  await page.screenshot({ path: screenshotPath('stage-06c-online-mode-confirmation-mobile.png'), animations: 'disabled' })
  await save.click()
  await expect(page.getByText('Saved with a recovery copy.')).toBeVisible()
  expect(propertyUpdate).toMatchObject({ onlineMode: false, confirmOnlineModeChange: true })
})

test('installation cancellation preserves partial files and reports a cancelled result', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page)
  const operationId = '7fc0b937-3e7f-4938-b432-5cc98a529e7c'
  const now = new Date().toISOString()
  let current = { id: operationId, name: 'Cancel Fixture', directoryName: 'cancel-fixture', software: 'vanilla', version: '1.21.4', loaderVersion: null, status: 'pending', progress: 12, phase: 'downloading', installerLog: '', serverId: null, artifactUrl: null, artifactSize: null, artifactSha256: null, checksumType: null, error: null, partialDirectory: null, createdAt: now, updatedAt: now }
  await page.route('**/api/v1/admin/java', (route) => route.fulfill({ json: { runtimes: [{ path: '/tmp/mmsmanager-e2e-java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered' }] } }))
  await page.route('**/api/v1/admin/servers', (route) => route.fulfill({ json: { servers: [], managedRoot: '/tmp/mmsmanager-stage6-e2e-servers', importRoots: ['/tmp/mmsmanager-stage6-e2e-servers'] } }))
  await page.route('**/api/v1/admin/server-installs/catalog?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill({ json: { software: 'vanilla', versions: ['1.21.4'], loaders: [], experimentalLoaders: [], builds: [], installerVersion: null, requiredJavaMajor: url.searchParams.has('version') ? 21 : null } })
  })
  await page.route('**/api/v1/admin/server-installs', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 202, json: { operation: current } })
    : route.fulfill({ json: { operations: [] } }))
  await page.route(`**/api/v1/admin/server-installs/${operationId}**`, async (route) => {
    if (route.request().method() === 'POST' && new URL(route.request().url()).pathname.endsWith('/cancel')) {
      current = { ...current, status: 'failed', phase: 'failed', error: { code: 'INSTALL_CANCELLED', message: 'The installation was cancelled. Any files already created were preserved for review.' }, partialDirectory: '/tmp/mmsmanager-stage6-e2e-servers/cancel-fixture', updatedAt: new Date().toISOString() }
    }
    return route.fulfill({ json: { operation: current } })
  })
  await page.getByRole('button', { name: 'Create server', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create server' })
  await dialog.getByLabel('New directory name').fill('cancel-fixture')
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByLabel('Minecraft release')).toBeEnabled()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Install server' }).click()
  await expect(dialog.getByText('Installation in progress')).toBeVisible()
  page.once('dialog', (confirm) => void confirm.accept())
  await dialog.getByRole('button', { name: 'Cancel installation' }).click()
  await expect(dialog.getByText('Installation cancelled')).toBeVisible()
  await expect(dialog.getByText('Partial files were preserved for review under the managed root.')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-06e-install-cancelled-desktop.png'), fullPage: true, animations: 'disabled' })
})

test('mobile dashboard, account screens and navigation fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  const routes = [
    ['/', 'Dashboard'], ['/servers', 'Servers'], [`/servers/${serverId}/overview`, 'Local Fixture'],
    [`/servers/${serverId}/logs`, 'Process output'], [`/servers/${serverId}/mods`, 'Installed mods'],
    [`/servers/${serverId}/properties`, 'Server properties'], ['/activity', 'Activity'], ['/backups', 'Backups'],
    ['/templates', 'Templates'], ['/machine', 'Machine'], ['/users', 'Users'], ['/profile', 'Profile'], ['/settings', 'Settings'],
  ]
  for (const [route, heading] of routes) {
    await page.goto(route)
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible()
    await expectNoHorizontalOverflow(page, route)
    if (route === '/machine') {
      const ranges = page.getByRole('group', { name: 'History range' })
      await expect(ranges.getByRole('button')).toHaveCount(4)
      await ranges.getByRole('button', { name: '1h' }).click()
      await expect(ranges.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true')
      await expectNoHorizontalOverflow(page, route)
      await page.screenshot({ path: screenshotPath('stage-03-machine-mobile.png'), fullPage: true })
    }
    if (route === '/servers') await page.screenshot({ path: screenshotPath('stage-04a-servers-mobile.png'), fullPage: true })
    if (route === '/users') await page.screenshot({ path: screenshotPath('stage-03-users-mobile.png'), fullPage: true })
    if (route === '/profile') await page.screenshot({ path: screenshotPath('stage-03-profile-mobile.png'), fullPage: true })
    if (route === '/settings') await page.screenshot({ path: screenshotPath('stage-03-settings-mobile.png'), fullPage: true })
    if (route === '/activity') await page.screenshot({ path: screenshotPath('stage-05g-activity-mobile.png'), fullPage: true, animations: 'disabled' })
    if (route === '/backups') {
      const openServerBackups = page.getByRole('link', { name: 'Open server backups' }).first()
      await expect(openServerBackups).toBeVisible()
      const bounds = await openServerBackups.boundingBox()
      if (!bounds) throw new Error('The backup navigation link has no visible bounds.')
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
      await page.screenshot({ path: screenshotPath('stage-05g-backups-mobile.png'), fullPage: true, animations: 'disabled' })
    }
    if (route === '/templates') await page.screenshot({ path: screenshotPath('stage-05g-templates-mobile.png'), fullPage: true, animations: 'disabled' })
  }
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await page.locator('.sidebar.mobile-open .nav-link[href="/machine"]').click()
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
})

test('local host metrics and history remain protected and visibly local', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  await expect(page.locator('.top-demo.machine-live')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Running servers')).toBeVisible()
  await expect(page.getByText('Local CPU', { exact: true })).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-03-dashboard-authenticated-desktop.png'), fullPage: true })

  await page.goto('/machine')
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
  await expect(page.getByText('Local API connected')).toHaveCount(0)
  await expect(page.getByText('Collected from this local machine only.')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Java runtimes' })).toBeVisible()
  await expect(page.getByText('Reading runtimes…')).toHaveCount(0, { timeout: 10_000 })
  await page.route('**/api/v1/admin/java/scan', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ runtimes: [{ path: '/test/java-21/bin/java', version: '21.0.4', major: 21, vendor: 'Temurin', source: 'discovered' }] }),
  }))
  await page.getByRole('button', { name: 'Scan standard paths' }).click()
  await expect(page.getByText('Temurin 21')).toBeVisible()
  await page.locator('.java-inventory-card').screenshot({ path: screenshotPath('stage-04a-java-inventory-desktop.png') })
  await page.screenshot({ path: screenshotPath('stage-03-machine-desktop.png'), fullPage: true })

  await page.goto('/machine/history?month=2001-01&date=2001-01-01')
  await expect(page.getByText('No machine samples saved')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-03-history-no-data-desktop.png'), fullPage: true })
})

test('local accounts enforce administrator-only management and member access', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  await page.goto('/users')
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  await expect(page.locator('.account-users-table .data-table-row').filter({ hasText: '@stage-admin' })).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-03-users-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Add user' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a user' })
  await dialog.getByLabel('Username').fill('stage-member')
  await dialog.getByLabel('Display name').fill('Stage Member')
  await dialog.getByLabel('Initial password').fill(memberPassword)
  await dialog.getByLabel('Role').selectOption('member')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(page.locator('.account-users-table .data-table-row').filter({ hasText: '@stage-member' })).toBeVisible()

  await page.goto('/servers')
  const registeredServer = page.locator('.local-server-card-link').filter({ hasText: 'Temporary Smoke Server' })
  const registeredServerHref = await registeredServer.getAttribute('href')
  expect(registeredServerHref).toMatch(/^\/servers\/[^/]+\/overview$/)
  const registeredServerId = registeredServerHref!.split('/')[2]!
  await page.goto(`/servers/${registeredServerId}/access`)
  await expect(page.getByRole('heading', { name: 'Access policy' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Choose member account' }).selectOption({ label: 'Stage Member · @stage-member' })
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByRole('checkbox', { name: /View overview and status/ }).check()
  await page.getByRole('button', { name: 'Save permissions' }).click()
  await expect(page.getByText('Permissions saved and active immediately.')).toBeVisible()

  await signOut(page)
  await signIn(page, 'stage-member', memberPassword)
  await page.goto('/servers')
  await expect(page.getByText('Temporary Smoke Server')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Register host folder' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Import from ZIP/ })).toHaveCount(0)
  await expect(page.getByText(join(process.env['MMSMANAGER_DATA_DIR']!, 'servers', 'e2e-import'), { exact: true })).toHaveCount(0)
  await page.goto('/users')
  await expect(page.getByRole('heading', { name: 'Administrator access required' })).toBeVisible()
  const forbiddenStatus = await page.evaluate(async () => (await fetch('/api/v1/admin/users')).status)
  expect(forbiddenStatus).toBe(403)
  await page.goto('/profile')
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()
  await signOut(page)
  await signIn(page, 'stage-admin', adminPassword)
  await page.context().storageState({ path: browserSessionPath })
})

test('temporary passwords require an unskippable change on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const suffix = Date.now().toString(36)
  const username = `required-${suffix}`
  const temporaryPassword = `Temporary ${username} credential 87!`
  await page.goto('/users')
  await page.getByRole('button', { name: 'Add user' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add a user' })
  await dialog.getByLabel('Username').fill(username)
  await dialog.getByLabel('Display name').fill('Required Change Fixture')
  await dialog.getByLabel('Initial password').fill(temporaryPassword)
  await dialog.getByLabel('Role').selectOption('member')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(page.locator('.account-users-table .data-table-row').filter({ hasText: `@${username}` })).toBeVisible()

  await signOut(page)
  await page.getByLabel('Username').fill(username)
  await page.locator('input[name="password"]').fill(temporaryPassword)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/password-change$/)
  await expect(page.getByRole('heading', { name: 'Change your temporary password' })).toBeVisible()
  await page.screenshot({ path: resolve(screenshotDir, 'stage-06i-i2-required-password-desktop.png'), fullPage: true })

  await page.locator('.language-picker select').selectOption('ru')
  await expect(page.getByRole('heading', { name: 'Измените временный пароль' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'required password page at 390px')
  await page.screenshot({ path: resolve(screenshotDir, 'stage-06i-i2-required-password-ru-mobile.png'), fullPage: true })
  await page.locator('.language-picker select').selectOption('en')
  await expect(page.getByRole('heading', { name: 'Change your temporary password' })).toBeVisible()

  await page.goto('/machine')
  await expect(page).toHaveURL(/\/password-change$/)
  const form = page.locator('form.auth-form')
  const submit = form.getByRole('button', { name: 'Change password' })
  const fillForm = async (current: string, next: string, confirm = next) => {
    await form.locator('input[name="currentPassword"]').fill(current)
    await form.locator('input[name="newPassword"]').fill(next)
    await form.locator('input[name="confirmPassword"]').fill(confirm)
    await submit.click()
  }
  const proposedPassword = 'A different route credential 88!'
  await fillForm('incorrect temporary password', proposedPassword)
  await expect(page.getByRole('alert')).toContainText('current password could not be verified')
  await fillForm(temporaryPassword, temporaryPassword)
  await expect(page.getByRole('alert')).toContainText('different from the current one')
  await fillForm(temporaryPassword, proposedPassword, 'A mismatching route credential 89!')
  await expect(page.getByRole('alert')).toContainText('passwords do not match')

  const permanentPassword = `Permanent ${username} private credential 90!`
  await fillForm(temporaryPassword, permanentPassword)
  await expect(page).toHaveURL(/\/machine$/)
  await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
  const authState = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).json()) as { user: { mustChangePassword: boolean } }
  expect(authState.user.mustChangePassword).toBe(false)
})

test('profile, avatar and personal preferences persist; password change revokes the session', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  await page.goto('/profile')
  await page.screenshot({ path: screenshotPath('stage-03-profile-desktop.png'), fullPage: true })
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
  adminPassword = newPassword
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible()
  await page.context().storageState({ path: browserSessionPath })
  writeFileSync(adminPasswordPath, newPassword, { mode: 0o600 })
})

test('Stage 6H dashboard and machine layouts fit the 390/768/1280/1920px matrix', async ({ page }) => {
  await signIn(page)
  for (const width of [390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 980 })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await page.screenshot({ path: screenshotPath(`dashboard-${width}.png`), fullPage: true, animations: 'disabled' })
    await expectNoHorizontalOverflow(page, `dashboard at ${width}px`)
    const storageResponsePromise = page.waitForResponse((response) => response.url().includes('/api/v1/machine/storage') && response.status() === 200)
    await page.goto('/machine')
    await expect(page.getByRole('heading', { name: 'Machine' })).toBeVisible()
    const storageResponse = await storageResponsePromise
    const storage = await storageResponse.json() as { volumes: Array<{ roles: string[] }>; historyRetentionDays: number }
    expect(storage.historyRetentionDays).toBe(30)
    expect(storage.volumes.some((volume) => volume.roles.includes('server-data'))).toBe(true)
    await expect(page.getByText('Storage volumes', { exact: true })).toBeVisible()
    await page.screenshot({ path: screenshotPath(`machine-${width}.png`), fullPage: true, animations: 'disabled' })
    await expectNoHorizontalOverflow(page, `machine at ${width}px`)
  }
})

test('R4 language and appearance preferences switch, persist and fit mobile', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Language & appearance' }).click()
  const form = page.locator('form.appearance-form')
  const selectors = form.locator('select')
  await selectors.nth(0).selectOption('ru')
  await selectors.nth(1).selectOption('light')
  await selectors.nth(2).selectOption('blue')
  await selectors.nth(3).selectOption('compact')
  await form.locator('.account-switch').click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  await expect(page.getByRole('link', { name: /Серверы/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toBeVisible()
  await form.locator('.settings-footer button').last().click()
  await expect(page.locator('.app-frame')).toHaveClass(/theme-light.*accent-blue.*density-compact.*motion-reduced/)
  await page.screenshot({ path: screenshotPath('r4-settings-ru-desktop.png'), fullPage: true, animations: 'disabled' })

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  await expect(page.getByRole('link', { name: /Серверы/ })).toBeVisible()
  await expect(page.locator('.app-frame')).toHaveClass(/theme-light.*accent-blue.*density-compact.*motion-reduced/)
  await page.getByRole('button', { name: 'Язык и оформление' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'Russian appearance settings at 390px')
  const settingsNavFits = await page.locator('.settings-nav').evaluate((nav) => {
    const right = nav.getBoundingClientRect().right
    return [...nav.querySelectorAll('button')].every((button) => button.getBoundingClientRect().right <= right + 1 && button.getBoundingClientRect().width > 80)
  })
  expect(settingsNavFits).toBe(true)
  await page.screenshot({ path: screenshotPath('r4-settings-ru-mobile.png'), fullPage: true, animations: 'disabled' })

  await selectors.nth(0).selectOption('en')
  await selectors.nth(1).selectOption('dark')
  await selectors.nth(2).selectOption('moss')
  await selectors.nth(3).selectOption('comfortable')
  await form.locator('.account-switch').click()
  await form.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('link', { name: /Servers/ })).toBeVisible()
  await expect(page.locator('.app-frame')).toHaveClass(/theme-dark.*accent-moss.*density-comfortable/)
})

test('R4 Russian UI route matrix fits desktop and mobile layouts', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Language & appearance' }).click()
  const form = page.locator('form.appearance-form')
  await form.locator('select').nth(0).selectOption('ru')
  await form.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  const { serverId } = await mockLocalServer(page)
  const workspaceRoutes = ['/', '/servers', '/machine', '/machine/history', '/activity', '/backups', '/templates', '/users', '/profile', '/settings']
  const serverSections = ['overview', 'console', 'logs', 'players', 'mods', 'files', 'properties', 'worlds', 'runtime', 'backups', 'automation', 'access']
  const translatedChecks: Record<string, string> = {
    '/': 'История ресурсов компьютера', '/servers': 'Зарегистрированные серверы', '/machine': 'Ресурсы компьютера',
    '/activity': 'События', '/users': 'Пользователи', '/profile': 'Профиль', '/settings': 'Настройки',
    '/servers/properties': 'Свойства сервера', '/servers/console': 'Текущая консоль', '/servers/access': 'Правила доступа',
    '/servers/logs': 'Журналы процесса', '/servers/players': 'Список игроков', '/servers/mods': 'Установленные моды',
    '/servers/files': 'Файлы сервера', '/servers/worlds': 'Управление мирами', '/servers/runtime': 'Профиль запуска',
  }
  const visualWorkspaceRoutes = new Set(['/', '/servers', '/machine', '/profile', '/settings'])
  const visualServerSections = new Set(['console', 'files', 'properties', 'access'])
  for (const width of [390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
    for (const route of workspaceRoutes) {
      await page.goto(route)
      await expect(page.locator('.page-content')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
      if (translatedChecks[route]) await expect(page.locator('.page-content')).toContainText(translatedChecks[route]!)
      await expectNoHorizontalOverflow(page, `Russian ${route} at ${width}px`)
      if ((width === 390 || width === 1280) && visualWorkspaceRoutes.has(route)) {
        await page.screenshot({ path: screenshotPath(`r4-ru-${route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '-')}-${width}.png`), fullPage: true, animations: 'disabled' })
      }
    }
    for (const section of serverSections) {
      const route = `/servers/${serverId}/${section}`
      await page.goto(route)
      await expect(page.locator('.page-content')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
      const sectionCheck = translatedChecks[`/servers/${section}`]
      if (sectionCheck) await expect(page.locator('.page-content')).toContainText(sectionCheck)
      if (section === 'console' || section === 'logs') {
        await expect(page.getByLabel('Выберите сеанс процесса')).toBeVisible()
        await expect(page.getByRole('button', { name: 'Автопрокрутка включена' })).toBeVisible()
      }
      if (section === 'properties') {
        await page.getByRole('tab', { name: 'Дополнительные свойства' }).click()
        await expect(page.locator('.page-content')).toContainText('Игровой процесс')
        await expect(page.locator('.page-content')).toContainText('Разрешить полёт')
        await expect(page.getByText('Настройки сетевой привязки Minecraft отделены от локального веб-интерфейса.')).toBeVisible()
        if (width === 390 || width === 1280) await page.screenshot({ path: screenshotPath(`r6-ru-properties-advanced-${width}.png`), fullPage: true, animations: 'disabled' })
      }
      await expectNoHorizontalOverflow(page, `Russian ${section} at ${width}px`)
      if (section === 'automation' && width === 768) {
        await page.screenshot({ path: screenshotPath('i7-automation-ru-tablet-768.png'), fullPage: true, animations: 'disabled' })
      }
      if (section === 'access') await expectAccessBadgeFits(page, `Russian ${section} at ${width}px`)
      if ((width === 390 || width === 1280) && visualServerSections.has(section)) {
        await page.screenshot({ path: screenshotPath(`r4-ru-server-${section}-${width}.png`), fullPage: true, animations: 'disabled' })
      }
    }
  }
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Язык и оформление' }).click()
  const restoreForm = page.locator('form.appearance-form')
  await restoreForm.locator('select').nth(0).selectOption('en')
  await restoreForm.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})

test('I3 accent palettes reach dashboard, servers, access, properties, settings, charts and dialogs', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/settings')
  await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
  const initialAppearance = page.locator('form.appearance-form')
  await initialAppearance.locator('select').nth(0).selectOption('en')
  await initialAppearance.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  const { serverId } = await mockLocalServer(page)
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const point = (offsetMs: number, cpu: number) => ({
    observedAt: new Date(nowMs - offsetMs).toISOString(), sampleCount: 1, cpuSampleCount: 1, networkSampleCount: 1,
    bucketSeconds: 10, coveragePercent: 100, cpuPercent: cpu, memoryUsedBytes: 2_000_000_000,
    memoryTotalBytes: 8_000_000_000, memoryPercent: 25, storageUsedBytes: 4_000_000_000,
    storageTotalBytes: 16_000_000_000, storagePercent: 25, rxBytesPerSecond: 10, txBytesPerSecond: 5,
  })
  const historyPoints = [point(10_000, 20), point(5_000, 30)]
  await page.route('**/api/v1/machine/current', (route) => route.fulfill({ json: {
    status: 'live', timeZone: 'UTC', intervalMs: 1000, provenance: 'LOCAL_HOST', lastSuccessfulAt: now,
    host: { id: 'local', hostname: 'fixture-host', platform: 'linux', distro: 'Fixture Linux', release: '1', architecture: 'x64', cpuModel: 'Fixture CPU', coreCount: 4, uptimeSeconds: 3600, source: 'systeminformation' },
    sample: { id: 1, collectedAt: now, cpuPercent: 35, coreCount: 4, loadAverage: { one: 0.2, five: 0.3, fifteen: 0.4 },
      memory: { usedBytes: 2_000_000_000, availableBytes: 6_000_000_000, totalBytes: 8_000_000_000, swapUsedBytes: null, swapTotalBytes: null, usedPercent: 25 },
      storage: { device: null, mount: null, usedBytes: 4_000_000_000, availableBytes: 12_000_000_000, totalBytes: 16_000_000_000, usedPercent: 25 },
      network: { interface: 'fixture0', rxBytesPerSecond: 10, txBytesPerSecond: 5, rxTransferredBytes: 100, txTransferredBytes: 50 }, sampleStatus: 'ok', unavailableFields: [], source: 'systeminformation' },
  } }))
  await page.route('**/api/v1/machine/history?**', (route) => route.fulfill({ json: { from: new Date(nowMs - 86_400_000).toISOString(), to: now, timeZone: 'UTC', resolution: 'raw', bucketSeconds: 10, coveragePercent: 100, points: historyPoints } }))
  await page.route('**/api/v1/machine/storage', (route) => route.fulfill({ json: { volumes: [], history: [], historyRetentionDays: 30 } }))
  const accessPermissions = { viewServer: true, viewLogs: true, sendConsoleCommands: false, controlLifecycle: false, startServer: true, stopServer: true, restartServer: true, viewPlayers: true, moderatePlayers: false, viewMods: true, manageMods: false, viewFiles: true, manageFiles: false, viewSettings: true, manageSettings: false, viewWorlds: true, viewBackups: true, createBackups: false }
  await page.route(`**/api/v1/admin/servers/${serverId}/access`, (route) => route.fulfill({ json: { users: [{ userId: 'b13c1cf8-e2a1-4a4e-9de4-4536c7796091', username: 'i3-member', displayName: 'I3 Member', role: 'member', enabled: true, permissions: accessPermissions }] } }))

  const tokenColor = async (token: string) => page.locator('.app-frame').evaluate((frame, name) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    frame.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, token)
  const tokenBackground = async (token: string) => page.locator('.app-frame').evaluate((frame, name) => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = `var(${name})`
    frame.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, token)
  const palettes = [
    { name: 'moss', rgb: 'rgb(186, 211, 154)' },
    { name: 'blue', rgb: 'rgb(150, 188, 232)' },
    { name: 'clay', rgb: 'rgb(209, 160, 139)' },
  ] as const

  for (const palette of palettes) {
    await page.goto('/settings')
    await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
    const form = page.locator('form.appearance-form')
    await form.locator('select').nth(1).selectOption('dark')
    await form.locator('select').nth(2).selectOption(palette.name)
    await form.getByRole('button', { name: 'Save preferences' }).click()
    await expect(page.locator('.app-frame')).toHaveClass(new RegExp(`accent-${palette.name}`))
    expect(await tokenColor('--accent')).toBe(palette.rgb)
    const accentColor = await tokenColor('--accent')
    const accentStrong = await tokenColor('--accent-strong')
    const accentSoft = await tokenColor('--accent-soft')
    const accentBorder = await tokenColor('--accent-border')
    const sidebarSurface = await tokenBackground('--sidebar')
    const cardSurface = await tokenBackground('--surface')
    const raisedSurface = await tokenBackground('--surface-raised')
    const inputSurface = await tokenBackground('--surface-input')

    await page.goto('/')
    await expect(page.locator('.live-chart-line')).toHaveCount(1)
    await expect(page.locator('.overview-icon').first()).toBeVisible()
    expect(await page.locator('.live-chart-line').evaluate((line) => getComputedStyle(line).stroke)).toBe(accentColor)
    expect(await page.locator('.overview-icon').first().evaluate((icon) => getComputedStyle(icon).color)).toBe(accentStrong)
    expect(await page.locator('.sidebar').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(sidebarSurface)
    expect(await page.locator('.page-content .card').first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(cardSurface)
    expect(await page.locator('.nav-link.active').first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(accentSoft)
    expect(await page.locator('.nav-link.active').first().evaluate((element) => getComputedStyle(element).borderColor)).toBe(accentBorder)
    await page.screenshot({ path: screenshotPath(`i3-dashboard-${palette.name}-desktop.png`), fullPage: true, animations: 'disabled' })

    await page.goto('/servers')
    const serverIcon = page.locator('.local-server-icon').first()
    await expect(serverIcon).toBeVisible()
    expect(await serverIcon.evaluate((icon) => getComputedStyle(icon).color)).toBe(accentStrong)
    expect(await serverIcon.evaluate((icon) => getComputedStyle(icon).backgroundColor)).toBe(accentSoft)
    expect(await serverIcon.evaluate((icon) => getComputedStyle(icon).borderColor)).toBe(accentBorder)
    if (palette.name === 'clay') {
      await page.goto(`/servers/${serverId}/overview`)
      await expect(page.locator('.server-detail-tabs a.active')).toBeVisible()
      await page.screenshot({ path: screenshotPath('focused-clay-server-desktop.png'), fullPage: true, animations: 'disabled' })
    }

    await page.goto(`/servers/${serverId}/access`)
    const activeServerTab = page.locator('.server-detail-tabs a.active')
    expect(await activeServerTab.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(accentSoft)
    expect(await activeServerTab.evaluate((element) => getComputedStyle(element).borderColor)).toBe(accentBorder)
    await page.getByRole('button', { name: 'Advanced' }).click()
    const permissionToggle = page.locator('.access-permission-row input[type="checkbox"]').first()
    await expect(permissionToggle).toBeVisible()
    expect(await permissionToggle.evaluate((element) => getComputedStyle(element).accentColor)).toBe(accentColor)

    await page.goto(`/servers/${serverId}/properties`)
    expect(await page.locator('.properties-search').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(inputSurface)
    const enabledProperty = page.locator('.property-toggle input:checked + span').first()
    await expect(enabledProperty).toBeVisible()
    expect(await enabledProperty.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(accentColor)
    await page.screenshot({ path: screenshotPath(`i3-properties-${palette.name}-desktop.png`), fullPage: true, animations: 'disabled' })

    await page.goto('/settings')
    await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
    expect(await page.locator('.settings-nav button.selected').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(accentSoft)
    expect(await page.locator('.appearance-form select').first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(inputSurface)
    expect(await page.locator('.appearance-form button.button-secondary').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(raisedSurface)
    if (palette.name === 'blue') await page.screenshot({ path: screenshotPath('focused-blue-settings-desktop.png'), fullPage: true, animations: 'disabled' })
    const save = page.locator('form.appearance-form').getByRole('button', { name: 'Save preferences' })
    await save.hover()
    await expect.poll(() => save.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(await tokenColor('--accent-hover'))

    if (palette.name === 'moss' || palette.name === 'blue') {
      await page.goto('/machine')
      const rangeGroup = page.getByRole('group', { name: 'History range' })
      await rangeGroup.getByRole('button', { name: '15m' }).click()
      await expect(page.locator('.live-chart-line')).toHaveCount(1)
      expect(await page.locator('.live-chart-line').evaluate((line) => getComputedStyle(line).stroke)).toBe(accentColor)
      await page.screenshot({ path: screenshotPath(`focused-chart-${palette.name}-15m-desktop.png`), fullPage: true, animations: 'disabled' })
      await rangeGroup.getByRole('button', { name: '7d' }).click()
      await expect(page.locator('.live-chart-line')).toHaveCount(1)
      await page.screenshot({ path: screenshotPath(`focused-chart-${palette.name}-7d-desktop.png`), fullPage: true, animations: 'disabled' })
    }

    await page.goto('/')
    await page.locator('.top-create').click()
    const dialog = page.getByRole('dialog', { name: 'Create server' })
    await expect(dialog).toBeVisible()
    expect(await dialog.locator('.wizard-kicker-icon').evaluate((icon) => getComputedStyle(icon).color)).toBe(accentStrong)
    expect(await dialog.locator('.wizard-kicker-icon').evaluate((icon) => getComputedStyle(icon).backgroundColor)).toBe(accentSoft)
    await page.screenshot({ path: screenshotPath(`i3-create-dialog-${palette.name}-desktop.png`), animations: 'disabled' })
    await dialog.getByRole('button').first().click()
  }

  await page.goto('/settings')
  await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
  const lightForm = page.locator('form.appearance-form')
  await lightForm.locator('select').nth(1).selectOption('light')
  await lightForm.locator('select').nth(2).selectOption('clay')
  await lightForm.getByRole('button', { name: 'Save preferences' }).click()
  await expect(page.locator('.app-frame')).toHaveClass(/theme-light.*accent-clay/)
  expect(await tokenColor('--accent')).toBe('rgb(153, 94, 67)')
  await page.goto('/')
  await expect(page.locator('.live-chart-line')).toHaveCount(1)
  expect(await page.locator('.live-chart-line').evaluate((line) => getComputedStyle(line).stroke)).toBe('rgb(153, 94, 67)')
  await page.screenshot({ path: screenshotPath('i3-dashboard-clay-light-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.goto(`/servers/${serverId}/danger-zone`)
  expect(await page.locator('.server-detail-title h1').evaluate((heading) => getComputedStyle(heading).color)).toBe(await tokenColor('--text'))
})

test('accent status and surface tokens cover all palettes in dark and light themes', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  const palettes = [
    { name: 'moss', dark: 'rgb(186, 211, 154)', light: 'rgb(82, 107, 63)' },
    { name: 'blue', dark: 'rgb(150, 188, 232)', light: 'rgb(65, 107, 157)' },
    { name: 'clay', dark: 'rgb(209, 160, 139)', light: 'rgb(153, 94, 67)' },
  ] as const
  const tokenColor = (token: string) => page.locator('.app-frame').evaluate((frame, name) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    frame.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, token)
  const tokenBackground = (token: string) => page.locator('.app-frame').evaluate((frame, name) => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = `var(${name})`
    frame.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  }, token)

  for (const palette of palettes) {
    for (const theme of ['dark', 'light'] as const) {
      await page.goto('/settings')
      await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
      const form = page.locator('form.appearance-form')
      await form.locator('select').nth(0).selectOption('en')
      await form.locator('select').nth(1).selectOption(theme)
      await form.locator('select').nth(2).selectOption(palette.name)
      const save = form.getByRole('button', { name: 'Save preferences' })
      await save.hover()
      await expect.poll(() => save.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(await tokenColor('--accent-hover'))
      await save.click()
      await expect(page.locator('.app-frame')).toHaveClass(new RegExp(`accent-${palette.name}`))
      if (theme === 'light') await expect(page.locator('.app-frame')).toHaveClass(/theme-light/)
      else await expect(page.locator('.app-frame')).not.toHaveClass(/theme-light/)
      expect(await tokenColor('--accent')).toBe(palette[theme])

      const positiveBadge = await page.locator('.app-frame').evaluate((frame) => {
        const probe = document.createElement('span')
        probe.className = 'badge badge-good'
        frame.append(probe)
        const style = getComputedStyle(probe)
        const result = { color: style.color, background: style.backgroundColor, border: style.borderColor }
        probe.remove()
        return result
      })
      expect(positiveBadge).toEqual({ color: await tokenColor('--accent-strong'), background: await tokenBackground('--accent-soft'), border: await tokenColor('--accent-border') })
      const onlineDot = await page.locator('.app-frame').evaluate((frame) => {
        const probe = document.createElement('span')
        probe.className = 'status-dot status-online'
        frame.append(probe)
        const color = getComputedStyle(probe).backgroundColor
        probe.remove()
        return color
      })
      expect(onlineDot).toBe(palette[theme])

      await page.goto('/')
      await expect(page.locator('.page-content')).toBeVisible()
      expect(await page.locator('.sidebar').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(await tokenBackground('--sidebar'))
      expect(await page.locator('.page-content .card').first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(await tokenBackground('--surface'))
      await page.screenshot({ path: screenshotPath(`palette-${theme}-${palette.name}-dashboard.png`), fullPage: true, animations: 'disabled' })
      await page.keyboard.press('Control+k')
      await expect(page.getByRole('dialog', { name: 'Search pages' })).toBeVisible()
      if (palette.name !== 'moss') {
        const greenStyles = await findUnaccentedGreenUi(page)
        expect(greenStyles, `${theme}/${palette.name} quick search retained green styling: ${greenStyles.join('; ')}`).toEqual([])
      }
      await page.keyboard.press('Escape')
    }
  }

  await page.route('**/api/v1/notifications**', (route) => route.fulfill({ json: { items: [], unreadCount: 0 } }))
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Language & appearance' }).click()
  const russianForm = page.locator('form.appearance-form')
  await russianForm.locator('select').nth(0).selectOption('ru')
  await russianForm.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Уведомления' }).click()
  await expect(page.locator('.notification-toolbar .badge')).toHaveText('0 непрочитанных уведомлений')

  await page.goto('/settings')
  await page.getByRole('button', { name: 'Язык и оформление' }).click()
  const resetForm = page.locator('form.appearance-form')
  await resetForm.locator('select').nth(0).selectOption('en')
  await resetForm.locator('select').nth(1).selectOption('dark')
  await resetForm.locator('select').nth(2).selectOption('moss')
  await resetForm.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.locator('.app-frame')).not.toHaveClass(/theme-light/)
  await expect(page.locator('.app-frame')).toHaveClass(/accent-moss/)
})

test('blue and clay dark themes have no stray green on workspace and server routes', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  const { serverId } = await mockLocalServer(page)
  const routes = [
    '/', '/servers', '/machine', '/machine/history', '/activity', '/backups', '/templates', '/users', '/profile', '/settings',
    ...['overview', 'console', 'logs', 'players', 'mods', 'files', 'properties', 'worlds', 'runtime', 'backups', 'automation', 'access', 'danger-zone'].map((section) => `/servers/${serverId}/${section}`),
  ]
  for (const palette of ['blue', 'clay'] as const) {
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Language & appearance' }).click()
    const form = page.locator('form.appearance-form')
    await form.locator('select').nth(0).selectOption('en')
    await form.locator('select').nth(1).selectOption('dark')
    await form.locator('select').nth(2).selectOption(palette)
    await form.getByRole('button', { name: 'Save preferences' }).click()
    for (const route of routes) {
      await page.goto(route)
      await expect(page.locator('.page-content')).toBeVisible()
      const greenStyles = await findUnaccentedGreenUi(page)
      expect(greenStyles, `dark/${palette} ${route} retained green styling: ${greenStyles.join('; ')}`).toEqual([])
      if (route.endsWith('/properties')) {
        const enabledProperty = page.locator('.property-toggle input:checked + span').first()
        await expect(enabledProperty).toBeVisible()
        expect(await enabledProperty.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(palette === 'blue' ? 'rgb(150, 188, 232)' : 'rgb(209, 160, 139)')
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.locator('.page-content')).toBeVisible()
    await page.screenshot({ path: screenshotPath(`palette-dark-${palette}-mobile.png`), fullPage: true, animations: 'disabled' })
    const greenStyles = await findUnaccentedGreenUi(page)
    expect(greenStyles, `mobile dark/${palette} dashboard retained green styling: ${greenStyles.join('; ')}`).toEqual([])
    await page.getByRole('button', { name: 'Open navigation' }).click()
    expect(await findUnaccentedGreenUi(page)).toEqual([])
  }
})

test('blue and clay light themes have no stray green on workspace and server routes', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  const { serverId } = await mockLocalServer(page)
  const routes = [
    '/', '/servers', '/machine', '/machine/history', '/activity', '/backups', '/templates', '/users', '/profile', '/settings',
    ...['overview', 'console', 'logs', 'players', 'mods', 'files', 'properties', 'worlds', 'runtime', 'backups', 'automation', 'access', 'danger-zone'].map((section) => `/servers/${serverId}/${section}`),
  ]
  for (const palette of ['blue', 'clay'] as const) {
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Language & appearance' }).click()
    const form = page.locator('form.appearance-form')
    await form.locator('select').nth(0).selectOption('en')
    await form.locator('select').nth(1).selectOption('light')
    await form.locator('select').nth(2).selectOption(palette)
    await form.getByRole('button', { name: 'Save preferences' }).click()
    for (const route of routes) {
      await page.goto(route)
      await expect(page.locator('.page-content')).toBeVisible()
      const greenStyles = await findUnaccentedGreenUi(page)
      expect(greenStyles, `light/${palette} ${route} retained green styling: ${greenStyles.join('; ')}`).toEqual([])
      if (route.endsWith('/properties')) {
        const enabledProperty = page.locator('.property-toggle input:checked + span').first()
        await expect(enabledProperty).toBeVisible()
        expect(await enabledProperty.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(palette === 'blue' ? 'rgb(65, 107, 157)' : 'rgb(153, 94, 67)')
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.locator('.page-content')).toBeVisible()
    await page.screenshot({ path: screenshotPath(`palette-light-${palette}-mobile.png`), fullPage: true, animations: 'disabled' })
    const greenStyles = await findUnaccentedGreenUi(page)
    expect(greenStyles, `mobile light/${palette} dashboard retained green styling: ${greenStyles.join('; ')}`).toEqual([])
    await page.getByRole('button', { name: 'Open navigation' }).click()
    expect(await findUnaccentedGreenUi(page)).toEqual([])
  }
})

test('I3 Russian workspace routes contain no untranslated interface copy', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Language & appearance' }).click()
  const settingsForm = page.locator('form.appearance-form')
  await settingsForm.locator('select').nth(0).selectOption('ru')
  await settingsForm.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  await page.keyboard.press('Control+k')
  const quickSearch = page.getByRole('dialog', { name: 'Поиск страниц' })
  await expect(quickSearch).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Поиск страниц и серверов' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(quickSearch).toHaveCount(0)
  const { serverId } = await mockLocalServer(page)
  const routes = ['/', '/servers', '/machine', '/machine/history', '/activity', '/backups', '/templates', '/users', '/profile', '/settings', ...['overview', 'console', 'logs', 'players', 'mods', 'files', 'properties', 'worlds', 'runtime', 'backups', 'automation', 'access', 'danger-zone'].map((section) => `/servers/${serverId}/${section}`)]
  const unmapped: Array<{ route: string; value: string; source: string }> = []
  for (const route of routes) {
    await page.goto(route)
    await expect(page.locator('.page-content')).toBeVisible()
    const candidates = await page.locator('.app-frame').evaluate((frame) => {
      const result: Array<{ value: string; source: string }> = []
      const excluded = '[data-no-translate],script,style,textarea,code,pre,.console-line,.console-output,.log-line,.log-output,.log-message,.player-name,.local-player-names,.file-name,.local-file-name,.local-world-name,.property-key,.property-value'
      const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const value = node.nodeValue?.replace(/\s+/g, ' ').trim() ?? ''
        if (value && /[A-Za-z]{2}/.test(value) && !node.parentElement?.closest(excluded)) result.push({ value, source: `${node.parentElement?.tagName.toLowerCase()}.${String(node.parentElement?.className ?? '').replace(/\s+/g, '.')}` })
        node = walker.nextNode()
      }
      for (const element of frame.querySelectorAll<HTMLElement>('*')) {
        if (element.closest(excluded)) continue
        for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
          const value = element.getAttribute(attribute)?.replace(/\s+/g, ' ').trim()
          if (value && /[A-Za-z]{2}/.test(value)) result.push({ value, source: `${element.tagName.toLowerCase()}.${String(element.className ?? '').replace(/\s+/g, '.')}:${attribute}` })
        }
      }
      return result
    })
    for (const candidate of candidates) if (!isLocalizedText(candidate.value, 'ru')) unmapped.push({ route, ...candidate })
  }
  const uniqueUnmapped = [...new Map(unmapped.map((item) => [item.value, item])).values()]
  expect(uniqueUnmapped.slice(0, 120), `Unmapped Russian interface strings (${uniqueUnmapped.length} unique): ${JSON.stringify(uniqueUnmapped.slice(0, 120), null, 2)}`).toEqual([])
})

test('I3 Member Russian routes preserve permission boundaries and translated labels', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  const username = `i3-member-${Date.now().toString(36)}`
  const temporaryPassword = `Temporary ${username} fixture 68!`
  await page.goto('/users')
  await page.getByRole('button', { name: 'Add user' }).click()
  const createDialog = page.getByRole('dialog', { name: 'Add a user' })
  await createDialog.getByLabel('Username').fill(username)
  await createDialog.getByLabel('Display name').fill('I3 Member Fixture')
  await createDialog.getByLabel('Initial password').fill(temporaryPassword)
  await createDialog.getByLabel('Role').selectOption('member')
  await createDialog.getByRole('button', { name: 'Create user' }).click()
  await expect(page.locator('.account-users-table .data-table-row').filter({ hasText: `@${username}` })).toBeVisible()

  const { serverId } = await mockLocalServer(page)
  const permissions = {
    viewServer: true, viewLogs: true, sendConsoleCommands: false, controlLifecycle: false,
    startServer: true, stopServer: true, restartServer: true, viewPlayers: true, moderatePlayers: true,
    viewMods: true, manageMods: true, viewFiles: true, manageFiles: true, viewSettings: true,
    manageSettings: true, viewWorlds: true, viewBackups: true, createBackups: true,
  }
  await page.route(`**/api/v1/servers/${serverId}/access`, (route) => route.fulfill({ json: { administrator: false, permissions } }))
  await signOut(page)
  await signIn(page, username, temporaryPassword)
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Language & appearance' }).click()
  const form = page.locator('form.appearance-form')
  await form.locator('select').nth(0).selectOption('ru')
  await form.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')

  const routes = ['/', '/servers', '/machine', '/machine/history', '/activity', '/profile', '/settings', '/users', '/templates', '/backups', ...['overview', 'console', 'logs', 'players', 'mods', 'files', 'properties', 'worlds', 'backups', 'access'].map((section) => `/servers/${serverId}/${section}`)]
  const candidates: Array<{ route: string; value: string; source: string }> = []
  for (const route of routes) {
    await page.goto(route)
    await expect(page.locator('.page-content')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
    const routeCandidates = await page.locator('.app-frame').evaluate((frame) => {
      const result: Array<{ value: string; source: string }> = []
      const excluded = '[data-no-translate],script,style,textarea,code,pre,.console-line,.console-output,.log-line,.log-output,.log-message,.player-name,.local-player-names,.file-name,.local-file-name,.local-world-name,.property-key,.property-value'
      const walker = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const value = node.nodeValue?.replace(/\s+/g, ' ').trim() ?? ''
        if (value && /[A-Za-z]{2}/.test(value) && !node.parentElement?.closest(excluded)) result.push({ value, source: `${node.parentElement?.tagName.toLowerCase()}.${String(node.parentElement?.className ?? '').replace(/\s+/g, '.')}` })
        node = walker.nextNode()
      }
      for (const element of frame.querySelectorAll<HTMLElement>('*')) {
        if (element.closest(excluded)) continue
        for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
          const value = element.getAttribute(attribute)?.replace(/\s+/g, ' ').trim()
          if (value && /[A-Za-z]{2}/.test(value)) result.push({ value, source: `${element.tagName.toLowerCase()}.${String(element.className ?? '').replace(/\s+/g, '.')}:${attribute}` })
        }
      }
      return result
    })
    for (const candidate of routeCandidates) if (!isLocalizedText(candidate.value, 'ru')) candidates.push({ route, ...candidate })
  }
  const uniqueCandidates = [...new Map(candidates.map((item) => [item.value, item])).values()]
  expect(uniqueCandidates.slice(0, 120), `Unmapped Russian Member UI strings (${uniqueCandidates.length} unique): ${JSON.stringify(uniqueCandidates.slice(0, 120), null, 2)}`).toEqual([])
  await page.goto(`/servers/${serverId}/access`)
  await expect(page.getByRole('heading', { name: 'Ваши права на сервер' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Choose member account' })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'I3 Russian Member access at 390px')
  await page.screenshot({ path: screenshotPath('i3-member-access-ru-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('Stage 6H user deletion requires typed confirmation and preserves audit history', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/users')
  const username = `delete-${Date.now()}`
  await page.getByRole('button', { name: 'Add user' }).click()
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Display name').fill('Temporary Reviewer')
  await page.getByLabel('Initial password').fill('synthetic temporary member passphrase 35!')
  await page.getByRole('button', { name: 'Create user' }).click()
  const row = page.locator('.account-users-table .account-user-row').filter({ hasText: username })
  await expect(row).toBeVisible()
  await expect(page.getByRole('button', { name: 'Delete stage-admin' })).toBeDisabled()
  await row.getByRole('button', { name: `Delete ${username}` }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete Temporary Reviewer?' })
  await expect(dialog).toBeVisible()
  const confirmation = page.getByLabel(`Type ${username} to confirm`)
  const deleteButton = dialog.getByRole('button', { name: 'Delete account' })
  await expect(deleteButton).toBeDisabled()
  await page.screenshot({ path: screenshotPath('user-delete-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'user deletion dialog at 390px')
  await page.screenshot({ path: screenshotPath('user-delete-mobile.png'), animations: 'disabled' })
  await confirmation.fill(username)
  await expect(deleteButton).toBeEnabled()
  await deleteButton.click()
  await expect(page.locator('.account-notice')).toContainText('was deleted')
  await expect(page.locator('.account-users-table .account-user-row').filter({ hasText: username })).toHaveCount(0)
  await expect(page.locator('.audit-list')).toContainText('User deleted')
})

test('R9 ZIP import preview and publish are localized and responsive', async ({ page }) => {
  await signIn(page)
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/settings')
  await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
  const appearance = page.locator('form.appearance-form')
  await appearance.locator('select').nth(0).selectOption('ru')
  await appearance.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')

  const { serverId } = await mockLocalServer(page, 'stopped')
  const token = 'a03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const preview = {
    token, uploadName: 'bundle.zip', compressedBytes: 1024, extractedBytes: 4096, entryCount: 5, fileCount: 4,
    rootFolder: 'bundle', software: 'vanilla', version: '1.21.4', requiredJavaMajor: 21, jarName: 'server.jar',
    port: 25565, eula: 'not-accepted', worldFolders: ['world'], supported: true, unsupportedReason: null,
    excludedPaths: ['__MACOSX/._server.jar'], excludedPathsTruncated: false,
    warnings: ['This archive can contain server JARs and mods. Import only files you trust; MMSManager will not execute them during import.'],
  }
  await page.route('**/api/v1/admin/server-imports/zip', async (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers()['content-type']).toContain('multipart/form-data')
    await route.fulfill({ status: 201, json: { preview } })
  })
  const importedServer = {
    id: 'f03c1cf8-e2a1-4a4e-9de4-4536c7796091', name: 'Пробный сервер', source: 'created', software: 'vanilla',
    version: '1.21.4', jarName: 'server.jar', javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096,
    port: 25565, portStatus: 'valid', portErrorCode: null, eula: 'accepted', managed: true, worldFolders: ['world'], createdAt: new Date().toISOString(), runtimeStatus: 'stopped',
  }
  let publishBody: Record<string, unknown> | null = null
  await page.route(`**/api/v1/admin/server-imports/${token}/publish`, async (route) => {
    publishBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 201, json: { server: importedServer, importState: 'published', started: true, startError: null } })
  })

  await page.goto('/servers')
  await page.getByRole('button', { name: 'Импорт из ZIP' }).click()
  const dialog = page.getByRole('dialog', { name: 'Импорт архива сервера' })
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'bundle.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture only') })
  await expect(dialog.getByText('Supported server')).toHaveCount(0)
  await expect(dialog.getByText('Поддерживаемый сервер')).toBeVisible()
  await expect(dialog.getByText('Исключённые служебные файлы')).toBeVisible()
  await expect(dialog.getByText('Я доверяю этому JAR-файлу сервера и его модам')).toBeVisible()
  await expect(dialog.locator('.server-zip-java-row select')).toContainText('Java 21 · Temurin (21.0.4)')
  await expect(dialog.locator('.server-zip-java-row select')).not.toContainText('/tmp/')
  await page.screenshot({ path: screenshotPath('stage-06hr-r9-zip-preview-ru-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'Russian ZIP import preview at 390px')
  await page.screenshot({ path: screenshotPath('stage-06hr-r9-zip-preview-ru-mobile.png'), fullPage: true, animations: 'disabled' })

  await dialog.getByLabel('Название сервера').fill('Пробный сервер')
  await dialog.locator('.server-zip-check').nth(0).click()
  await dialog.locator('.server-zip-check').nth(1).click()
  await dialog.locator('.server-zip-check').nth(2).click()
  await dialog.getByRole('button', { name: 'Импортировать сервер' }).click()
  await expect(dialog.getByText('Сервер импортирован')).toBeVisible()
  await expect.poll(() => publishBody).toMatchObject({ token, name: 'Пробный сервер', acceptEula: true, trustExecutable: true, startAfterImport: true })
  await expect(dialog.getByText('Запрос на запуск сервера отправлен.')).toBeVisible()
  expect(serverId).toBe('e03c1cf8-e2a1-4a4e-9de4-4536c7796091')
})

test('R9 permanent server removal requires typed confirmation in Russian on mobile', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.profile-trigger')).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/settings')
  await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
  const appearance = page.locator('form.appearance-form')
  await appearance.locator('select').nth(0).selectOption('ru')
  await appearance.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  const { serverId } = await mockLocalServer(page, 'stopped')
  let removalBody: Record<string, unknown> | null = null
  await page.route(`**/api/v1/admin/servers/${serverId}/remove`, async (route) => {
    removalBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { operation: {
      id: 'a13c1cf8-e2a1-4a4e-9de4-4536c7796091', serverId, serverName: 'Local Fixture', mode: 'permanent', state: 'purged',
      errorCode: null, errorMessage: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } } })
  })
  await page.goto('/servers')
  await page.getByRole('link', { name: /Local Fixture/ }).click()
  await page.getByRole('link', { name: 'Опасная зона' }).click()
  await page.screenshot({ path: screenshotPath('focused-danger-zone-ru-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'Russian danger zone at 390px')
  await page.screenshot({ path: screenshotPath('focused-danger-zone-ru-mobile.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: 'Навсегда удалить сервер' }).click()
  const dialog = page.getByRole('dialog', { name: 'Навсегда удалить файлы сервера' })
  const confirmation = dialog.getByRole('textbox')
  const deleteButton = dialog.getByRole('button', { name: 'Удалить безвозвратно' })
  await expect(deleteButton).toBeDisabled()
  await page.screenshot({ path: screenshotPath('stage-06hr-r9-server-remove-ru-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'Russian server removal dialog at 390px')
  await page.screenshot({ path: screenshotPath('stage-06hr-r9-server-remove-ru-mobile.png'), animations: 'disabled' })
  await confirmation.fill('Local Fixture')
  await dialog.locator('.server-removal-confirm-check').click()
  await expect(deleteButton).toBeEnabled()
  await deleteButton.click()
  await expect(page).toHaveURL(/\/servers$/)
  await expect.poll(() => removalBody).toEqual({ mode: 'permanent', confirmation: 'Local Fixture' })
})

test('administrator reviews a Russian warning before streaming a stopped server ZIP export', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.profile-trigger')).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto('/settings')
  await page.getByRole('button', { name: /^(Language & appearance|Язык и оформление)$/ }).click()
  const appearance = page.locator('form.appearance-form')
  await appearance.locator('select').nth(0).selectOption('ru')
  await appearance.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  const { serverId } = await mockLocalServer(page, 'stopped')
  let exportRequested = false
  await page.route(`**/api/v1/admin/servers/${serverId}/export.zip`, async (route) => {
    exportRequested = true
    await route.fulfill({
      status: 200,
      contentType: 'application/zip',
      headers: { 'content-disposition': `attachment; filename="server-${serverId.slice(0, 8)}.zip"; filename*=UTF-8''Local%20Fixture-${serverId.slice(0, 8)}.zip` },
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    })
  })
  await page.goto(`/servers/${serverId}/files`)
  const exportButton = page.getByRole('button', { name: 'Скачать сервер' })
  await expect(exportButton).toBeVisible()
  await exportButton.click()
  const dialog = page.getByRole('dialog', { name: 'Подготовить архив сервера' })
  await expect(dialog.getByText(/пароли или личные данные/)).toBeVisible()
  await expect(dialog.getByText(/База панели, сеансы, секреты приложения/)).toBeVisible()
  await page.screenshot({ path: screenshotPath('focused-server-export-ru-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoHorizontalOverflow(page, 'Russian server export warning at 390px')
  await page.screenshot({ path: screenshotPath('focused-server-export-ru-mobile.png'), fullPage: true, animations: 'disabled' })
  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Скачать ZIP' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(`Local Fixture-${serverId.slice(0, 8)}.zip`)
  expect(exportRequested).toBe(true)
})
