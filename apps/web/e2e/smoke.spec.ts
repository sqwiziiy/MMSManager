import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const screenshotDir = resolve(process.env['MMSMANAGER_E2E_SCREENSHOT_DIR'] ?? resolve(process.cwd(), '../../reports/screenshots'))
function screenshotPath(name: string): string { return resolve(screenshotDir, `stage-06h-${name}`) }
mkdirSync(screenshotDir, { recursive: true })

let adminPassword = process.env['MMSMANAGER_E2E_ADMIN_PASSWORD']!
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

async function mockLocalServer(page: Page, runtimeStatus = 'running') {
  const serverId = 'e03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const backupId = 'c03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  const now = new Date().toISOString()
  const server = { id: serverId, name: 'Local Fixture', source: 'created', software: 'paper', version: '1.21.4', jarName: 'server.jar', javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096, port: 25565, eula: 'accepted', managed: true, worldFolders: ['world'], createdAt: now, runtimeStatus }
  let settings = { onlineMode: true, motd: 'A local fixture', gameMode: 'survival', difficulty: 'normal', maxPlayers: 20, viewDistance: 10, simulationDistance: 8, spawnProtection: 16, pvp: true, whiteList: false, allowNether: true }
  let restartRequired = false
  let runtimeSettings = {
    serverId, javaPath: '/tmp/mmsmanager-e2e-java-21', javaMajor: 21, requiredJavaMajor: 21,
    minMemoryMb: 1024, maxMemoryMb: 4096,
    jvmOptions: { collector: 'default' as const, maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false },
    compatibility: 'compatible' as const, runtimeStatus, restartRequired: false, startScript: 'synchronized' as const,
  }
  const missedJobId = 'd03c1cf8-e2a1-4a4e-9de4-4536c7796091'
  let automation = {
    serverId, enabled: false, frequency: 'daily' as const, localTime: '03:00', weekday: null,
    timeZone: 'Europe/Paris', nextRunAt: null, lastRunAt: now, lastStatus: 'missed' as const,
    lastError: 'The API was unavailable past the catch-up window. No backup was run.', unacknowledgedCount: 1,
    jobs: [{ id: missedJobId, kind: 'backup' as const, scheduledFor: now, status: 'missed' as const, startedAt: null, finishedAt: now, backupId: null, errorMessage: 'The API was unavailable past the catch-up window. No backup was run.', acknowledgedAt: null, createdAt: now }],
  }
  const properties = () => ({ settings, unknownKeys: ['online-mode', 'server-ip', 'level-seed'], backups: restartRequired ? [{ id: backupId, createdAt: now, sha256: 'a'.repeat(64) }] : [], restartRequired })
  const consoleResponse = { entries: [
    { id: 1, occurredAt: now, source: 'system', severity: 'info', message: 'MMSManager launched this local process.' },
    { id: 2, occurredAt: now, source: 'stdout', severity: 'info', message: 'Done (1.2s)! For help, type "help"' },
  ], nextAfter: null }
  await page.route('**/api/v1/servers', (route) => route.fulfill({ json: { servers: [server] } }))
  await page.route('**/api/v1/admin/servers', (route) => route.fulfill({ json: { servers: [{ ...server, directory: '/tmp/mmsmanager-e2e/local-fixture', javaPath: '/tmp/fake-java' }], managedRoot: '/tmp/mmsmanager-e2e/servers', importRoots: ['/tmp/mmsmanager-e2e/servers'] } }))
  await page.route('**/api/v1/admin/java', (route) => route.fulfill({ json: { runtimes: [{ path: '/tmp/mmsmanager-e2e-java-21', version: '21.0.4', major: 21, vendor: 'Temurin', source: 'discovered' }] } }))
  await page.route(`**/api/v1/admin/servers/${serverId}/runtime-settings`, async (route) => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON() as Omit<typeof runtimeSettings, 'serverId' | 'javaMajor' | 'requiredJavaMajor' | 'compatibility' | 'runtimeStatus' | 'restartRequired' | 'startScript'>
      runtimeSettings = { ...runtimeSettings, ...input, restartRequired: runtimeStatus === 'running' }
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
  await page.route(`**/api/v1/admin/servers/${serverId}/automation/jobs/${missedJobId}/acknowledge`, (route) => {
    automation = { ...automation, unacknowledgedCount: 0, jobs: automation.jobs.map((job) => job.id === missedJobId ? { ...job, acknowledgedAt: now } : job) }
    return route.fulfill({ json: { automation } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/restart`, (route) => {
    runtimeStatus = 'running'
    runtimeSettings = { ...runtimeSettings, runtimeStatus, restartRequired: false }
    restartRequired = false
    return route.fulfill({ json: { runtime: { serverId, status: runtimeStatus, startedAt: now, uptimeSeconds: 0, memoryRssBytes: null, cpuPercent: null, ready: true, playersOnline: null, eula: 'accepted', restartRequired: false, lastExitCode: 0, errorMessage: null } } })
  })
  await page.route(`**/api/v1/servers/${serverId}/runtime`, (route) => route.fulfill({ json: { runtime: { serverId, status: runtimeStatus, startedAt: runtimeStatus === 'running' ? now : null, uptimeSeconds: runtimeStatus === 'running' ? 153 : null, memoryRssBytes: null, cpuPercent: null, ready: runtimeStatus === 'running', playersOnline: null, eula: 'accepted', restartRequired, lastExitCode: null, errorMessage: null } } }))
  await page.route(`**/api/v1/servers/${serverId}/status`, (route) => route.fulfill({ json: { status: { serverId, checkedAt: now, source: 'local-status-ping', state: 'reachable', playersOnline: 3, playersMax: 20, versionName: 'Paper 1.21.4', description: 'Local fixture', latencyMs: 4, errorCode: null, authoritativePlayerList: false } } }))
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
  await page.route(`**/api/v1/servers/${serverId}/console?*`, (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0)
    return route.fulfill({ json: { entries: consoleResponse.entries.filter((entry) => entry.id > after), nextAfter: null } })
  })
  await page.route(`**/api/v1/admin/servers/${serverId}/properties`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON() as Partial<typeof settings> & { confirmOnlineModeChange?: boolean }
      const changes = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'confirmOnlineModeChange')) as Partial<typeof settings>
      settings = { ...settings, ...changes }
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
    return route.fulfill({ json: { serverId, items: backupItems, truncated: false, storageUsedBytes: backupItems.length * 512, storageLimitBytes: 107374182400, quotaWarning: false, runtimeStatus } })
  })

  const filePath = 'config/server-note.txt'
  let fileText = 'Fixture notes from the managed server.\n'
  let fileHash = 'b'.repeat(64)
  let fileRecoveryText = 'Earlier fixture notes.\n'
  let filePresent = true
  let folderCreated = false
  let fileRecoveries: Array<{ id: string; path: string; sizeBytes: number; sha256: string; createdAt: string }> = []
  let fileTrash: Array<{ id: string; name: string; originalPath: string; kind: 'file' | 'folder'; sizeBytes: number | null; deletedAt: string }> = []
  const uploadedPaths = new Set<string>()
  const uploadRequests: Array<{ path: string; body: string }> = []
  const safeFileEntry = (name: string, path: string) => ({ name, path, kind: 'file' as const, sizeBytes: fileText.length, modifiedAt: now, contentState: 'editable' as const, reason: null, canDownload: true, canEdit: true, canRename: true, canTrash: true })
  const fileInventory = (path: string) => ({
    serverId, path, breadcrumbs: path.split('/').filter(Boolean).map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join('/') })),
    entries: path === '' ? [
      { name: 'config', path: 'config', kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'read-only', reason: null, canDownload: false, canEdit: false, canRename: true, canTrash: true },
      { name: 'server.properties', path: 'server.properties', kind: 'file', sizeBytes: 180, modifiedAt: now, contentState: 'protected', reason: 'Use the typed Properties editor for this configuration file.', canDownload: false, canEdit: false, canRename: false, canTrash: false },
      ...Array.from(uploadedPaths).filter((entry) => !entry.includes('/')).map((entry) => ({ name: entry, path: entry, kind: 'folder', sizeBytes: null, modifiedAt: now, contentState: 'read-only', reason: null, canDownload: false, canEdit: false, canRename: true, canTrash: true })),
    ] : [
      ...(filePresent ? [safeFileEntry('server-note.txt', filePath)] : []),
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
    if (method === 'POST' && pathname.endsWith('/files/move')) return route.fulfill({ json: fileInventory('config') })
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
  return { serverId, get submittedCommand() { return submittedCommand }, get submittedPlayerAction() { return submittedPlayerAction }, get uploadRequests() { return uploadRequests } }
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
  await page.getByRole('button', { name: 'Register host folder' }).click()
  const dialog = page.getByRole('dialog', { name: 'Register a server folder' })
  await dialog.getByText('Advanced: register a folder already on this machine').click()
  await dialog.getByLabel('Server folder path').fill(serverDirectory)
  await dialog.getByRole('button', { name: 'Inspect folder' }).click()
  await expect(dialog.getByText('Vanilla')).toBeVisible()
  await expect(dialog.getByText('25571')).toBeVisible()
  await expect(dialog.locator('.server-import-facts').getByText('Not found').first()).toBeVisible()
  await dialog.getByLabel('Display name').fill('Temporary Smoke Server')
  await page.screenshot({ path: screenshotPath('stage-04a-import-dialog-desktop.png') })
  await dialog.getByRole('button', { name: 'Add to local registry' }).click()
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
  await expect(page.getByText('3 unedited properties')).toBeVisible()
  await page.getByLabel('Message of the day').fill('Changed in browser fixture')
  await page.getByRole('button', { name: 'Save properties' }).click()
  await expect(page.getByText('Saved with a recovery copy.')).toBeVisible()
  await expect(page.getByText('Restart required').first()).toBeVisible()
  await page.getByRole('button', { name: 'Preview restore' }).click()
  const propertyRestore = page.getByRole('dialog', { name: 'Restore properties' })
  await expect(propertyRestore.getByText('A previous fixture message')).toBeVisible()
  await expect(propertyRestore.getByText('The server is running. Restored values apply after its next restart.')).toBeVisible()
  await propertyRestore.getByRole('button', { name: 'Restore this version' }).click()
  await expect(page.getByLabel('Message of the day')).toHaveValue('A previous fixture message')
  await page.screenshot({ path: screenshotPath('stage-04d-properties-desktop.png'), fullPage: true })
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
  test.setTimeout(120_000)
  await signIn(page)
  const workspaceRoutes = ['/', '/servers', '/machine', '/machine/history', '/activity', '/backups', '/templates', '/users', '/profile', '/settings']
  for (const width of [390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 980 })
    for (const route of workspaceRoutes) {
      await page.goto(route)
      await expect(page.locator('.page-content')).toBeVisible()
      const routeName = route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '-')
      await page.screenshot({ path: screenshotPath(`r3-${routeName}-${width}.png`), fullPage: true, animations: 'disabled' })
      await expectNoHorizontalOverflow(page, `${route} at ${width}px`)
    }
  }

  const { serverId } = await mockLocalServer(page)
  const serverSections = ['overview', 'console', 'logs', 'players', 'mods', 'files', 'properties', 'worlds', 'runtime', 'backups', 'automation', 'access']
  for (const width of [390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 980 })
    for (const section of serverSections) {
      const route = `/servers/${serverId}/${section}`
      await page.goto(route)
      await expect(page.locator('.page-content')).toBeVisible()
      if (section === 'access') await expectAccessBadgeFits(page, `${section} at ${width}px`)
      await page.screenshot({ path: screenshotPath(`r3-server-${section}-${width}.png`), fullPage: true, animations: 'disabled' })
      await expectNoHorizontalOverflow(page, `${section} at ${width}px`)
    }
  }

  const zoomWidths = [{ zoom: 125, width: 1024 }, { zoom: 150, width: 853 }]
  for (const { zoom, width } of zoomWidths) {
    await page.setViewportSize({ width, height: 980 })
    for (const route of workspaceRoutes) {
      await page.goto(route)
      await expectNoHorizontalOverflow(page, `${route} at ${zoom}% zoom (effective ${width}px)`)
      if (['/', '/servers', '/settings'].includes(route)) {
        const routeName = route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '-')
        await page.screenshot({ path: screenshotPath(`r3-zoom-${zoom}-${routeName}.png`), fullPage: true, animations: 'disabled' })
      }
    }
    for (const section of serverSections) {
      const route = `/servers/${serverId}/${section}`
      await page.goto(route)
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
    javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096, port: 25565, eula: 'accepted', managed: true,
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

test('runtime settings, safe restart and scheduled backup review work on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await signIn(page)
  const { serverId } = await mockLocalServer(page)
  await page.goto(`/servers/${serverId}/runtime`)
  await expect(page.getByRole('heading', { name: 'Runtime profile' })).toBeVisible()
  await expect(page.getByLabel('Selected Java executable')).toHaveValue('/tmp/mmsmanager-e2e-java-21')
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
  await expect(page.getByText('1 missed schedule need review.')).toBeVisible()
  await page.getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.getByText('Missed backup acknowledged. No backup was created for that time.')).toBeVisible()
  await page.locator('.local-automation-toggle input').check()
  await page.getByLabel('Frequency').selectOption('weekly')
  await page.getByLabel('Backup weekday').selectOption('3')
  await page.getByLabel('Backup local time').fill('04:15')
  await page.getByRole('button', { name: 'Save schedule' }).click()
  await expect(page.getByText('Schedule saved in Europe/Paris. The next backup will run only if the managed server is stopped.')).toBeVisible()
  await expect(page.getByLabel('Frequency')).toHaveValue('weekly')
  await page.screenshot({ path: screenshotPath('stage-05f-automation-desktop.png'), fullPage: true })

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
    eula: 'accepted', managed: true, worldFolders: ['world'], createdAt: now, runtimeStatus: 'stopped',
  }
  await page.route('**/api/v1/servers', (route) => route.fulfill({ json: { servers: [
    { id: serverId, name: 'Local Fixture', source: 'created', software: 'paper', version: '1.21.4', jarName: 'server.jar', javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 4096, port: 25565, eula: 'accepted', managed: true, worldFolders: ['world'], createdAt: now, runtimeStatus: 'stopped' },
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
  const { serverId } = await mockLocalServer(page)
  await page.goto(`/servers/${serverId}/files`)
  await expect(page.locator('.local-files-card h3', { hasText: 'Files' })).toBeVisible()
  await expect(page.getByText('server.properties')).toBeVisible()
  await expect(page.getByText('Protected', { exact: true })).toBeVisible()
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
  await page.getByRole('button', { name: 'Move server-note.txt to trash' }).click()
  const trashToggle = page.locator('.local-files-header-actions').getByRole('button', { name: /Trash/ })
  await trashToggle.click()
  await expect(page.getByText('config/server-note.txt')).toBeVisible()
  await page.once('dialog', (confirm) => void confirm.accept())
  await page.locator('.local-file-trash-row').getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByRole('button', { name: 'server-note.txt', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'New folder' }).click()
  const createFolder = page.getByRole('dialog', { name: 'Create folder' })
  await createFolder.getByLabel('Name').fill('notes')
  await createFolder.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.getByRole('button', { name: 'notes', exact: true })).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-05c-file-manager-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/servers/${serverId}/files`)
  await expectNoHorizontalOverflow(page, 'managed file manager mobile')
  await page.screenshot({ path: screenshotPath('stage-05c-file-manager-mobile.png'), fullPage: true, animations: 'disabled' })
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
  await expect(page.getByText('1 unread')).toBeVisible()
  await page.screenshot({ path: screenshotPath('stage-06c-notifications-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: 'Mark read' }).click()
  await expect(page.getByText('0 unread')).toBeVisible()
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
  await page.route(`**/api/v1/admin/servers/${serverId}/properties`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON() as Record<string, unknown>
      propertyUpdate = input
      const changes = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'confirmOnlineModeChange'))
      const current = { onlineMode: true, motd: 'A local fixture', gameMode: 'survival', difficulty: 'normal', maxPlayers: 20, viewDistance: 10, simulationDistance: 8, spawnProtection: 16, pvp: true, whiteList: false, allowNether: true }
      const settings = { ...current, ...changes }
      onlineModeEnabled = settings.onlineMode === false ? false : true
      return route.fulfill({ json: { properties: { settings, unknownKeys: ['server-ip', 'level-seed'], backups: [], restartRequired: true } } })
    }
    return route.fulfill({ json: { properties: { settings: { onlineMode: onlineModeEnabled, motd: 'A local fixture', gameMode: 'survival', difficulty: 'normal', maxPlayers: 20, viewDistance: 10, simulationDistance: 8, spawnProtection: 16, pvp: true, whiteList: false, allowNether: true }, unknownKeys: ['server-ip', 'level-seed'], backups: [], restartRequired: false } } })
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
  let current = { id: operationId, name: 'Cancel Fixture', directoryName: 'cancel-fixture', software: 'vanilla', version: '1.21.4', status: 'pending', progress: 12, phase: 'downloading', serverId: null, artifactUrl: null, artifactSize: null, artifactSha256: null, error: null, partialDirectory: null, createdAt: now, updatedAt: now }
  await page.route('**/api/v1/admin/java', (route) => route.fulfill({ json: { runtimes: [{ path: '/tmp/mmsmanager-e2e-java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered' }] } }))
  await page.route('**/api/v1/admin/servers', (route) => route.fulfill({ json: { servers: [], managedRoot: '/tmp/mmsmanager-stage6-e2e-servers', importRoots: ['/tmp/mmsmanager-stage6-e2e-servers'] } }))
  await page.route('**/api/v1/admin/server-installs/catalog?*', (route) => {
    const url = new URL(route.request().url())
    return route.fulfill({ json: { software: 'vanilla', versions: ['1.21.4'], loaders: [], builds: [], installerVersion: null, requiredJavaMajor: url.searchParams.has('version') ? 21 : null } })
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
  test.setTimeout(120_000)
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
    '/servers/properties': 'Свойства сервера', '/servers/console': 'Текущая консоль', '/servers/access': 'Просмотр прав доступа',
  }
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 })
    for (const route of workspaceRoutes) {
      await page.goto(route)
      await expect(page.locator('.page-content')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
      if (translatedChecks[route]) await expect(page.locator('.page-content')).toContainText(translatedChecks[route]!)
      await expectNoHorizontalOverflow(page, `Russian ${route} at ${width}px`)
      await page.screenshot({ path: screenshotPath(`r4-ru-${route === '/' ? 'dashboard' : route.slice(1).replaceAll('/', '-')}-${width}.png`), fullPage: true, animations: 'disabled' })
    }
    for (const section of serverSections) {
      const route = `/servers/${serverId}/${section}`
      await page.goto(route)
      await expect(page.locator('.page-content')).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
      const sectionCheck = translatedChecks[`/servers/${section}`]
      if (sectionCheck) await expect(page.locator('.page-content')).toContainText(sectionCheck)
      await expectNoHorizontalOverflow(page, `Russian ${section} at ${width}px`)
      if (section === 'access') await expectAccessBadgeFits(page, `Russian ${section} at ${width}px`)
      await page.screenshot({ path: screenshotPath(`r4-ru-server-${section}-${width}.png`), fullPage: true, animations: 'disabled' })
    }
  }
  await page.goto('/settings')
  await page.getByRole('button', { name: 'Язык и оформление' }).click()
  const restoreForm = page.locator('form.appearance-form')
  await restoreForm.locator('select').nth(0).selectOption('en')
  await restoreForm.locator('.settings-footer button').last().click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
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
