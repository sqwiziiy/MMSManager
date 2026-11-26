import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rm, rmdir, statfs, utimes } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { and, desc, eq, sql } from 'drizzle-orm'
import { backupSettingsSchema, DEFAULT_BACKUP_SETTINGS } from '@mmsmanager/shared'
import type { BackupSettings } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { backupSettings as backupSettingsTable, localServerBackupRestores, localServerBackups, localServerEvents, localServerRuntime, localServers } from '../db/schema.js'
import type { ServerProcessManager } from './processes.js'
import type { ServerRegistry } from './registry.js'

const ARCHIVE_MAGIC = Buffer.from('MMSBACK1')
const ARCHIVE_END = Buffer.from('MMSBEND1')
const ENTRY_HEADER_BYTES = 25
const MAX_SUPPORTED_ARCHIVE_BYTES = 256 * 1024 ** 3
const MAX_SUPPORTED_BACKUP_ENTRIES = 250_000
const MAX_PATH_BYTES = 4096
const MAX_SUPPORTED_MANIFEST_BYTES = 128 * 1024 * 1024
const IO_CHUNK_BYTES = 128 * 1024
const PRIVATE_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker'])

export class ServerBackupError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

type BackupKind = 'manual' | 'pre-restore'
type BackupOrigin = 'manual' | 'scheduled' | 'system'
type ExclusionReason = 'private-panel-data' | 'private-system-data' | 'private-credential' | 'symlink' | 'hardlink' | 'special-file' | 'nested-mount' | 'unsafe-path'
type ManifestEntry = { path: string; kind: 'file' | 'directory'; sizeBytes: number; mode: number; modifiedAtMs: number; sha256: string | null }
type ExcludedEntry = { path: string; reason: ExclusionReason }
type BackupManifest = {
  version: 1
  backupId: string
  serverId: string
  kind: BackupKind
  createdAt: string
  archiveSizeBytes: number
  archiveSha256: string
  worldPaths: string[]
  entryCount: number
  fileCount: number
  totalFileBytes: number
  excludedCount: number
  excluded: ExcludedEntry[]
  excludedPathsTruncated: boolean
  entries: ManifestEntry[]
}
type ScannedEntry = ManifestEntry & { dev: number; ino: number; nlink: number; ctimeMs: number }
type DirectoryIdentity = { path: string; dev: number; ino: number; mtimeMs: number; ctimeMs: number }
type ServerRow = typeof localServers.$inferSelect
type BackupRow = typeof localServerBackups.$inferSelect
type ServiceHooks = {
  beforeInstall?: () => void | Promise<void>
  operationClock?: () => number
  availableBytes?: (path: string) => Promise<number>
  manifestLimitBytes?: number
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function inside(root: string, path: string): boolean {
  const value = relative(root, path)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}
function backupPath(value: string): boolean {
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES || value.startsWith('/') || value.includes('\\')
    || Array.from(value).some((char) => { const code = char.charCodeAt(0); return code <= 31 || code === 127 || code === 0xfffd })) return false
  const parts = value.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && Buffer.byteLength(part, 'utf8') <= 255)
}
function exclusion(path: string): ExclusionReason | null {
  const parts = path.split('/')
  if (parts.some((part) => PRIVATE_SEGMENTS.has(part))) return 'private-system-data'
  const name = (parts.at(-1) ?? '').toLowerCase()
  if (/^mmsmanager\.sqlite(?:-(?:wal|shm))?$/.test(name)) return 'private-system-data'
  if (/^\.env(?:\.|$)/.test(name) || /^(?:id_(?:rsa|ed25519|ecdsa|dsa)|credentials|secrets|auth|token|access_token|refresh_token)(?:\.[^.]+)?$/.test(name)
    || /^(?:\.npmrc|\.netrc|\.pypirc|authorized_keys)$/.test(name) || /\.(?:pem|key|p12|pfx)$/.test(name)) return 'private-credential'
  return null
}
function asSafeInteger(value: bigint): number | null {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
}
function safeMode(mode: number): number {
  const safe = mode & 0o755
  return safe === 0 ? 0o600 : safe
}
function manifestShape(value: unknown): value is BackupManifest {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<BackupManifest>
  if (item.version !== 1 || typeof item.backupId !== 'string' || typeof item.serverId !== 'string'
    || !['manual', 'pre-restore'].includes(String(item.kind)) || typeof item.createdAt !== 'string'
    || !Number.isSafeInteger(item.archiveSizeBytes) || typeof item.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.archiveSha256)
    || !Number.isInteger(item.entryCount) || !Number.isInteger(item.fileCount) || typeof item.totalFileBytes !== 'number' || !Number.isSafeInteger(item.totalFileBytes)
    || typeof item.excludedCount !== 'number' || !Number.isInteger(item.excludedCount) || !Array.isArray(item.entries) || item.entries.length > MAX_SUPPORTED_BACKUP_ENTRIES
    || !Array.isArray(item.excluded) || item.excluded.length > 1000 || typeof item.excludedPathsTruncated !== 'boolean'
    || !Array.isArray(item.worldPaths) || item.worldPaths.length > 100 || item.worldPaths.some((path) => typeof path !== 'string' || !backupPath(path))
    || new Set(item.worldPaths).size !== item.worldPaths.length) return false
  for (const entry of item.entries) {
    if (typeof entry !== 'object' || entry === null || !backupPath(entry.path) || !['file', 'directory'].includes(entry.kind)
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !Number.isInteger(entry.mode) || !Number.isSafeInteger(entry.modifiedAtMs)
      || (entry.kind === 'file' ? typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) : entry.sha256 !== null || entry.sizeBytes !== 0)) return false
  }
  for (const skipped of item.excluded) {
    if (typeof skipped !== 'object' || skipped === null || !backupPath(skipped.path)
      || !['private-panel-data', 'private-system-data', 'private-credential', 'symlink', 'hardlink', 'special-file', 'nested-mount', 'unsafe-path'].includes(skipped.reason)) return false
  }
  return item.entryCount === item.entries.length && item.fileCount === item.entries.filter((entry) => entry.kind === 'file').length
    && item.excludedCount >= item.excluded.length && item.totalFileBytes >= 0
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null)
    if (result.bytesWritten <= 0) throw new ServerBackupError('BACKUP_WRITE_FAILED', 'The archive could not be written completely.')
    offset += result.bytesWritten
  }
}
async function readExact(handle: FileHandle, position: number, size: number): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0 || size > Math.max(IO_CHUNK_BYTES, MAX_PATH_BYTES + ENTRY_HEADER_BYTES)) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive contains an invalid record size.')
  const buffer = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const result = await handle.read(buffer, offset, size - offset, position + offset)
    if (result.bytesRead <= 0) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive ended before its manifest record was complete.')
    offset += result.bytesRead
  }
  return buffer
}
function entryHeader(entry: ManifestEntry): Buffer {
  const pathBytes = Buffer.from(entry.path, 'utf8')
  const header = Buffer.alloc(ENTRY_HEADER_BYTES)
  header[0] = entry.kind === 'file' ? 1 : 2
  header.writeUInt32BE(pathBytes.byteLength, 1)
  header.writeUInt32BE(entry.mode, 5)
  header.writeBigInt64BE(BigInt(entry.modifiedAtMs), 9)
  header.writeBigUInt64BE(BigInt(entry.sizeBytes), 17)
  return Buffer.concat([header, pathBytes])
}

export class ServerBackupService {
  private readonly backupRoot: string
  private readonly now: () => number
  private readonly hooks: ServiceHooks
  private snapshotQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: AppDatabase,
    private readonly servers: ServerRegistry,
    private readonly processes: ServerProcessManager,
    now: () => number = Date.now,
    hooks: ServiceHooks = {},
  ) {
    this.backupRoot = join(servers.dataDirectory, 'server-backups')
    this.now = now
    this.hooks = hooks
  }

  async prepare(): Promise<void> {
    await mkdir(this.backupRoot, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.backupRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(this.backupRoot) !== resolve(this.backupRoot)) {
      throw new ServerBackupError('BACKUP_DIRECTORY_UNSAFE', 'The private backup root must be a real directory outside the live server tree.')
    }
    await chmod(this.backupRoot, 0o700)
    await this.recoverBackupStages()
    await this.recoverInterruptedRestores()
  }

  async list(serverId: string) {
    const server = this.serverRow(serverId)
    this.requireManaged(server)
    const rows = this.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, serverId))
      .orderBy(desc(localServerBackups.createdAt)).limit(501).all()
    const [settings, storage] = await Promise.all([this.getSettings(), this.storageMetrics()])
    const runtimeStatus = this.runtimeStatus(serverId)
    return {
      serverId,
      items: rows.slice(0, 500).map((row) => this.publicBackup(row)),
      truncated: rows.length > 500,
      storageUsedBytes: storage.usedBytes,
      storageLimitBytes: settings.storageQuotaBytes,
      storageAvailableBytes: storage.availableBytes,
      quotaWarning: settings.storageQuotaBytes !== null && storage.usedBytes >= settings.storageQuotaBytes * 0.8,
      runtimeStatus,
    }
  }

  async settingsOverview() {
    const [settings, storage] = await Promise.all([this.getSettings(), this.storageMetrics()])
    return { ...settings, storageUsedBytes: storage.usedBytes, storageAvailableBytes: storage.availableBytes }
  }

  async updateSettings(input: BackupSettings) {
    const settings = backupSettingsSchema.parse(input)
    const updatedAt = new Date(this.now()).toISOString()
    this.db.insert(backupSettingsTable).values({ id: 1, ...settings, updatedAt })
      .onConflictDoUpdate({ target: backupSettingsTable.id, set: { ...settings, updatedAt } }).run()
    return this.settingsOverview()
  }

  async create(serverId: string, actorUserId: string | null, options: { signal?: AbortSignal; onArchiveProgress?: (bytes: number) => void; origin?: 'manual' | 'scheduled' } = {}) {
    return this.processes.withStoppedServerOperation(serverId, async () => {
      const server = await this.safeServerDirectory(serverId)
      return this.createSnapshot(server, actorUserId, 'manual', options.origin ?? 'manual', options)
    })
  }

  async preview(serverId: string, backupId: string) {
    const server = this.serverRow(serverId)
    this.requireManaged(server)
    const row = this.backupRow(serverId, backupId)
    const base = {
      backup: this.publicBackup(row),
      integrityValid: false,
      serverStopped: this.runtimeStatus(serverId) === 'stopped',
      canRestore: false,
      confirmationText: `RESTORE ${server.name}`,
      issue: null as string | null,
      entries: [] as { path: string; kind: 'file' | 'directory'; sizeBytes: number; sha256: string | null }[],
      entriesTruncated: false,
      excludedPaths: [] as ExcludedEntry[],
      excludedPathsTruncated: false,
    }
    try {
      const { manifest } = await this.verifyBackup(row, null)
      const status = this.runtimeStatus(serverId)
      return {
        ...base,
        integrityValid: true,
        serverStopped: status === 'stopped',
        canRestore: status === 'stopped' && !this.hasUnresolvedRestore(serverId),
        issue: status === 'stopped' ? null : `Restore is available only while stopped. Current state: ${status}.`,
        entries: manifest.entries.slice(0, 100).map(({ path, kind, sizeBytes, sha256 }) => ({ path, kind, sizeBytes, sha256 })),
        entriesTruncated: manifest.entries.length > 100,
        excludedPaths: manifest.excluded.slice(0, 50),
        excludedPathsTruncated: manifest.excludedPathsTruncated || manifest.excluded.length > 50,
      }
    } catch (error) {
      const issue = error instanceof ServerBackupError && error.code.includes('CHECKSUM')
        ? 'The archive or manifest checksum does not match the completed backup ledger.'
        : 'The archive is missing, unsafe, or does not match its manifest. It cannot be restored.'
      return { ...base, issue }
    }
  }

  async openDownload(serverId: string, backupId: string) {
    this.requireManaged(this.serverRow(serverId))
    const row = this.backupRow(serverId, backupId)
    const verified = await this.verifyBackup(row, null)
    const { archiveHandle, archiveStat } = await this.openVerifiedArchive(row)
    if (archiveStat.dev !== verified.archiveIdentity.dev || archiveStat.ino !== verified.archiveIdentity.ino || archiveStat.size !== verified.archiveIdentity.size
      || archiveStat.mtimeMs !== verified.archiveIdentity.mtimeMs || archiveStat.ctimeMs !== verified.archiveIdentity.ctimeMs) {
      await archiveHandle.close()
      throw new ServerBackupError('BACKUP_CHECKSUM_FAILED', 'The archive changed after verification and cannot be downloaded.')
    }
    return { backup: this.publicBackup(row), handle: archiveHandle, sizeBytes: archiveStat.size }
  }

  async hasWorldSnapshot(serverId: string, worldPath: string): Promise<boolean> {
    this.requireManaged(this.serverRow(serverId))
    if (!backupPath(worldPath)) return false
    const rows = this.db.select().from(localServerBackups)
      .where(eq(localServerBackups.serverId, serverId)).orderBy(desc(localServerBackups.createdAt)).limit(500).all()
    for (const row of rows) {
      if (Buffer.byteLength(row.worldPathsJson, 'utf8') > 512 * 1024) continue
      let paths: unknown
      try { paths = JSON.parse(row.worldPathsJson) } catch { continue }
      if (Array.isArray(paths) && paths.includes(worldPath) && await this.privateBackupFilesAvailable(row)) return true
    }
    return false
  }

  private async privateBackupFilesAvailable(row: BackupRow): Promise<boolean> {
    if (row.directoryName !== row.id || !/^[0-9a-f-]{36}$/.test(row.id) || !/^[0-9a-f-]{36}$/.test(row.serverId)) return false
    const backupRootStat = await lstat(this.backupRoot).catch(() => null)
    if (!backupRootStat?.isDirectory() || backupRootStat.isSymbolicLink() || await realpath(this.backupRoot).catch(() => '') !== resolve(this.backupRoot)) return false
    const parent = join(this.backupRoot, row.serverId)
    const directory = join(parent, row.directoryName)
    const parentStat = await lstat(parent).catch(() => null)
    const directoryStat = await lstat(directory).catch(() => null)
    if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || parentStat.dev !== backupRootStat.dev || (parentStat.mode & 0o077) !== 0 || await realpath(parent).catch(() => '') !== parent
      || !directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.dev !== parentStat.dev || (directoryStat.mode & 0o077) !== 0 || await realpath(directory).catch(() => '') !== directory) return false
    const manifest = await lstat(join(directory, 'manifest.json')).catch(() => null)
    const archive = await lstat(join(directory, 'snapshot.mmsbackup')).catch(() => null)
    return Boolean(manifest?.isFile() && !manifest.isSymbolicLink() && manifest.nlink === 1 && (manifest.mode & 0o077) === 0 && manifest.size === row.manifestSizeBytes
      && archive?.isFile() && !archive.isSymbolicLink() && archive.nlink === 1 && (archive.mode & 0o077) === 0 && archive.size === row.archiveSizeBytes)
  }

  async restore(serverId: string, actorUserId: string, backupId: string, confirmation: string) {
    return this.processes.withStoppedServerOperation(serverId, async () => {
      const settings = await this.getSettings()
      const operationDeadline = this.deadline(settings)
      const server = await this.safeServerDirectory(serverId)
      if (confirmation !== `RESTORE ${server.row.name}`) {
        throw new ServerBackupError('RESTORE_CONFIRMATION_FAILED', `Type RESTORE ${server.row.name} exactly to confirm replacement.`)
      }
      const selected = this.backupRow(serverId, backupId)
      const { manifest } = await this.verifyBackup(selected, null, operationDeadline)
      const safety = await this.createSnapshot(server, actorUserId, 'pre-restore', 'system', { settings, deadline: operationDeadline })
      const restoreId = randomUUID()
      const stageName = `.mmsmanager-restore-${restoreId}.stage`
      const rollbackName = `.mmsmanager-restore-${restoreId}.rollback`
      const stagePath = join(this.servers.managedRoot, stageName)
      const rollbackPath = join(this.servers.managedRoot, rollbackName)
      const startedAt = new Date(this.now()).toISOString()
      this.db.insert(localServerBackupRestores).values({
        id: restoreId, serverId, backupId, safetyBackupId: safety.id, actorUserId, startedAt, completedAt: null,
        status: 'prepared', stagingName: stageName, rollbackName, errorCode: null,
      }).run()
      let currentMoved = false
      try {
        const extracted = await this.verifyBackup(selected, stagePath, operationDeadline)
        if (extracted.manifest.archiveSha256 !== manifest.archiveSha256) throw new ServerBackupError('BACKUP_CHECKSUM_FAILED', 'The selected archive changed before restore.')
        await this.assertSameServerDirectory(server)
        await this.ensureSiblingPathAvailable(rollbackPath)
        const stagedRoot = await lstat(stagePath)
        if (!stagedRoot.isDirectory() || stagedRoot.isSymbolicLink() || await realpath(stagePath) !== stagePath) throw new ServerBackupError('RESTORE_STAGE_UNSAFE', 'The restored server staging directory changed before installation.')
        await rename(server.directory, rollbackPath)
        currentMoved = true
        await this.hooks.beforeInstall?.()
        await rename(stagePath, server.directory)
        const installedStat = await lstat(server.directory)
        if (!installedStat.isDirectory() || installedStat.isSymbolicLink() || installedStat.dev !== stagedRoot.dev || installedStat.ino !== stagedRoot.ino || await realpath(server.directory) !== server.directory) {
          throw new ServerBackupError('RESTORE_INSTALL_FAILED', 'The restored server directory did not pass its post-install identity check.')
        }
        const completedAt = new Date(this.now()).toISOString()
        this.db.transaction((tx) => {
          tx.update(localServerRuntime).set({ restartRequired: false, updatedAt: completedAt }).where(eq(localServerRuntime.serverId, serverId)).run()
          tx.update(localServerBackupRestores).set({ status: 'completed', completedAt, errorCode: null }).where(eq(localServerBackupRestores.id, restoreId)).run()
          tx.insert(localServerEvents).values({ serverId, actorUserId, action: 'server-backup-restore', outcome: 'success', occurredAt: completedAt, detail: JSON.stringify({ backupId, safetyBackupId: safety.id, restoreId, fileCount: manifest.fileCount, totalFileBytes: manifest.totalFileBytes }) }).run()
        })
        let rollbackCleanupPending = false
        try { await this.removeOwnedTree(rollbackPath, this.servers.managedRoot) }
        catch { rollbackCleanupPending = true }
        return {
          ok: true as const, restoreId, backupId, safetyBackupId: safety.id, restoredFileCount: manifest.fileCount,
          restoredDirectoryCount: manifest.entryCount - manifest.fileCount, restoredBytes: manifest.totalFileBytes,
          completedAt, rollbackCleanupPending,
        }
      } catch (error) {
        let rollbackFailed = false
        let stagingCleanupFailed = false
        if (currentMoved) {
          try {
            const targetStat = await lstat(server.directory).catch(() => null)
            if (targetStat) await this.removeOwnedTree(server.directory, this.servers.managedRoot)
            await rename(rollbackPath, server.directory)
            currentMoved = false
          } catch { rollbackFailed = true }
        }
        if (!currentMoved && !rollbackFailed) {
          try { await this.removeOwnedTree(stagePath, this.servers.managedRoot) }
          catch { stagingCleanupFailed = true }
        }
        if (!currentMoved && !rollbackFailed && !stagingCleanupFailed) {
          this.db.update(localServerBackupRestores).set({ status: 'rolled-back', completedAt: new Date(this.now()).toISOString(), errorCode: error instanceof ServerBackupError ? error.code : 'RESTORE_FAILED' }).where(eq(localServerBackupRestores.id, restoreId)).run()
        } else {
          this.db.update(localServerBackupRestores).set({ status: 'recovery-required', errorCode: rollbackFailed ? 'RESTORE_ROLLBACK_FAILED' : 'RESTORE_STAGE_CLEANUP_FAILED' }).where(eq(localServerBackupRestores.id, restoreId)).run()
        }
        const failureAt = new Date(this.now()).toISOString()
        this.recordEvent(serverId, actorUserId, 'server-backup-restore', 'failure', { backupId, safetyBackupId: safety.id, restoreId, code: error instanceof ServerBackupError ? error.code : 'RESTORE_FAILED' }, failureAt)
        if (rollbackFailed) throw new ServerBackupError('RESTORE_ROLLBACK_FAILED', 'Restore failed and the original directory could not be put back. Server start is blocked until recovery is reviewed.')
        if (stagingCleanupFailed) throw new ServerBackupError('RESTORE_RECOVERY_REQUIRED', 'The original server folder remains in place, but a private staging folder could not be safely removed. Server start is blocked until startup recovery succeeds.')
        if (error instanceof ServerBackupError) throw error
        throw new ServerBackupError('RESTORE_FAILED', 'The snapshot could not be installed. The original server directory was restored.')
      }
    })
  }

  private async createSnapshot(server: { row: ServerRow; directory: string; root: string; rootDevice: number; rootInode: number; serverInode: number }, actorUserId: string | null, kind: BackupKind, origin: BackupOrigin, options: { signal?: AbortSignal; onArchiveProgress?: (bytes: number) => void; settings?: BackupSettings; deadline?: number } = {}) {
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const previous = this.snapshotQueue
    this.snapshotQueue = previous.then(() => gate, () => gate)
    await previous.catch(() => undefined)
    try { return await this.writeSnapshot(server, actorUserId, kind, origin, options) }
    finally { release() }
  }

  private async writeSnapshot(server: { row: ServerRow; directory: string; root: string; rootDevice: number; rootInode: number; serverInode: number }, actorUserId: string | null, kind: BackupKind, origin: BackupOrigin, options: { signal?: AbortSignal; onArchiveProgress?: (bytes: number) => void; settings?: BackupSettings; deadline?: number } = {}) {
    const settings = options.settings ?? await this.getSettings()
    const operationDeadline = options.deadline ?? this.deadline(settings)
    const manifestLimitBytes = Math.min(MAX_SUPPORTED_MANIFEST_BYTES, this.hooks.manifestLimitBytes ?? MAX_SUPPORTED_MANIFEST_BYTES)
    await this.assertSameServerDirectory(server)
    const scan = await this.scan(server, options.signal, operationDeadline, settings)
    const worldCandidates = await this.worldCandidates(server)
    const exclusionsAreMapped = scan.excludedCount === scan.excluded.length && !scan.excluded.some((entry) => entry.reason === 'unsafe-path')
    const worldPaths = [...worldCandidates].filter((path) => scan.directories.has(path) && exclusionsAreMapped
      && !scan.excluded.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`))).sort()
    const estimate = ARCHIVE_MAGIC.byteLength + ENTRY_HEADER_BYTES + 12 + ARCHIVE_END.byteLength
      + scan.entries.reduce((total, entry) => total + ENTRY_HEADER_BYTES + Buffer.byteLength(entry.path, 'utf8') + entry.sizeBytes + (entry.kind === 'file' ? 32 : 0), 0)
    if (!Number.isSafeInteger(estimate) || estimate > settings.maxArchiveBytes) throw new ServerBackupError('BACKUP_ARCHIVE_LIMIT', 'This server snapshot exceeds the configured maximum archive size.')
    const id = randomUUID()
    const createdAt = new Date(this.now()).toISOString()
    const fileCountEstimate = scan.entries.filter((entry) => entry.kind === 'file').length
    const manifestBase = JSON.stringify({
      version: 1, backupId: id, serverId: server.row.id, kind, createdAt, archiveSizeBytes: estimate, archiveSha256: '0'.repeat(64),
      entryCount: scan.entries.length, fileCount: fileCountEstimate, totalFileBytes: scan.totalBytes, excludedCount: scan.excludedCount,
      excluded: scan.excluded, excludedPathsTruncated: scan.excludedCount > scan.excluded.length, worldPaths, entries: [],
    })
    let manifestSizeEstimate = Buffer.byteLength(manifestBase, 'utf8')
    for (const [index, entry] of scan.entries.entries()) {
      const metadata: ManifestEntry = { path: entry.path, kind: entry.kind, sizeBytes: entry.sizeBytes, mode: safeMode(entry.mode), modifiedAtMs: Math.trunc(entry.modifiedAtMs), sha256: entry.kind === 'file' ? '0'.repeat(64) : null }
      manifestSizeEstimate += Buffer.byteLength(JSON.stringify(metadata), 'utf8') + (index === 0 ? 0 : 1)
    }
    if (!Number.isSafeInteger(manifestSizeEstimate) || manifestSizeEstimate > manifestLimitBytes) throw new ServerBackupError('BACKUP_MANIFEST_LIMIT', 'The backup manifest exceeds the supported safe metadata size.')
    const operationSizeEstimate = estimate + manifestSizeEstimate
    const usedBytes = this.db.select({ value: sql<number>`coalesce(sum(${localServerBackups.archiveSizeBytes} + ${localServerBackups.manifestSizeBytes}), 0)` }).from(localServerBackups).get()?.value ?? 0
    if (settings.storageQuotaBytes !== null && usedBytes + operationSizeEstimate > settings.storageQuotaBytes) throw new ServerBackupError('BACKUP_QUOTA_EXCEEDED', 'The configured private backup storage quota would be exceeded. Existing snapshots were not removed.')
    let availableBytes: number
    try {
      const free = this.hooks.availableBytes ? null : await statfs(this.backupRoot)
      availableBytes = this.hooks.availableBytes ? await this.hooks.availableBytes(this.backupRoot) : Number(free!.bavail) * Number(free!.bsize)
    } catch {
      throw new ServerBackupError('BACKUP_SPACE_UNAVAILABLE', 'Free space could not be verified, so the backup was not started.')
    }
    if (!Number.isFinite(availableBytes) || availableBytes < 0) throw new ServerBackupError('BACKUP_SPACE_UNAVAILABLE', 'Free space could not be verified, so the backup was not started.')
    if (Number.isFinite(availableBytes) && availableBytes < operationSizeEstimate + 32 * 1024 * 1024) throw new ServerBackupError('BACKUP_DISK_SPACE', 'There is not enough free space for this snapshot plus a safety margin.')
    const parent = join(this.backupRoot, server.row.id)
    await this.ensurePrivateDirectory(parent, this.backupRoot)
    const stageDirectoryName = `.${id}.staging`
    const stageDirectory = join(parent, stageDirectoryName)
    const finalDirectory = join(parent, id)
    await mkdir(stageDirectory, { mode: 0o700 })
    let archiveHandle: FileHandle | null = null
    try {
      archiveHandle = await open(join(stageDirectory, 'snapshot.mmsbackup'), 'wx', 0o600)
      const archiveHash = createHash('sha256')
      let writtenBytes = 0
      const append = async (bytes: Buffer) => {
        if (options.signal?.aborted) throw new ServerBackupError('BACKUP_INTERRUPTED', 'The backup was interrupted before atomic completion.')
        if (this.timeNow() > operationDeadline) throw new ServerBackupError('BACKUP_TIMEOUT', 'The backup exceeded the configured operation time limit.')
        if (writtenBytes + bytes.byteLength > settings.maxArchiveBytes) throw new ServerBackupError('BACKUP_ARCHIVE_LIMIT', 'The archive exceeded the configured maximum size while streaming.')
        await writeAll(archiveHandle!, bytes)
        archiveHash.update(bytes)
        writtenBytes += bytes.byteLength
        options.onArchiveProgress?.(writtenBytes)
      }
      await append(ARCHIVE_MAGIC)
      const manifestEntries: ManifestEntry[] = []
      let totalFileBytes = 0
      let fileCount = 0
      for (const entry of scan.entries) {
        if (options.signal?.aborted) throw new ServerBackupError('BACKUP_INTERRUPTED', 'The backup was interrupted before atomic completion.')
        const metadata: ManifestEntry = { path: entry.path, kind: entry.kind, sizeBytes: entry.sizeBytes, mode: safeMode(entry.mode), modifiedAtMs: Math.trunc(entry.modifiedAtMs), sha256: null }
        await append(entryHeader(metadata))
        if (entry.kind === 'file') {
          const filePath = join(server.directory, ...entry.path.split('/'))
          await this.assertParentIdentity(server, dirname(entry.path) === '.' ? '' : dirname(entry.path).split(sep).join('/'), scan.directories)
          let input: FileHandle | null = null
          try {
            input = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
            const before = await input.stat()
            if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.sizeBytes || Math.trunc(before.mtimeMs) !== entry.modifiedAtMs || before.ctimeMs !== entry.ctimeMs) {
              throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', `The server file changed during snapshot: ${entry.path}`)
            }
            const fileHash = createHash('sha256')
            let offset = 0
            while (offset < entry.sizeBytes) {
              const length = Math.min(IO_CHUNK_BYTES, entry.sizeBytes - offset)
              const buffer = Buffer.allocUnsafe(length)
              const read = await input.read(buffer, 0, length, offset)
              if (read.bytesRead <= 0) throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', `The server file ended while being copied: ${entry.path}`)
              const chunk = buffer.subarray(0, read.bytesRead)
              fileHash.update(chunk)
              await append(chunk)
              offset += read.bytesRead
            }
            const after = await input.stat()
            if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
              throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', `The server file changed while its snapshot was being copied: ${entry.path}`)
            }
            const digest = fileHash.digest('hex')
            const digestBytes = Buffer.from(digest, 'hex')
            await append(digestBytes)
            metadata.sha256 = digest
            totalFileBytes += entry.sizeBytes
            fileCount += 1
          } finally { await input?.close() }
        }
        manifestEntries.push(metadata)
      }
      const footer = Buffer.alloc(ENTRY_HEADER_BYTES + 12 + ARCHIVE_END.byteLength)
      footer[0] = 0
      footer.writeUInt32BE(0, 1)
      footer.writeUInt32BE(0, 5)
      footer.writeBigInt64BE(0n, 9)
      footer.writeBigUInt64BE(0n, 17)
      footer.writeUInt32BE(manifestEntries.length, ENTRY_HEADER_BYTES)
      footer.writeBigUInt64BE(BigInt(totalFileBytes), ENTRY_HEADER_BYTES + 4)
      ARCHIVE_END.copy(footer, ENTRY_HEADER_BYTES + 12)
      await append(footer)
      if (options.signal?.aborted) throw new ServerBackupError('BACKUP_INTERRUPTED', 'The backup was interrupted before atomic completion.')
      await archiveHandle.sync()
      const archiveSizeBytes = (await archiveHandle.stat()).size
      const archiveSha256 = archiveHash.digest('hex')
      await archiveHandle.close()
      archiveHandle = null
      await this.assertDirectoriesUnchanged(server, scan.directories)
      const manifest: BackupManifest = {
        version: 1, backupId: id, serverId: server.row.id, kind, createdAt, archiveSizeBytes, archiveSha256, worldPaths,
        entryCount: manifestEntries.length, fileCount, totalFileBytes, excludedCount: scan.excludedCount,
        excluded: scan.excluded, excludedPathsTruncated: scan.excludedCount > scan.excluded.length, entries: manifestEntries,
      }
      const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
      if (manifestBytes.byteLength > manifestLimitBytes) throw new ServerBackupError('BACKUP_MANIFEST_LIMIT', 'The backup manifest exceeded the supported safe metadata size.')
      if (manifestBytes.byteLength !== manifestSizeEstimate) throw new ServerBackupError('BACKUP_MANIFEST_MISMATCH', 'The final manifest size differed from its bounded preflight estimate.')
      const manifestHandle = await open(join(stageDirectory, 'manifest.json'), 'wx', 0o600)
      try { await writeAll(manifestHandle, manifestBytes); await manifestHandle.sync() } finally { await manifestHandle.close() }
      await this.syncDirectory(stageDirectory)
      await this.ensureSiblingPathAvailable(finalDirectory)
      await rename(stageDirectory, finalDirectory)
      await this.syncDirectory(parent)
      const row = {
        id, serverId: server.row.id, actorUserId, kind, origin, directoryName: id, createdAt, archiveSizeBytes, manifestSizeBytes: manifestBytes.byteLength, worldPathsJson: JSON.stringify(worldPaths),
        archiveSha256, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        entryCount: manifest.entryCount, fileCount, totalFileBytes, excludedCount: scan.excludedCount,
      }
      try {
        this.db.transaction((tx) => {
          tx.insert(localServerBackups).values(row).run()
          tx.insert(localServerEvents).values({
            serverId: server.row.id, actorUserId, action: origin === 'scheduled' ? 'server-backup-scheduled' : kind === 'manual' ? 'server-backup-create' : 'server-backup-safety-copy', outcome: 'success', occurredAt: createdAt,
            detail: JSON.stringify({ backupId: id, kind, origin, archiveSizeBytes, entryCount: manifest.entryCount, fileCount, totalFileBytes, excludedCount: scan.excludedCount }),
          }).run()
        })
      } catch (error) {
        try { await this.removeOwnedTree(finalDirectory, parent) }
        catch {
          throw new ServerBackupError('BACKUP_CLEANUP_FAILED', 'The backup files were completed but the inventory transaction failed, and the private archive folder could not be safely removed. It is not listed as a completed backup and needs local review.')
        }
        throw error
      }
      return this.publicBackup(row)
    } catch (error) {
      await archiveHandle?.close().catch(() => undefined)
      let cleanupError: unknown = null
      try { await this.removeOwnedTree(stageDirectory, parent) } catch (failure) { cleanupError = failure }
      this.recordEvent(server.row.id, actorUserId, origin === 'scheduled' ? 'server-backup-scheduled' : kind === 'manual' ? 'server-backup-create' : 'server-backup-safety-copy', 'failure', { kind, origin, code: error instanceof ServerBackupError ? error.code : 'BACKUP_FAILED' }, new Date(this.now()).toISOString())
      if (cleanupError) throw new ServerBackupError('BACKUP_CLEANUP_FAILED', `The backup did not complete, and its private staging directory could not be safely removed. It was not added to the backup inventory. ${cleanupError instanceof Error ? cleanupError.message : ''}`)
      if (error instanceof ServerBackupError) throw error
      if (isNodeError(error) && error.code === 'ENOSPC') throw new ServerBackupError('BACKUP_DISK_SPACE', 'The backup storage ran out of free space while writing the snapshot.')
      throw new ServerBackupError('BACKUP_FAILED', 'The snapshot was not completed. No backup was added to the inventory.')
    }
  }

  private async worldCandidates(server: { row: ServerRow; directory: string }): Promise<string[]> {
    const candidates = new Set<string>()
    let levelName = 'world'
    const propertiesPath = join(server.directory, 'server.properties')
    const propertiesStat = await lstat(propertiesPath).catch(() => null)
    if (propertiesStat?.isFile() && !propertiesStat.isSymbolicLink() && propertiesStat.nlink === 1 && propertiesStat.size <= 65_536) {
      let handle: FileHandle | null = null
      try {
        handle = await open(propertiesPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const opened = await handle.stat()
        if (opened.isFile() && opened.dev === propertiesStat.dev && opened.ino === propertiesStat.ino && opened.nlink === 1 && opened.size <= 65_536) {
          const bytes = await handle.readFile()
          if (bytes.byteLength <= 65_536) {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
              const line = rawLine.trim()
              if (!line || line.startsWith('#') || line.startsWith('!')) continue
              const separator = line.indexOf('=')
              if (separator > 0 && line.slice(0, separator).trim() === 'level-name') levelName = line.slice(separator + 1).trim()
            }
          }
        }
      } catch { /* A missing or invalid properties file keeps Minecraft's default world candidate. */ }
      finally { await handle?.close().catch(() => undefined) }
    }
    const add = (path: string) => { if (candidates.size < 100 && backupPath(path)) candidates.add(path) }
    add(levelName)
    if (!levelName.includes('/')) { add(`${levelName}_nether`); add(`${levelName}_the_end`) }
    try {
      const registered: unknown = JSON.parse(server.row.worldFolders)
      if (Array.isArray(registered)) for (const path of registered) if (typeof path === 'string') add(path)
    } catch { /* Invalid registry metadata contributes no additional world paths. */ }
    return [...candidates]
  }

  private async scan(server: { row: ServerRow; directory: string; rootDevice: number }, signal: AbortSignal | undefined, deadline: number, settings: BackupSettings) {
    const entries: ScannedEntry[] = []
    const directories = new Map<string, DirectoryIdentity>()
    const excluded: ExcludedEntry[] = []
    let excludedCount = 0
    let totalBytes = 0
    const noteExcluded = (path: string, reason: ExclusionReason) => {
      excludedCount += 1
      if (excluded.length < 1000) excluded.push({ path: backupPath(path) ? path : '[unsafe filename]', reason })
    }
    const visit = async (absolute: string, relativePath: string, depth: number): Promise<void> => {
      if (signal?.aborted) throw new ServerBackupError('BACKUP_INTERRUPTED', 'The backup was interrupted while scanning the server folder.')
      if (this.timeNow() > deadline) throw new ServerBackupError('BACKUP_TIMEOUT', 'The backup exceeded the configured operation time limit while scanning.')
      if (depth > 64) throw new ServerBackupError('BACKUP_DEPTH_LIMIT', 'The server folder exceeds the 64-level safe nesting limit.')
      const before = await lstat(absolute)
      const canonical = await realpath(absolute).catch(() => '')
      if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== server.rootDevice || canonical !== absolute) {
        throw new ServerBackupError('SERVER_DIRECTORY_UNSAFE', 'A server directory changed, crossed a mount, or resolved outside its managed root during backup.')
      }
      const identity: DirectoryIdentity = { path: relativePath, dev: before.dev, ino: before.ino, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs }
      directories.set(relativePath, identity)
      let directoryHandle
      try { directoryHandle = await opendir(absolute, { bufferSize: 32 }) }
      catch { throw new ServerBackupError('BACKUP_READ_FAILED', `The server directory could not be enumerated${relativePath ? `: ${relativePath}` : ''}.`) }
      try {
        const opened = await lstat(absolute)
        if (!opened.isDirectory() || opened.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino || await realpath(absolute).catch(() => '') !== canonical) {
          throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', 'A server directory identity changed during backup.')
        }
        for await (const dirent of directoryHandle) {
          if (signal?.aborted) throw new ServerBackupError('BACKUP_INTERRUPTED', 'The backup was interrupted while scanning the server folder.')
          if (this.timeNow() > deadline) throw new ServerBackupError('BACKUP_TIMEOUT', 'The backup exceeded the configured operation time limit while scanning.')
          if (entries.length + excludedCount >= settings.maxEntries) throw new ServerBackupError('BACKUP_ENTRY_LIMIT', 'The server folder exceeds the configured file and folder limit.')
          const name = dirent.name
          const childRelative = relativePath ? `${relativePath}/${name}` : name
          const skip = backupPath(childRelative) ? exclusion(childRelative) : 'unsafe-path'
          if (skip) { noteExcluded(childRelative, skip); continue }
          const parentNow = await lstat(absolute)
          if (!parentNow.isDirectory() || parentNow.isSymbolicLink() || parentNow.dev !== identity.dev || parentNow.ino !== identity.ino || await realpath(absolute).catch(() => '') !== canonical) {
            throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', 'A server directory identity changed during backup.')
          }
          const child = join(absolute, name)
          const stat = await lstat(child).catch((error) => {
            if (isNodeError(error) && error.code === 'ENOENT') throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', `A server entry disappeared during backup: ${childRelative}`)
            throw error
          })
          if (stat.isSymbolicLink()) { noteExcluded(childRelative, 'symlink'); continue }
          if (stat.dev !== server.rootDevice) { noteExcluded(childRelative, 'nested-mount'); continue }
          if (stat.isDirectory()) {
            const canonicalChild = await realpath(child).catch(() => '')
            if (!inside(server.directory, canonicalChild)) { noteExcluded(childRelative, 'symlink'); continue }
            entries.push({ path: childRelative, kind: 'directory', sizeBytes: 0, mode: safeMode(stat.mode), modifiedAtMs: Math.trunc(stat.mtimeMs), sha256: null, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, ctimeMs: stat.ctimeMs })
            await visit(child, childRelative, depth + 1)
          } else if (stat.isFile()) {
            if (stat.nlink > 1) { noteExcluded(childRelative, 'hardlink'); continue }
            if (!Number.isSafeInteger(stat.size) || stat.size < 0 || totalBytes > settings.maxArchiveBytes - stat.size) throw new ServerBackupError('BACKUP_ARCHIVE_LIMIT', 'The server content exceeds the configured maximum archive size.')
            totalBytes += stat.size
            entries.push({ path: childRelative, kind: 'file', sizeBytes: stat.size, mode: safeMode(stat.mode), modifiedAtMs: Math.trunc(stat.mtimeMs), sha256: null, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, ctimeMs: stat.ctimeMs })
          } else noteExcluded(childRelative, 'special-file')
        }
      } finally { await directoryHandle.close().catch(() => undefined) }
    }
    await visit(server.directory, '', 0)
    return { entries, directories, excluded, excludedCount, totalBytes }
  }

  private async verifyBackup(row: BackupRow, extractRoot: string | null, deadline?: number) {
    const operationDeadline = deadline ?? this.deadline(await this.getSettings())
    const { archiveHandle, archiveStat, manifest } = await this.openVerifiedArchive(row)
    try {
      let position = 0
      const archiveHash = createHash('sha256')
      const readAndHash = async (at: number, count: number) => {
        const bytes = await readExact(archiveHandle, at, count)
        archiveHash.update(bytes)
        return bytes
      }
      const magic = await readAndHash(position, ARCHIVE_MAGIC.byteLength)
      position += magic.byteLength
      if (!magic.equals(ARCHIVE_MAGIC)) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive format header is invalid.')
      if (extractRoot) {
        await mkdir(extractRoot, { recursive: false, mode: 0o700 })
        const stageStat = await lstat(extractRoot)
        if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || await realpath(extractRoot) !== extractRoot) throw new ServerBackupError('RESTORE_STAGE_UNSAFE', 'The restore staging directory is linked or unavailable.')
        await chmod(extractRoot, 0o700)
      }
      const seen = new Set<string>()
      const extractedDirectories: { path: string; mode: number; modifiedAtMs: number }[] = []
      let recordIndex = 0
      let totalFileBytes = 0
      let fileCount = 0
      let footerSeen = false
      while (position < archiveStat.size) {
        if (this.timeNow() > operationDeadline) throw new ServerBackupError('BACKUP_TIMEOUT', 'The backup operation exceeded its configured time limit during verification or restore.')
        const header = await readAndHash(position, ENTRY_HEADER_BYTES)
        position += ENTRY_HEADER_BYTES
        const kindCode = header[0]
        const pathLength = header.readUInt32BE(1)
        const mode = header.readUInt32BE(5)
        const modifiedAtBig = header.readBigInt64BE(9)
        const sizeBig = header.readBigUInt64BE(17)
        if (kindCode === 0) {
          if (pathLength !== 0 || mode !== 0 || modifiedAtBig !== 0n || sizeBig !== 0n) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive terminator is malformed.')
          const footer = await readAndHash(position, 12 + ARCHIVE_END.byteLength)
          position += footer.byteLength
          const footerCount = footer.readUInt32BE(0)
          const footerBytes = asSafeInteger(footer.readBigUInt64BE(4))
          if (footerCount !== recordIndex || footerBytes !== totalFileBytes || !footer.subarray(12).equals(ARCHIVE_END) || position !== archiveStat.size) {
            throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive footer or total size is invalid.')
          }
          footerSeen = true
          break
        }
        if (kindCode !== 1 && kindCode !== 2) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive contains an unknown entry type.')
        if (pathLength < 1 || pathLength > MAX_PATH_BYTES) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive contains an unsafe path length.')
        const pathBytes = await readAndHash(position, pathLength)
        position += pathLength
        const entryPath = new TextDecoder('utf-8', { fatal: true }).decode(pathBytes)
        if (!backupPath(entryPath) || seen.has(entryPath) || exclusion(entryPath)) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive contains an unsafe or duplicate path.')
        seen.add(entryPath)
        const sizeBytes = asSafeInteger(sizeBig)
        const modifiedAtMs = Number(modifiedAtBig)
        if (sizeBytes === null || sizeBytes > MAX_SUPPORTED_ARCHIVE_BYTES || !Number.isSafeInteger(modifiedAtMs) || safeMode(mode) !== mode) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive entry metadata is outside supported bounds.')
        const entryKind = kindCode === 1 ? 'file' : 'directory'
        const manifestEntry = manifest.entries[recordIndex]
        if (!manifestEntry || manifestEntry.path !== entryPath || manifestEntry.kind !== entryKind || manifestEntry.sizeBytes !== sizeBytes || manifestEntry.mode !== mode || manifestEntry.modifiedAtMs !== modifiedAtMs) {
          throw new ServerBackupError('BACKUP_MANIFEST_MISMATCH', 'An archive record does not match its private manifest.')
        }
        const parent = dirname(entryPath) === '.' ? '' : dirname(entryPath).split(sep).join('/')
        if (parent && !seen.has(parent)) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'The archive contains an entry before its parent directory.')
        let output: FileHandle | null = null
        if (extractRoot) {
          const outputPath = join(extractRoot, ...entryPath.split('/'))
          if (!inside(extractRoot, resolve(outputPath))) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'An archive path escaped its restore staging directory.')
          if (entryKind === 'directory') {
            await mkdir(outputPath, { mode: 0o700 })
          } else {
            const parentPath = dirname(outputPath)
            const parentStat = await lstat(parentPath)
            if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'An archive file parent is missing or unsafe.')
            output = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
          }
        }
        const entryHash = createHash('sha256')
        if (entryKind === 'directory') {
          if (sizeBytes !== 0 || manifestEntry.sha256 !== null) throw new ServerBackupError('BACKUP_ARCHIVE_INVALID', 'A directory record contains file content metadata.')
          if (extractRoot) extractedDirectories.push({ path: join(extractRoot, ...entryPath.split('/')), mode, modifiedAtMs })
        } else {
          let consumed = 0
          try {
            while (consumed < sizeBytes) {
              if (this.timeNow() > operationDeadline) throw new ServerBackupError('BACKUP_TIMEOUT', 'The backup operation exceeded its configured time limit during verification or restore.')
              const length = Math.min(IO_CHUNK_BYTES, sizeBytes - consumed)
              const buffer = await readExact(archiveHandle, position, length)
              position += buffer.byteLength
              consumed += buffer.byteLength
              entryHash.update(buffer)
              archiveHash.update(buffer)
              if (output) await writeAll(output, buffer)
            }
            const digestBytes = await readAndHash(position, 32)
            position += 32
            const digest = entryHash.digest('hex')
            if (digestBytes.toString('hex') !== digest || manifestEntry.sha256 !== digest) throw new ServerBackupError('BACKUP_CHECKSUM_FAILED', `The stored file checksum does not match: ${entryPath}`)
            if (output) {
              await output.sync()
              await output.close()
              output = null
              const outputPath = join(extractRoot!, ...entryPath.split('/'))
              await chmod(outputPath, safeMode(mode))
              const modifiedAt = new Date(modifiedAtMs)
              await utimes(outputPath, modifiedAt, modifiedAt)
            }
            totalFileBytes += sizeBytes
            fileCount += 1
          } finally { await output?.close().catch(() => undefined) }
        }
        recordIndex += 1
      }
      if (!footerSeen || recordIndex !== manifest.entryCount || fileCount !== manifest.fileCount || totalFileBytes !== manifest.totalFileBytes) {
        throw new ServerBackupError('BACKUP_MANIFEST_MISMATCH', 'The archive entry totals do not match the private manifest.')
      }
      const computedArchiveSha256 = archiveHash.digest('hex')
      if (computedArchiveSha256 !== row.archiveSha256 || computedArchiveSha256 !== manifest.archiveSha256) throw new ServerBackupError('BACKUP_CHECKSUM_FAILED', 'The archive SHA-256 checksum does not match the backup ledger.')
      const finalArchiveStat = await archiveHandle.stat()
      if (finalArchiveStat.dev !== archiveStat.dev || finalArchiveStat.ino !== archiveStat.ino || finalArchiveStat.size !== archiveStat.size
        || finalArchiveStat.mtimeMs !== archiveStat.mtimeMs || finalArchiveStat.ctimeMs !== archiveStat.ctimeMs) throw new ServerBackupError('BACKUP_CHECKSUM_FAILED', 'The archive changed during checksum verification.')
      if (extractRoot) {
        for (const directory of extractedDirectories.reverse()) {
          await chmod(directory.path, safeMode(directory.mode))
          const modifiedAt = new Date(directory.modifiedAtMs)
          await utimes(directory.path, modifiedAt, modifiedAt)
        }
      }
      return { manifest, archiveIdentity: finalArchiveStat }
    } finally { await archiveHandle.close() }
  }

  private async openVerifiedArchive(row: BackupRow) {
    if (row.directoryName !== row.id || !/^[0-9a-f-]{36}$/.test(row.id)) throw new ServerBackupError('BACKUP_UNSAFE', 'The backup ledger contains an unsafe private directory name.')
    const parent = join(this.backupRoot, row.serverId)
    const directory = join(parent, row.directoryName)
    const parentStat = await lstat(parent).catch(() => null)
    const directoryStat = await lstat(directory).catch(() => null)
      if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0 || await realpath(parent).catch(() => '') !== parent
      || !directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0 || await realpath(directory).catch(() => '') !== directory) {
      throw new ServerBackupError('BACKUP_UNAVAILABLE', 'The private backup directory is missing or unsafe.')
    }
    const manifestPath = join(directory, 'manifest.json')
    let manifestHandle: FileHandle | null = null
    let archiveHandle: FileHandle | null = null
    try {
      manifestHandle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const manifestStat = await manifestHandle.stat()
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink > 1 || (manifestStat.mode & 0o077) !== 0 || manifestStat.size < 2 || manifestStat.size > MAX_SUPPORTED_MANIFEST_BYTES) {
        throw new ServerBackupError('BACKUP_UNSAFE', 'The private backup manifest is not a bounded regular file.')
      }
      const manifestBytes = await manifestHandle.readFile()
      const manifestHash = createHash('sha256').update(manifestBytes).digest('hex')
      if (manifestHash !== row.manifestSha256) throw new ServerBackupError('BACKUP_CHECKSUM_FAILED', 'The private backup manifest failed its SHA-256 check.')
      let raw: unknown
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) }
      catch { throw new ServerBackupError('BACKUP_MANIFEST_INVALID', 'The private backup manifest is not valid UTF-8 JSON.') }
      if (!manifestShape(raw) || raw.backupId !== row.id || raw.serverId !== row.serverId || raw.kind !== row.kind
        || raw.createdAt !== row.createdAt || raw.archiveSha256 !== row.archiveSha256 || raw.archiveSizeBytes !== row.archiveSizeBytes
        || manifestStat.size !== row.manifestSizeBytes || JSON.stringify(raw.worldPaths) !== row.worldPathsJson
        || raw.entryCount !== row.entryCount || raw.fileCount !== row.fileCount || raw.totalFileBytes !== row.totalFileBytes || raw.excludedCount !== row.excludedCount) {
        throw new ServerBackupError('BACKUP_MANIFEST_MISMATCH', 'The manifest metadata does not match the private backup ledger.')
      }
      await manifestHandle.close()
      manifestHandle = null
      archiveHandle = await open(join(directory, 'snapshot.mmsbackup'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const archiveStat = await archiveHandle.stat()
      if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.nlink > 1 || (archiveStat.mode & 0o077) !== 0 || archiveStat.size !== row.archiveSizeBytes || archiveStat.size > MAX_SUPPORTED_ARCHIVE_BYTES) {
        throw new ServerBackupError('BACKUP_UNSAFE', 'The private archive is not a safe regular file matching its ledger size.')
      }
      return { archiveHandle, archiveStat, manifest: raw }
    } catch (error) {
      await manifestHandle?.close().catch(() => undefined)
      await archiveHandle?.close().catch(() => undefined)
      throw error
    }
  }

  private async safeServerDirectory(serverId: string): Promise<{ row: ServerRow; directory: string; root: string; rootDevice: number; rootInode: number; serverInode: number }> {
    const row = this.serverRow(serverId)
    this.requireManaged(row)
    const root = resolve(this.servers.managedRoot)
    const rootStat = await lstat(root).catch(() => null)
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || await realpath(root).catch(() => '') !== root) {
      throw new ServerBackupError('SERVER_DIRECTORY_UNSAFE', 'The configured managed server root is missing or unsafe.')
    }
    const directory = resolve(row.directory)
    if (dirname(directory) !== root || basename(directory).startsWith('.mmsmanager-restore-')) throw new ServerBackupError('SERVER_DIRECTORY_UNSAFE', 'Only a direct managed server folder can be backed up.')
    const stat = await lstat(directory).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev || await realpath(directory).catch(() => '') !== directory || !inside(root, directory)
      || this.backupRoot === directory || inside(directory, this.backupRoot)) {
      throw new ServerBackupError('SERVER_DIRECTORY_UNSAFE', 'The managed server folder is missing, linked, mounted separately or outside its registered root.')
    }
    return { row, directory, root, rootDevice: stat.dev, rootInode: rootStat.ino, serverInode: stat.ino }
  }

  private async assertSameServerDirectory(server: { row: ServerRow; directory: string; root: string; rootDevice: number; rootInode: number; serverInode: number }) {
    const rootStat = await lstat(server.root)
    const current = await lstat(server.directory)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== server.rootDevice || rootStat.ino !== server.rootInode
      || !current.isDirectory() || current.isSymbolicLink() || current.dev !== server.rootDevice || current.ino !== server.serverInode
      || dirname(await realpath(server.directory)) !== server.root || await realpath(server.root) !== server.root) {
      throw new ServerBackupError('SERVER_DIRECTORY_UNSAFE', 'The managed server path changed before restore could replace it.')
    }
  }

  private async assertParentIdentity(server: { directory: string }, parentRelative: string, directories: Map<string, DirectoryIdentity>) {
    const key = parentRelative
    const identity = directories.get(key)
    if (!identity) throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', 'A server file parent was not part of the validated inventory.')
    const parent = join(server.directory, ...(key ? key.split('/') : []))
    const current = await lstat(parent)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || await realpath(parent).catch(() => '') !== parent) {
      throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', 'A server file parent changed during backup.')
    }
  }

  private async assertDirectoriesUnchanged(server: { directory: string }, directories: Map<string, DirectoryIdentity>) {
    for (const identity of directories.values()) {
      const path = join(server.directory, ...(identity.path ? identity.path.split('/') : []))
      const current = await lstat(path)
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || current.mtimeMs !== identity.mtimeMs || current.ctimeMs !== identity.ctimeMs || await realpath(path).catch(() => '') !== path) {
        throw new ServerBackupError('SERVER_CHANGED_DURING_BACKUP', 'A server directory changed while the archive was being written.')
      }
    }
  }

  private async ensurePrivateDirectory(directory: string, parent: string) {
    if (dirname(directory) !== parent) throw new ServerBackupError('BACKUP_DIRECTORY_UNSAFE', 'A private backup path escaped its storage root.')
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) { if (!isNodeError(error) || error.code !== 'EEXIST') throw error }
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw new ServerBackupError('BACKUP_DIRECTORY_UNSAFE', 'A private backup folder is not a real directory.')
    await chmod(directory, 0o700)
  }

  private async ensureSiblingPathAvailable(path: string) {
    const existing = await lstat(path).catch((error) => isNodeError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
    if (existing) throw new ServerBackupError('RESTORE_PATH_CONFLICT', 'A private staging or rollback path already exists; no existing files were overwritten.')
  }

  private async removeOwnedTree(path: string, parent: string): Promise<void> {
    const root = resolve(parent)
    const candidate = resolve(path)
    const parentStat = await lstat(root)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(root) !== root || !inside(root, candidate)) {
      throw new ServerBackupError('BACKUP_CLEANUP_REJECTED', 'Refusing cleanup outside a verified private operation root.')
    }
    await this.removeTreeWithin(candidate, root, parentStat.dev)
  }

  private async removeTreeWithin(path: string, root: string, rootDevice: number): Promise<void> {
    if (!inside(root, path)) throw new ServerBackupError('BACKUP_CLEANUP_REJECTED', 'A cleanup path escaped its private operation root.')
    const before = await lstat(path).catch((error) => isNodeError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!before) return
    if (before.isSymbolicLink() || !before.isDirectory()) { await rm(path); return }
    if (before.dev !== rootDevice || await realpath(path).catch(() => '') !== path) throw new ServerBackupError('BACKUP_CLEANUP_REJECTED', 'Refusing to recurse into a mount or linked cleanup directory.')
    const handle = await opendir(path, { bufferSize: 32 })
    try {
      for await (const entry of handle) await this.removeTreeWithin(join(path, entry.name), root, rootDevice)
    } finally { await handle.close().catch(() => undefined) }
    const after = await lstat(path)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new ServerBackupError('BACKUP_CLEANUP_REJECTED', 'A private cleanup directory changed during removal.')
    await rmdir(path)
  }

  private async syncDirectory(path: string) {
    let handle: FileHandle | null = null
    try { handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); await handle.sync() }
    catch { /* Directory fsync is not supported on every local filesystem. */ }
    finally { await handle?.close().catch(() => undefined) }
  }

  private async recoverBackupStages(): Promise<void> {
    const root = resolve(this.backupRoot)
    const rootStat = await lstat(root)
    const rootHandle = await opendir(root, { bufferSize: 32 })
    let serverDirectories = 0
    try {
      for await (const entry of rootHandle) {
        if (++serverDirectories > 10_000) break
        if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue
        const parent = join(root, entry.name)
        const parentStat = await lstat(parent).catch(() => null)
        if (!parentStat?.isDirectory() || parentStat.isSymbolicLink() || parentStat.dev !== rootStat.dev || (parentStat.mode & 0o077) !== 0 || await realpath(parent).catch(() => '') !== parent) continue
        let handle
        try { handle = await opendir(parent, { bufferSize: 32 }) }
        catch { continue }
        let backupDirectories = 0
        try {
          for await (const backupEntry of handle) {
            if (++backupDirectories > 10_000) break
            if (!backupEntry.isDirectory() || !/^\.[0-9a-f-]{36}\.staging$/.test(backupEntry.name)) continue
            const candidate = join(parent, backupEntry.name)
            const candidateStat = await lstat(candidate).catch(() => null)
            if (!candidateStat?.isDirectory() || candidateStat.isSymbolicLink() || (candidateStat.mode & 0o077) !== 0 || await realpath(candidate).catch(() => '') !== candidate) continue
            await this.removeOwnedTree(candidate, parent)
          }
        } finally { await handle.close().catch(() => undefined) }
      }
    } finally { await rootHandle.close().catch(() => undefined) }
  }

  private async recoverInterruptedRestores(): Promise<void> {
    const pending = this.db.select().from(localServerBackupRestores)
      .where(sql`${localServerBackupRestores.status} IN ('prepared', 'recovery-required')`).all()
    for (const row of pending) {
      try {
        await this.processes.withStoppedServerOperation(row.serverId, async () => {
          const server = await this.safeServerDirectory(row.serverId)
          const stagePath = join(server.root, row.stagingName)
          const rollbackPath = join(server.root, row.rollbackName)
          const rollbackStat = await lstat(rollbackPath).catch(() => null)
          const targetStat = await lstat(server.directory).catch(() => null)
          if (rollbackStat) {
            if (!rollbackStat.isDirectory() || rollbackStat.isSymbolicLink() || dirname(rollbackPath) !== server.root) throw new ServerBackupError('RESTORE_ROLLBACK_FAILED', 'A pending rollback directory is unsafe.')
            if (targetStat) await this.removeOwnedTree(server.directory, server.root)
            await rename(rollbackPath, server.directory)
          } else if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) {
            throw new ServerBackupError('RESTORE_ROLLBACK_FAILED', 'The original server directory is missing and there is no safe rollback directory.')
          }
          await this.removeOwnedTree(stagePath, server.root)
          this.db.update(localServerBackupRestores).set({ status: 'rolled-back', completedAt: new Date(this.now()).toISOString(), errorCode: 'API_RESTARTED_DURING_RESTORE' }).where(eq(localServerBackupRestores.id, row.id)).run()
          this.recordEvent(row.serverId, row.actorUserId, 'server-backup-restore-recovery', 'success', { restoreId: row.id, outcome: 'rolled-back' }, new Date(this.now()).toISOString())
        }, true)
      } catch {
        this.db.update(localServerBackupRestores).set({ status: 'recovery-required', errorCode: 'RESTORE_RECOVERY_REQUIRED' }).where(eq(localServerBackupRestores.id, row.id)).run()
        this.recordEvent(row.serverId, row.actorUserId, 'server-backup-restore-recovery', 'failure', { restoreId: row.id }, new Date(this.now()).toISOString())
      }
    }
    const completed = this.db.select().from(localServerBackupRestores)
      .where(eq(localServerBackupRestores.status, 'completed')).all()
    for (const row of completed) {
      const server = this.db.select().from(localServers).where(eq(localServers.id, row.serverId)).get()
      if (!server || dirname(resolve(server.directory)) !== resolve(this.servers.managedRoot) || !/^\.mmsmanager-restore-[0-9a-f-]{36}\.rollback$/.test(row.rollbackName)) continue
      const rollback = join(this.servers.managedRoot, row.rollbackName)
      await this.removeOwnedTree(rollback, resolve(this.servers.managedRoot)).catch(() => undefined)
    }
  }

  private recordEvent(serverId: string, actorUserId: string | null, action: string, outcome: 'success' | 'failure', detail: Record<string, unknown>, occurredAt: string) {
    this.db.insert(localServerEvents).values({ serverId, actorUserId, action, outcome, occurredAt, detail: JSON.stringify(detail) }).run()
  }

  private async getSettings(): Promise<BackupSettings> {
    const row = this.db.select().from(backupSettingsTable).where(eq(backupSettingsTable.id, 1)).get()
    if (!row) return DEFAULT_BACKUP_SETTINGS
    return backupSettingsSchema.parse({
      maxArchiveBytes: row.maxArchiveBytes,
      storageQuotaBytes: row.storageQuotaBytes,
      maxEntries: row.maxEntries,
      maxDurationMinutes: row.maxDurationMinutes,
    })
  }

  private deadline(settings: BackupSettings): number {
    return this.timeNow() + settings.maxDurationMinutes * 60_000
  }

  private timeNow(): number { return this.hooks.operationClock?.() ?? Date.now() }

  private async storageMetrics(): Promise<{ usedBytes: number; availableBytes: number | null }> {
    const usedBytes = this.db.select({ value: sql<number>`coalesce(sum(${localServerBackups.archiveSizeBytes} + ${localServerBackups.manifestSizeBytes}), 0)` })
      .from(localServerBackups).get()?.value ?? 0
    try {
      const free = await statfs(this.backupRoot)
      const available = Number(free.bavail) * Number(free.bsize)
      return { usedBytes, availableBytes: Number.isSafeInteger(available) && available >= 0 ? available : null }
    } catch { return { usedBytes, availableBytes: null } }
  }

  private backupRow(serverId: string, backupId: string): BackupRow {
    const row = this.db.select().from(localServerBackups).where(and(eq(localServerBackups.serverId, serverId), eq(localServerBackups.id, backupId))).get()
    if (!row) throw new ServerBackupError('BACKUP_NOT_FOUND', 'The selected backup was not found for this server.')
    return row
  }
  private serverRow(serverId: string): ServerRow {
    const row = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!row) throw new ServerBackupError('SERVER_NOT_FOUND', 'The registered server was not found.')
    return row
  }
  private requireManaged(server: ServerRow) {
    if (server.source !== 'created' || !server.managed) throw new ServerBackupError('SERVER_NOT_PANEL_MANAGED', 'Imported folders are read only. Backups are available only for servers created by MMSManager.')
  }
  private runtimeStatus(serverId: string): 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'error' | 'external/unmanaged' | 'unavailable' {
    const server = this.db.select({ source: localServers.source, managed: localServers.managed }).from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server || server.source !== 'created' || !server.managed) return 'external/unmanaged'
    return this.db.select({ status: localServerRuntime.status }).from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()?.status ?? 'stopped'
  }
  private hasUnresolvedRestore(serverId: string) {
    return Boolean(this.db.select({ id: localServerBackupRestores.id }).from(localServerBackupRestores)
      .where(and(eq(localServerBackupRestores.serverId, serverId), sql`${localServerBackupRestores.status} IN ('prepared', 'recovery-required')`)).get())
  }
  private publicBackup(row: Pick<BackupRow, 'id' | 'serverId' | 'kind' | 'origin' | 'createdAt' | 'archiveSizeBytes' | 'archiveSha256' | 'manifestSha256' | 'entryCount' | 'fileCount' | 'totalFileBytes' | 'excludedCount'>) {
    return {
      id: row.id, serverId: row.serverId, kind: row.kind, origin: row.origin, createdAt: row.createdAt, archiveSizeBytes: row.archiveSizeBytes,
      archiveSha256: row.archiveSha256, manifestSha256: row.manifestSha256, entryCount: row.entryCount, fileCount: row.fileCount,
      totalFileBytes: row.totalFileBytes, excludedCount: row.excludedCount,
    }
  }
}
