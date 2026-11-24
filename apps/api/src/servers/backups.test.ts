import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { localServerBackupRestores, localServerBackups, localServerRuntime, localServers, users } from '../db/schema.js'
import { ServerProcessManager } from './processes.js'
import { ServerRegistry } from './registry.js'
import { ServerBackupService } from './backups.js'

const now = () => Date.parse('2026-11-24T12:00:00.000Z')

describe('managed server backup and restore', () => {
  let temp: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let servers: ServerRegistry
  let processes: ServerProcessManager
  let service: ServerBackupService
  let serverId: string
  let actorId: string
  let serverDirectory: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-backups-'))
    opened = await openDatabase({ path: join(temp, 'mmsmanager.sqlite') })
    servers = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: join(temp, 'servers') })
    await servers.prepare()
    processes = new ServerProcessManager(opened.db, servers, now)
    await processes.prepare()
    service = new ServerBackupService(opened.db, servers, processes, now)
    await service.prepare()
    serverId = randomUUID()
    actorId = randomUUID()
    const createdAt = new Date(now()).toISOString()
    serverDirectory = join(servers.managedRoot, 'managed-fixture')
    await mkdir(serverDirectory)
    await opened.db.insert(users).values({
      id: actorId, username: `admin-${actorId.slice(0, 6)}`, usernameKey: `admin-${actorId.slice(0, 6)}`,
      displayName: 'Fixture Administrator', role: 'administrator', passwordHash: 'fixture-hash', enabled: true,
      avatarKey: null, createdAt, updatedAt: createdAt, lastLoginAt: createdAt, passwordChangedAt: createdAt,
    }).run()
    await opened.db.insert(localServers).values({
      id: serverId, name: 'Managed Fixture', directory: serverDirectory, source: 'created', software: 'vanilla', version: '1.21.4',
      jarName: 'server.jar', javaPath: '/fixture/java', javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 2048,
      port: 25565, eula: 'accepted', managed: true, worldFolders: JSON.stringify(['world']), createdBy: actorId,
      createdAt, updatedAt: createdAt,
    }).run()
    await opened.db.insert(localServerRuntime).values({
      serverId, status: 'stopped', processPid: null, processStartMarker: null, processBootId: null,
      startedAt: null, updatedAt: createdAt, lastExitCode: null, errorMessage: null, restartRequired: true,
    }).run()
    await writeFile(join(serverDirectory, 'server.jar'), 'synthetic jar bytes')
    await writeFile(join(serverDirectory, 'server.properties'), 'level-name=world\nserver-port=25565\n')
    await mkdir(join(serverDirectory, 'world', 'region'), { recursive: true })
    await writeFile(join(serverDirectory, 'world', 'region', 'r.0.0.mca'), 'original-world-region-content')
    await mkdir(join(serverDirectory, '.mmsmanager', 'trash', 'file-manager'), { recursive: true, mode: 0o700 })
    await writeFile(join(serverDirectory, '.mmsmanager', 'trash', 'file-manager', 'recoverable.bin'), 'private recoverable bytes', { mode: 0o600 })
    await writeFile(join(serverDirectory, '.env'), 'SHOULD_NOT_BE_ARCHIVED=secret')
    await mkdir(join(serverDirectory, '.aws'))
    await writeFile(join(serverDirectory, '.aws', 'credentials'), 'fixture cloud secret')
    await writeFile(join(serverDirectory, 'id_ed25519'), 'fixture private key')
    await writeFile(join(serverDirectory, 'cloud-token.pem'), 'fixture private certificate key')
    await writeFile(join(serverDirectory, 'credentials.json'), 'fixture credential file')
    await writeFile(join(temp, 'outside-hardlink.dat'), 'linked-outside-data')
    await link(join(temp, 'outside-hardlink.dat'), join(serverDirectory, 'linked.dat'))
    await symlink(join(temp, 'outside-hardlink.dat'), join(serverDirectory, 'external-link.dat'))
    await writeFile(join(serverDirectory, 'mmsmanager.sqlite'), 'auth database exclusion fixture')
  })

  afterEach(async () => {
    opened.native.close()
    await rm(temp, { recursive: true, force: true })
  })

  it('writes a private, checksummed archive and manifest while excluding links and private system files', async () => {
    const backup = await service.create(serverId, actorId)
    const folder = join(temp, 'server-backups', serverId, backup.id)
    const archiveStat = await lstat(join(folder, 'snapshot.mmsbackup'))
    const manifestStat = await lstat(join(folder, 'manifest.json'))
    expect(archiveStat.mode & 0o777).toBe(0o600)
    expect(manifestStat.mode & 0o777).toBe(0o600)
    expect(backup).toMatchObject({ kind: 'manual', fileCount: 4, excludedCount: 8 })
    const preview = await service.preview(serverId, backup.id)
    expect(preview).toMatchObject({ integrityValid: true, canRestore: true, serverStopped: true })
    expect(preview.entries.map((entry) => entry.path)).toContain('.mmsmanager/trash/file-manager/recoverable.bin')
    expect(preview.entries.some((entry) => ['.env', '.aws/credentials', 'id_ed25519', 'cloud-token.pem', 'credentials.json', 'mmsmanager.sqlite', 'linked.dat', 'external-link.dat'].includes(entry.path))).toBe(false)
    expect(preview.excludedPaths.map((entry) => entry.reason)).toEqual(expect.arrayContaining(['private-system-data', 'private-credential', 'hardlink', 'symlink']))
    expect(await service.hasWorldSnapshot(serverId, 'world')).toBe(true)
    expect(await service.hasWorldSnapshot(serverId, 'world/absent')).toBe(false)
    const download = await service.openDownload(serverId, backup.id)
    const archiveBytes = await download.handle.readFile()
    await download.handle.close()
    expect(archiveBytes.byteLength).toBe(backup.archiveSizeBytes)
    expect(archiveBytes.subarray(0, 8).toString()).toBe('MMSBACK1')
    const inventory = await service.list(serverId)
    expect(inventory.items).toHaveLength(1)
    expect(inventory.storageUsedBytes).toBe(archiveStat.size + manifestStat.size)
  })

  it('removes only private interrupted backup staging folders during API startup recovery', async () => {
    const parent = join(temp, 'server-backups', serverId)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const staging = join(parent, `.${randomUUID()}.staging`)
    await mkdir(staging, { mode: 0o700 })
    await writeFile(join(staging, 'partial.archive'), 'incomplete fixture')
    await service.prepare()
    await expect(lstat(staging)).rejects.toThrow()
    expect(await readdir(parent)).toEqual([])
  })

  it('restores a verified snapshot only after typed confirmation and first creates a safety snapshot', async () => {
    const backup = await service.create(serverId, actorId)
    await writeFile(join(serverDirectory, 'world', 'region', 'r.0.0.mca'), 'newer-world-region-content')
    await writeFile(join(serverDirectory, 'added-after-backup.txt'), 'remove this on restore')
    await expect(service.restore(serverId, actorId, backup.id, 'restore')).rejects.toMatchObject({ code: 'RESTORE_CONFIRMATION_FAILED' })
    expect(opened.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, serverId)).all()).toHaveLength(1)

    const result = await service.restore(serverId, actorId, backup.id, 'RESTORE Managed Fixture')
    expect(result).toMatchObject({ ok: true, backupId: backup.id, restoredFileCount: backup.fileCount, restoredBytes: backup.totalFileBytes, rollbackCleanupPending: false })
    expect(await readFile(join(serverDirectory, 'world', 'region', 'r.0.0.mca'), 'utf8')).toBe('original-world-region-content')
    await expect(readFile(join(serverDirectory, 'added-after-backup.txt'))).rejects.toThrow()
    expect(await readFile(join(serverDirectory, '.mmsmanager', 'trash', 'file-manager', 'recoverable.bin'), 'utf8')).toBe('private recoverable bytes')
    const snapshots = opened.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, serverId)).all()
    expect(snapshots.map((row) => row.kind).sort()).toEqual(['manual', 'pre-restore'])
    expect(opened.db.select().from(localServerBackupRestores).where(eq(localServerBackupRestores.id, result.restoreId)).get()?.status).toBe('completed')
    expect(opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()?.restartRequired).toBe(false)
  })

  it('rejects checksum mismatch before restore changes the live tree', async () => {
    const backup = await service.create(serverId, actorId)
    const archivePath = join(temp, 'server-backups', serverId, backup.id, 'snapshot.mmsbackup')
    const handle = await open(archivePath, 'r+')
    try {
      const bytes = await handle.readFile()
      const offset = bytes.indexOf(Buffer.from('original-world-region-content'))
      expect(offset).toBeGreaterThan(0)
      bytes[offset] = 'X'.charCodeAt(0)
      await handle.write(bytes, 0, bytes.byteLength, 0)
      await handle.sync()
    } finally { await handle.close() }
    const preview = await service.preview(serverId, backup.id)
    expect(preview.integrityValid).toBe(false)
    expect(preview.canRestore).toBe(false)
    await expect(service.restore(serverId, actorId, backup.id, 'RESTORE Managed Fixture')).rejects.toMatchObject({ code: 'BACKUP_CHECKSUM_FAILED' })
    expect(await readFile(join(serverDirectory, 'world', 'region', 'r.0.0.mca'), 'utf8')).toBe('original-world-region-content')
    expect(opened.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, serverId)).all()).toHaveLength(1)
  })

  it('cleans a partially written interrupted archive without creating a completed ledger row', async () => {
    const controller = new AbortController()
    await expect(service.create(serverId, actorId, {
      signal: controller.signal,
      onArchiveProgress: (written) => { if (written >= 8) controller.abort() },
    })).rejects.toMatchObject({ code: 'BACKUP_INTERRUPTED' })
    expect(opened.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, serverId)).all()).toHaveLength(0)
    expect(await readdir(join(temp, 'server-backups', serverId))).toEqual([])
  })

  it('rolls back the original directory when the staged restore cannot be installed', async () => {
    const backup = await service.create(serverId, actorId)
    await writeFile(join(serverDirectory, 'keep-on-failure.txt'), 'current version stays')
    const faultyService = new ServerBackupService(opened.db, servers, processes, now, { beforeInstall: () => { throw new Error('fixture install failure') } })
    await faultyService.prepare()
    await expect(faultyService.restore(serverId, actorId, backup.id, 'RESTORE Managed Fixture')).rejects.toMatchObject({ code: 'RESTORE_FAILED' })
    expect(await readFile(join(serverDirectory, 'keep-on-failure.txt'), 'utf8')).toBe('current version stays')
    const restore = opened.db.select().from(localServerBackupRestores).where(eq(localServerBackupRestores.backupId, backup.id)).get()
    expect(restore?.status).toBe('rolled-back')
    expect((await faultyService.list(serverId)).items.map((item) => item.kind).sort()).toEqual(['manual', 'pre-restore'])
  })

  it('rejects running and imported servers and blocks unresolved restore recovery', async () => {
    const backup = await service.create(serverId, actorId)
    await opened.db.update(localServerRuntime).set({ status: 'running', updatedAt: new Date(now()).toISOString() }).where(eq(localServerRuntime.serverId, serverId)).run()
    expect((await service.preview(serverId, backup.id)).canRestore).toBe(false)
    await expect(service.restore(serverId, actorId, backup.id, 'RESTORE Managed Fixture')).rejects.toMatchObject({ code: 'SERVER_NOT_STOPPED' })
    await expect(service.create(serverId, actorId)).rejects.toMatchObject({ code: 'SERVER_NOT_STOPPED' })

    const importedId = randomUUID()
    const importedDirectory = join(temp, 'imported-fixture')
    await mkdir(importedDirectory)
    const createdAt = new Date(now()).toISOString()
    await opened.db.insert(localServers).values({
      id: importedId, name: 'Imported Fixture', directory: importedDirectory, source: 'imported', software: 'unknown',
      version: null, jarName: null, javaPath: null, javaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024,
      port: null, eula: 'unknown', managed: false, worldFolders: '[]', createdBy: null, createdAt, updatedAt: createdAt,
    }).run()
    await expect(service.list(importedId)).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
  })
})
