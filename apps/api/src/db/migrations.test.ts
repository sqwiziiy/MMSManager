import { afterEach, describe, expect, it } from 'vitest'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { openDatabase } from './client.js'
import { localServerConsoleEntries, localServers, machineSamples, machines, serverAccessGrants, users } from './schema.js'

describe('additive database migrations', () => {
  let directory: string | null = null
  let opened: Awaited<ReturnType<typeof openDatabase>> | null = null

  afterEach(async () => {
    opened?.native.close()
    opened = null
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = null
  })

  it('upgrades an R6 fixture and preserves older console lines as legacy history', async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-migrations-'))
    const preAccessMigrations = join(directory, 'pre-access-migrations')
    await mkdir(join(preAccessMigrations, 'meta'), { recursive: true })
    const source = fileURLToPath(new URL('../../drizzle/', import.meta.url))
    const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as { version: string; dialect: string; entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> }
    const preAccessEntries = journal.entries.filter((entry) => entry.idx <= 15)
    for (const entry of preAccessEntries) await copyFile(join(source, `${entry.tag}.sql`), join(preAccessMigrations, `${entry.tag}.sql`))
    await writeFile(join(preAccessMigrations, 'meta', '_journal.json'), JSON.stringify({ version: journal.version, dialect: journal.dialect, entries: preAccessEntries }, null, 2))

    const databasePath = join(directory, 'state.sqlite')
    opened = await openDatabase({ path: databasePath, migrationsFolder: preAccessMigrations })
    const userId = randomUUID()
    const memberId = randomUUID()
    const serverId = randomUUID()
    const at = '2026-11-24T10:00:00.000Z'
    await opened.db.insert(users).values({ id: userId, username: 'migration-admin', usernameKey: 'migration-admin', displayName: 'Migration Admin', role: 'administrator', passwordHash: 'fixture-only-preserved-hash', createdAt: at, updatedAt: at, passwordChangedAt: at })
    await opened.db.insert(users).values({ id: memberId, username: 'migration-member', usernameKey: 'migration-member', displayName: 'Migration Member', role: 'member', passwordHash: 'fixture-only-member-hash', createdAt: at, updatedAt: at, passwordChangedAt: at })
    opened.native.prepare('INSERT INTO user_preferences (user_id, compact_navigation, default_landing, updated_at) VALUES (?, 1, ?, ?)').run(userId, 'machine', at)
    await opened.db.insert(machines).values({ id: 'local', hostname: 'fixture-host', platform: 'linux', architecture: 'x64', source: 'local', firstSeenAt: at, lastSeenAt: at })
    await opened.db.insert(machineSamples).values({ machineId: 'local', collectedAt: at, minuteStart: at, localDate: '2026-11-24', timeZone: 'Europe/Paris', cpuPercent: 12.5, coreCount: 4, loadOne: 0.5, loadFive: 0.4, loadFifteen: 0.3, memoryUsedBytes: 1024, memoryAvailableBytes: 3072, memoryTotalBytes: 4096, swapUsedBytes: 0, swapTotalBytes: 0, storageDevice: '/fixture', storageMount: '/fixture', storageUsedBytes: 100, storageAvailableBytes: 900, storageTotalBytes: 1000, networkInterface: 'fixture0', networkRxBytesPerSecond: 1, networkTxBytesPerSecond: 2, networkRxTransferredBytes: 100, networkTxTransferredBytes: 200, sampleStatus: 'complete', unavailableFields: '[]', source: 'fixture' })
    await opened.db.insert(localServers).values({ id: serverId, name: 'Legacy console fixture', directory: '/fixture/legacy-console', source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath: '/fixture/java', javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt: at, updatedAt: at })
    opened.native.prepare('INSERT INTO local_server_console_entries (server_id, occurred_at, source, severity, message) VALUES (?, ?, ?, ?, ?)').run(serverId, at, 'stdout', 'info', 'Preserved legacy console fixture')
    opened.native.close()
    opened = null

    opened = await openDatabase({ path: databasePath })
    expect(opened.native.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(opened.db.select().from(users).where(eq(users.id, userId)).get()?.passwordHash).toBe('fixture-only-preserved-hash')
    expect(opened.native.prepare('SELECT compact_navigation AS compactNavigation, default_landing AS defaultLanding, language, theme, accent, density, reduced_motion AS reducedMotion FROM user_preferences WHERE user_id = ?').get(userId)).toEqual({ compactNavigation: 1, defaultLanding: 'machine', language: 'en', theme: 'dark', accent: 'moss', density: 'comfortable', reducedMotion: 0 })
    expect(opened.db.select().from(machineSamples).where(eq(machineSamples.machineId, 'local')).all()).toMatchObject([{ cpuPercent: 12.5, memoryTotalBytes: 4096, source: 'fixture' }])
    expect(opened.db.select().from(localServerConsoleEntries).where(eq(localServerConsoleEntries.serverId, serverId)).all()).toMatchObject([{ serverId, sessionId: null, message: 'Preserved legacy console fixture' }])
    expect(opened.db.select().from(serverAccessGrants).where(eq(serverAccessGrants.userId, memberId)).get()).toMatchObject({
      serverId, viewServer: true, viewLogs: true, viewPlayers: true, viewMods: true, sendConsoleCommands: false,
      controlLifecycle: false, moderatePlayers: false, manageMods: false, viewFiles: false, manageFiles: false,
      viewSettings: false, manageSettings: false, viewWorlds: false, viewBackups: false, createBackups: false,
    })
    expect(opened.native.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'server_templates')).toBeTruthy()
    expect(opened.native.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'user_notification_reads')).toBeTruthy()
    expect(opened.native.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'machine_storage_samples')).toBeTruthy()
    const backups = (await readdir(directory)).filter((name) => name.includes('.pre-migration-') && name.endsWith('.backup'))
    expect(backups).toHaveLength(1)
    expect((await lstat(join(directory, backups[0]!))).mode & 0o777).toBe(0o600)
    const backup = new Database(join(directory, backups[0]!), { readonly: true, fileMustExist: true })
    try { expect(backup.pragma('integrity_check', { simple: true })).toBe('ok') }
    finally { backup.close() }
    opened.native.close()
    opened = null

    opened = await openDatabase({ path: databasePath })
    expect(opened.db.select().from(users).where(eq(users.id, userId)).get()?.passwordHash).toBe('fixture-only-preserved-hash')
    expect((await readdir(directory)).filter((name) => name.includes('.pre-migration-') && name.endsWith('.backup'))).toHaveLength(1)
  })
})
