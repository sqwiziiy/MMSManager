import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { localServerEvents, localServerPropertiesBackups, localServerRuntime, localServers, users } from '../db/schema.js'
import { openDatabase } from '../db/client.js'
import { ServerRegistry } from './registry.js'
import { ServerPropertiesManager } from './properties.js'

describe('managed server.properties editor', () => {
  let temp: string
  let root: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let registry: ServerRegistry
  let manager: ServerPropertiesManager
  let userId: string
  let managedId: string
  let importedId: string
  let managedDirectory: string
  let original: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-properties-'))
    root = join(temp, 'servers')
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    registry = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: root })
    await registry.prepare()
    manager = new ServerPropertiesManager(opened.db, registry, () => Date.parse('2026-11-23T12:00:00.000Z'))
    userId = randomUUID()
    const now = new Date().toISOString()
    await opened.db.insert(users).values({ id: userId, username: 'properties-test', usernameKey: 'properties-test', displayName: 'Properties Test', role: 'administrator', passwordHash: 'test-only-hash', createdAt: now, updatedAt: now, passwordChangedAt: now })
    managedId = randomUUID(); importedId = randomUUID()
    managedDirectory = join(root, 'managed-fixture')
    const importedDirectory = join(root, 'imported-fixture')
    await mkdir(managedDirectory); await mkdir(importedDirectory)
    original = '# Keep this header\nserver-ip=127.0.0.1\n# Unsupported values remain untouched\nonline-mode=true\ncustom.key=stay=exact\nmotd=Old\ngamemode=adventure\ndifficulty=hard\nmax-players=20\nview-distance=10\nsimulation-distance=8\nspawn-protection=16\npvp=true\nwhite-list=false\nallow-nether=true\n'
    await writeFile(join(managedDirectory, 'server.properties'), original, { mode: 0o600 })
    await writeFile(join(importedDirectory, 'server.properties'), original, { mode: 0o600 })
    await opened.db.insert(localServers).values([
      { id: managedId, name: 'Managed Properties Fixture', directory: managedDirectory, source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath: '/test/java', javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: 25565, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now },
      { id: importedId, name: 'Imported Properties Fixture', directory: importedDirectory, source: 'imported', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath: null, javaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024, port: null, eula: 'unknown', managed: false, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now },
    ]).run()
  })

  afterEach(async () => {
    opened?.native.close()
    await rm(temp, { recursive: true, force: true })
  })

  it('backs up before an atomic edit, preserves comments and unsupported keys, and marks a live server for restart', async () => {
    await opened.db.insert(localServerRuntime).values({ serverId: managedId, status: 'running', updatedAt: new Date().toISOString(), restartRequired: false }).run()
    const result = await manager.update(managedId, userId, { motd: 'A safe = message', maxPlayers: 42, whiteList: true })
    expect(result.settings).toMatchObject({ motd: 'A safe = message', maxPlayers: 42, whiteList: true, gameMode: 'adventure' })
    expect(result.restartRequired).toBe(true)
    expect(result.backups).toHaveLength(1)
    const text = await readFile(join(managedDirectory, 'server.properties'), 'utf8')
    expect(text).toContain('# Keep this header\nserver-ip=127.0.0.1\n# Unsupported values remain untouched\nonline-mode=true\ncustom.key=stay=exact\n')
    expect(text).toContain('motd=A safe \\= message\n')
    expect(text).toContain('max-players=42\n')
    expect(text).toContain('white-list=true\n')
    const backup = opened.db.select().from(localServerPropertiesBackups).where(eq(localServerPropertiesBackups.serverId, managedId)).get()
    expect(backup).toBeDefined()
    const backupPath = join(temp, 'properties-backups', managedId, backup!.fileName)
    expect(await readFile(backupPath, 'utf8')).toBe(original)
    expect((await lstat(backupPath)).mode & 0o777).toBe(0o600)
    const event = opened.db.select().from(localServerEvents).where(eq(localServerEvents.action, 'server-properties-updated')).get()
    expect(event?.actorUserId).toBe(userId)
  })

  it('keeps imported folders read only and rejects symbolic links to properties files', async () => {
    await expect(manager.get(importedId)).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
    const externalPath = join(temp, 'outside.properties')
    await rm(join(managedDirectory, 'server.properties'))
    await writeFile(externalPath, original, { mode: 0o600 })
    await symlink(externalPath, join(managedDirectory, 'server.properties'))
    await expect(manager.get(managedId)).rejects.toMatchObject({ code: 'PROPERTIES_FILE_UNSAFE' })
    await expect(manager.update(managedId, userId, { motd: 'Should not write' })).rejects.toMatchObject({ code: 'PROPERTIES_FILE_UNSAFE' })
    expect(await readFile(externalPath, 'utf8')).toBe(original)
  })

  it('does not create a backup or restart flag when a submitted value is unchanged', async () => {
    const result = await manager.update(managedId, userId, { motd: 'Old' })
    expect(result.backups).toHaveLength(0)
    expect(result.restartRequired).toBe(false)
    expect(opened.db.select().from(localServerPropertiesBackups).all()).toHaveLength(0)
    expect(opened.db.select().from(localServerRuntime).all()).toHaveLength(0)
  })

  it('previews a checksum-verified restore, preserves a new recovery point, and marks a running server for restart', async () => {
    await manager.update(managedId, userId, { motd: 'First saved version' })
    const selected = opened.db.select().from(localServerPropertiesBackups).where(eq(localServerPropertiesBackups.serverId, managedId)).get()!
    await manager.update(managedId, userId, { motd: 'Current value' })
    const currentBytes = await readFile(join(managedDirectory, 'server.properties'))
    await opened.db.update(localServerRuntime).set({ status: 'running', updatedAt: new Date().toISOString(), restartRequired: false }).where(eq(localServerRuntime.serverId, managedId)).run()

    const preview = await manager.previewRestore(managedId, selected.id)
    expect(preview).toMatchObject({ checksumValid: true, running: true, restartRequiredAfterRestore: true })
    expect(preview.changedSettings).toContainEqual({ key: 'motd', current: 'Current value', restored: 'Old' })
    expect(JSON.stringify(preview)).not.toContain('do-not-show')
    const result = await manager.restore(managedId, userId, selected.id, preview.currentSha256)
    expect(result.properties.settings.motd).toBe('Old')
    expect(result.properties.restartRequired).toBe(true)
    expect(result.recoveryBackupId).toBeTruthy()
    const newRecovery = opened.db.select().from(localServerPropertiesBackups).where(eq(localServerPropertiesBackups.id, result.recoveryBackupId!)).get()!
    expect(await readFile(join(temp, 'properties-backups', managedId, newRecovery.fileName))).toEqual(currentBytes)
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toBe(original)
    expect(opened.db.select().from(localServerEvents).where(eq(localServerEvents.action, 'server-properties-restored')).get()?.actorUserId).toBe(userId)
  })

  it('rejects a stale preview and refuses a recovery copy with a checksum mismatch', async () => {
    await manager.update(managedId, userId, { motd: 'Saved state' })
    const selected = opened.db.select().from(localServerPropertiesBackups).where(eq(localServerPropertiesBackups.serverId, managedId)).get()!
    const preview = await manager.previewRestore(managedId, selected.id)
    await writeFile(join(managedDirectory, 'server.properties'), original.replace('motd=Old', 'motd=Changed externally'))
    await expect(manager.restore(managedId, userId, selected.id, preview.currentSha256)).rejects.toMatchObject({ code: 'PROPERTY_RESTORE_CONFLICT' })

    const current = await readFile(join(managedDirectory, 'server.properties'), 'utf8')
    const backupPath = join(temp, 'properties-backups', managedId, selected.fileName)
    await writeFile(backupPath, 'tampered copy')
    const invalid = await manager.previewRestore(managedId, selected.id)
    expect(invalid.checksumValid).toBe(false)
    await expect(manager.restore(managedId, userId, selected.id, invalid.currentSha256)).rejects.toMatchObject({ code: 'PROPERTY_BACKUP_CHECKSUM_FAILED' })
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toBe(current)
  })
})
