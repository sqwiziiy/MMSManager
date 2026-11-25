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
    manager = new ServerPropertiesManager(opened.db, registry, () => Date.parse('2026-11-23T12:00:00.000Z'), async () => true)
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

  async function updateProperties(settings: Parameters<ServerPropertiesManager['update']>[2], options: Omit<Parameters<ServerPropertiesManager['update']>[3], 'expectedSha256'> = {}) {
    const current = await manager.get(managedId)
    return manager.update(managedId, userId, settings, { ...options, expectedSha256: current.sha256 })
  }

  it('backs up before an atomic edit, preserves comments and unsupported keys, and marks a live server for restart', async () => {
    await opened.db.insert(localServerRuntime).values({ serverId: managedId, status: 'running', updatedAt: new Date().toISOString(), restartRequired: false }).run()
    const result = await updateProperties({ motd: 'A safe = message', maxPlayers: 42, whiteList: true })
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
    await expect(updateProperties({ motd: 'Should not write' })).rejects.toMatchObject({ code: 'PROPERTIES_FILE_UNSAFE' })
    expect(await readFile(externalPath, 'utf8')).toBe(original)
  })

  it('does not create a backup or restart flag when a submitted value is unchanged', async () => {
    const result = await updateProperties({ motd: 'Old' })
    expect(result.backups).toHaveLength(0)
    expect(result.restartRequired).toBe(false)
    expect(opened.db.select().from(localServerPropertiesBackups).all()).toHaveLength(0)
    expect(opened.db.select().from(localServerRuntime).all()).toHaveLength(0)
  })

  it('changes online mode only after explicit confirmation and a stopped-state recovery point', async () => {
    expect((await manager.get(managedId)).settings.onlineMode).toBe(true)
    await expect(updateProperties({ onlineMode: false })).rejects.toMatchObject({ code: 'ONLINE_MODE_CONFIRMATION_REQUIRED' })
    await expect(updateProperties({ onlineMode: false }, { confirmOnlineModeChange: true })).rejects.toMatchObject({ code: 'ONLINE_MODE_REQUIRES_STOPPED' })
    await opened.db.insert(localServerRuntime).values({ serverId: managedId, status: 'running', updatedAt: new Date().toISOString(), restartRequired: false }).run()
    await expect(updateProperties({ onlineMode: false }, { confirmOnlineModeChange: true })).rejects.toMatchObject({ code: 'ONLINE_MODE_REQUIRES_STOPPED' })
    await opened.db.update(localServerRuntime).set({ status: 'stopped', updatedAt: new Date().toISOString() }).where(eq(localServerRuntime.serverId, managedId)).run()

    const changed = await updateProperties({ onlineMode: false }, { confirmOnlineModeChange: true })
    expect(changed.settings.onlineMode).toBe(false)
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toContain('online-mode=false')
    expect(changed.backups).toHaveLength(1)
    const recovery = await manager.previewRestore(managedId, changed.backups[0]!.id)
    expect(recovery.changedSettings).toContainEqual({ key: 'online-mode', current: 'false', restored: 'true' })
    const restored = await manager.restore(managedId, userId, changed.backups[0]!.id, recovery.currentSha256)
    expect(restored.properties.settings.onlineMode).toBe(true)
    expect(restored.recoveryBackupId).toBeTruthy()
    const event = opened.db.select().from(localServerEvents).where(eq(localServerEvents.action, 'server-properties-updated')).get()
    expect(event?.actorUserId).toBe(userId)
    expect(event?.detail).toContain('onlineMode')
    expect(event?.detail).not.toContain('false')
  })

  it('previews a checksum-verified restore, preserves a new recovery point, and marks a running server for restart', async () => {
    await updateProperties({ motd: 'First saved version' })
    const selected = opened.db.select().from(localServerPropertiesBackups).where(eq(localServerPropertiesBackups.serverId, managedId)).get()!
    await updateProperties({ motd: 'Current value' })
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
    await updateProperties({ motd: 'Saved state' })
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

  it('edits the versioned advanced catalog without rewriting unknown duplicates or protected values', async () => {
    const fixture = '# Versioned property fixture\r\nserver-ip=127.0.0.1\r\nrcon.password=never-return-this\r\ntext-filtering-extra=never-return-this-either\r\nallow-flight=false\r\nallow-flight=true\r\ncustom.duplicate=first\r\ncustom.duplicate=last\r\n'
    await writeFile(join(managedDirectory, 'server.properties'), fixture, { mode: 0o600 })
    const before = await manager.get(managedId)
    expect(before).toMatchObject({ serverVersion: '1.21.4', serverSoftware: 'vanilla', advancedProperties: { 'allow-flight': 'true' } })
    expect(before.presentKeys).toContain('allow-flight')
    expect(before.protectedProperties).toContainEqual(expect.objectContaining({ key: 'server-ip', configured: true }))
    expect(before.protectedProperties).toContainEqual(expect.objectContaining({ key: 'rcon.password', configured: true }))
    expect(before.protectedProperties).toContainEqual(expect.objectContaining({ key: 'text-filtering-extra', configured: true }))
    expect(before.unknownKeys).toContain('custom.duplicate')
    expect(before.unsupportedKeys).not.toContain('region-file-compression')
    expect(JSON.stringify(before)).not.toContain('never-return-this')

    const updated = await manager.update(managedId, userId, {}, {
      expectedSha256: before.sha256,
      advancedProperties: { 'allow-flight': 'false', hardcore: 'false', 'rate-limit': '0', 'level-name': 'fixture_world' },
      confirmLevelNameChange: true,
    })
    expect(updated.advancedProperties).toMatchObject({ 'allow-flight': 'false', hardcore: 'false', 'rate-limit': '0', 'level-name': 'fixture_world' })
    expect(updated.presentKeys).toEqual(expect.arrayContaining(['allow-flight', 'hardcore', 'rate-limit', 'level-name']))
    expect(updated.restartRequired).toBe(false)
    expect(updated.backups).toHaveLength(1)
    const saved = await readFile(join(managedDirectory, 'server.properties'), 'utf8')
    expect(saved).toContain('# Versioned property fixture\r\nserver-ip=127.0.0.1\r\nrcon.password=never-return-this\r\ntext-filtering-extra=never-return-this-either\r\nallow-flight=false\r\nallow-flight=false\r\ncustom.duplicate=first\r\ncustom.duplicate=last\r\n')
    expect(saved).toContain('hardcore=false\r\nrate-limit=0\r\nlevel-name=fixture_world\r\n')
    expect(await readFile(join(temp, 'properties-backups', managedId, updated.backups[0]!.id + '.properties'), 'utf8')).toBe(fixture)
    expect(JSON.stringify(updated)).not.toContain('never-return-this')
  })

  it('uses the 1.20.1 Fabric fixture, keeps unsupported properties visible and masks values in restore previews', async () => {
    const fixtureId = randomUUID()
    const fixtureDirectory = join(root, 'fabric-1.20.1')
    const fixtureBytes = '# Fabric 1.20.1 fixture\r\nallow-flight=true\r\nregion-file-compression=lz4\r\nresource-pack=https\\://private.example/pack.zip\r\ncustom.keep=original\r\n'
    await mkdir(fixtureDirectory)
    await writeFile(join(fixtureDirectory, 'server.properties'), fixtureBytes, { mode: 0o600 })
    const now = new Date().toISOString()
    await opened.db.insert(localServers).values({
      id: fixtureId, name: 'Fabric 1.20.1 Fixture', directory: fixtureDirectory, source: 'created', software: 'fabric', version: '1.20.1',
      jarName: 'server.jar', javaPath: '/test/java-17/bin/java', javaMajor: 17, minMemoryMb: 512, maxMemoryMb: 1024,
      port: 25567, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now,
    }).run()
    const before = await manager.get(fixtureId)
    expect(before).toMatchObject({ serverVersion: '1.20.1', serverSoftware: 'fabric', advancedProperties: { 'allow-flight': 'true', 'region-file-compression': 'lz4' } })
    expect(before.unsupportedKeys).toContain('region-file-compression')

    const changed = await manager.update(fixtureId, userId, {}, {
      expectedSha256: before.sha256,
      advancedProperties: { 'allow-flight': 'false', 'resource-pack': 'https://private.example/other-pack.zip' },
      confirmResourcePackChange: true,
    })
    expect(changed.advancedProperties['allow-flight']).toBe('false')
    const savedBytes = await readFile(join(fixtureDirectory, 'server.properties'))
    expect(savedBytes.toString('utf8')).toContain('# Fabric 1.20.1 fixture\r\nallow-flight=false\r\nregion-file-compression=lz4\r\nresource-pack=https\\://private.example/other-pack.zip\r\ncustom.keep=original\r\n')
    const preview = await manager.previewRestore(fixtureId, changed.backups[0]!.id)
    expect(preview.changedSettings).toContainEqual({ key: 'resource-pack', current: 'Saved value', restored: 'Backup value' })
    expect(preview.changedSettings).toContainEqual({ key: 'allow-flight', current: 'Saved value', restored: 'Backup value' })
    expect(JSON.stringify(preview)).not.toContain('private.example')
    expect(preview.otherContentDiffers).toBe(false)
  })

  it('accepts only the enum values documented for the detected server software', async () => {
    const vanilla = await manager.get(managedId)
    await expect(manager.update(managedId, userId, {}, {
      expectedSha256: vanilla.sha256, advancedProperties: { 'region-file-compression': 'gzip' },
    })).rejects.toMatchObject({ code: 'PROPERTY_VALUE_REJECTED' })
    await opened.db.update(localServers).set({ software: 'paper' }).where(eq(localServers.id, managedId)).run()
    const paper = await manager.get(managedId)
    expect(paper.unsupportedKeys).not.toContain('region-file-compression')
    const result = await manager.update(managedId, userId, {}, {
      expectedSha256: paper.sha256, advancedProperties: { 'region-file-compression': 'gzip' },
    })
    expect(result.advancedProperties['region-file-compression']).toBe('gzip')
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toContain('region-file-compression=gzip')
  })

  it('requires the current hash, version support, strict property values and explicit risky-change confirmations', async () => {
    const before = await manager.get(managedId)
    await expect(manager.update(managedId, userId, {}, { expectedSha256: 'a'.repeat(64), advancedProperties: { hardcore: 'true' } }))
      .rejects.toMatchObject({ code: 'PROPERTY_SAVE_CONFLICT' })
    await expect(manager.update(managedId, userId, {}, { expectedSha256: before.sha256, advancedProperties: { 'unknown-option': 'value' } }))
      .rejects.toMatchObject({ code: 'PROPERTY_KEY_REJECTED' })
    await opened.db.update(localServers).set({ version: '1.20.1' }).where(eq(localServers.id, managedId)).run()
    const older = await manager.get(managedId)
    expect(older.unsupportedKeys).toContain('region-file-compression')
    await expect(manager.update(managedId, userId, {}, { expectedSha256: older.sha256, advancedProperties: { 'region-file-compression': 'lz4' } }))
      .rejects.toMatchObject({ code: 'PROPERTY_UNSUPPORTED_VERSION' })
    await opened.db.update(localServers).set({ version: '1.21.4' }).where(eq(localServers.id, managedId)).run()
    await expect(manager.update(managedId, userId, {}, { expectedSha256: before.sha256, advancedProperties: { 'allow-flight': 'yes' } }))
      .rejects.toMatchObject({ code: 'PROPERTY_VALUE_REJECTED' })
    await expect(manager.update(managedId, userId, {}, { expectedSha256: before.sha256, advancedProperties: { 'generator-settings': '{bad json' } }))
      .rejects.toMatchObject({ code: 'PROPERTY_VALUE_REJECTED' })
    await expect(manager.update(managedId, userId, {}, { expectedSha256: before.sha256, advancedProperties: { 'level-name': '../outside' } }))
      .rejects.toMatchObject({ code: 'PROPERTY_VALUE_REJECTED' })
    await expect(manager.update(managedId, userId, {}, { expectedSha256: before.sha256, advancedProperties: { 'level-seed': 'fixture-seed' } }))
      .rejects.toMatchObject({ code: 'WORLD_GENERATION_CONFIRMATION_REQUIRED' })
    await expect(manager.update(managedId, userId, {}, { expectedSha256: before.sha256, advancedProperties: { 'resource-pack': 'javascript:alert(1)' }, confirmResourcePackChange: true }))
      .rejects.toMatchObject({ code: 'PROPERTY_VALUE_REJECTED' })
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toBe(original)
    expect(opened.db.select().from(localServerPropertiesBackups).where(eq(localServerPropertiesBackups.serverId, managedId)).all()).toHaveLength(0)
  })

  it('checks stopped state and registry collisions before changing the game port', async () => {
    await opened.db.insert(localServerRuntime).values({ serverId: managedId, status: 'stopped', updatedAt: new Date().toISOString(), restartRequired: false }).run()
    await opened.db.update(localServers).set({ port: 25621 }).where(eq(localServers.id, importedId)).run()
    const before = await manager.get(managedId)
    await expect(manager.update(managedId, userId, {}, {
      expectedSha256: before.sha256, advancedProperties: { 'server-port': '25621' }, confirmGamePortChange: true,
    })).rejects.toMatchObject({ code: 'GAME_PORT_CONFLICT' })
    await expect(manager.update(managedId, userId, {}, {
      expectedSha256: before.sha256, advancedProperties: { 'server-port': '25622' },
    })).rejects.toMatchObject({ code: 'GAME_PORT_CONFIRMATION_REQUIRED' })
    const saved = await manager.update(managedId, userId, {}, {
      expectedSha256: before.sha256, advancedProperties: { 'server-port': '25622' }, confirmGamePortChange: true,
    })
    expect(saved.advancedProperties['server-port']).toBe('25622')
    expect(opened.db.select().from(localServers).where(eq(localServers.id, managedId)).get()?.port).toBe(25622)
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toContain('server-port=25622')
  })
})
