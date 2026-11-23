import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerPropertiesBackups, localServerRuntime, localServerEvents, localServers } from '../db/schema.js'
import type { ServerPropertiesResponse, ServerPropertiesRestorePreview, ServerPropertiesUpdate, ServerPropertySettings } from '@mmsmanager/shared'
import { serverPropertySettingsSchema } from '@mmsmanager/shared'
import type { ServerRegistry } from './registry.js'

const PROPERTY_NAMES = {
  motd: 'motd',
  gameMode: 'gamemode',
  difficulty: 'difficulty',
  maxPlayers: 'max-players',
  viewDistance: 'view-distance',
  simulationDistance: 'simulation-distance',
  spawnProtection: 'spawn-protection',
  pvp: 'pvp',
  whiteList: 'white-list',
  allowNether: 'allow-nether',
} as const satisfies Record<keyof ServerPropertySettings, string>
const DEFAULT_SETTINGS: ServerPropertySettings = {
  motd: 'A Minecraft Server', gameMode: 'survival', difficulty: 'easy', maxPlayers: 20,
  viewDistance: 10, simulationDistance: 10, spawnProtection: 16,
  pvp: true, whiteList: false, allowNether: true,
}
const SUPPORTED_NAMES = new Set<string>(Object.values(PROPERTY_NAMES))

export class ServerPropertiesError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function unescapeValue(raw: string): string {
  let result = ''
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!
    if (character !== '\\' || index === raw.length - 1) { result += character; continue }
    const escaped = raw[++index]!
    if (escaped === 't') result += '\t'
    else if (escaped === 'n') result += '\n'
    else if (escaped === 'r') result += '\r'
    else if (escaped === 'f') result += '\f'
    else if (escaped === 'u' && /^[\da-f]{4}$/i.test(raw.slice(index + 1, index + 5))) {
      result += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 5), 16))
      index += 4
    } else result += escaped
  }
  return result
}

function propertyParts(line: string): { key: string; value: string } | null {
  const trimmed = line.trimStart()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return null
  let separator = -1
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '=' || line[index] === ':' || /\s/.test(line[index]!)) { separator = index; break }
  }
  if (separator < 0) return { key: line.trim(), value: '' }
  const key = line.slice(0, separator).trim()
  let valueStart = separator
  while (valueStart < line.length && /\s/.test(line[valueStart]!)) valueStart += 1
  if (line[valueStart] === '=' || line[valueStart] === ':') valueStart += 1
  while (valueStart < line.length && /\s/.test(line[valueStart]!)) valueStart += 1
  return key ? { key, value: unescapeValue(line.slice(valueStart)) } : null
}

function parseSettings(lines: string[]): { settings: ServerPropertySettings; unknownKeys: string[] } {
  const values = new Map<string, string>()
  const unknownKeys = new Set<string>()
  for (const line of lines) {
    const parts = propertyParts(line)
    if (!parts) continue
    if (SUPPORTED_NAMES.has(parts.key)) values.set(parts.key, parts.value)
    else unknownKeys.add(parts.key)
  }
  const numberValue = (key: string, fallback: number) => {
    const raw = values.get(key)
    return raw && /^\d+$/.test(raw) ? Number(raw) : fallback
  }
  const booleanValue = (key: string, fallback: boolean) => {
    const raw = values.get(key)?.toLowerCase()
    return raw === 'true' ? true : raw === 'false' ? false : fallback
  }
  const rawGameMode = values.get(PROPERTY_NAMES.gameMode)
  const rawDifficulty = values.get(PROPERTY_NAMES.difficulty)
  return {
    settings: serverPropertySettingsSchema.parse({
      motd: values.get(PROPERTY_NAMES.motd) ?? DEFAULT_SETTINGS.motd,
      gameMode: ['survival', 'creative', 'adventure', 'spectator'].includes(rawGameMode ?? '') ? rawGameMode : DEFAULT_SETTINGS.gameMode,
      difficulty: ['peaceful', 'easy', 'normal', 'hard'].includes(rawDifficulty ?? '') ? rawDifficulty : DEFAULT_SETTINGS.difficulty,
      maxPlayers: numberValue(PROPERTY_NAMES.maxPlayers, DEFAULT_SETTINGS.maxPlayers),
      viewDistance: numberValue(PROPERTY_NAMES.viewDistance, DEFAULT_SETTINGS.viewDistance),
      simulationDistance: numberValue(PROPERTY_NAMES.simulationDistance, DEFAULT_SETTINGS.simulationDistance),
      spawnProtection: numberValue(PROPERTY_NAMES.spawnProtection, DEFAULT_SETTINGS.spawnProtection),
      pvp: booleanValue(PROPERTY_NAMES.pvp, DEFAULT_SETTINGS.pvp),
      whiteList: booleanValue(PROPERTY_NAMES.whiteList, DEFAULT_SETTINGS.whiteList),
      allowNether: booleanValue(PROPERTY_NAMES.allowNether, DEFAULT_SETTINGS.allowNether),
    }),
    unknownKeys: [...unknownKeys].sort().slice(0, 256),
  }
}

function hiddenContent(text: string): string {
  return text.split(/\r?\n/).filter((line) => {
    const parsed = propertyParts(line)
    return !parsed || !SUPPORTED_NAMES.has(parsed.key)
  }).join('\n')
}

function encodeValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return value.replaceAll('\\', '\\\\').replaceAll('=', '\\=').replaceAll(':', '\\:').replace(/^ /, '\\ ')
}

function updateLines(original: string, update: ServerPropertiesUpdate): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalNewline = original.endsWith('\n')
  const lines = original.split(/\r?\n/)
  if (hasFinalNewline) lines.pop()
  for (const setting of Object.keys(update) as (keyof ServerPropertySettings)[]) {
    const propertyName = PROPERTY_NAMES[setting]
    const normalized = `${propertyName}=${encodeValue(update[setting]!)}`
    let matched = -1
    for (let index = 0; index < lines.length; index += 1) {
      if (propertyParts(lines[index]!)?.key === propertyName) matched = index
    }
    if (matched >= 0) lines[matched] = normalized
    else lines.push(normalized)
  }
  serverPropertySettingsSchema.parse({ ...parseSettings(lines).settings, ...update })
  return lines.join(newline) + (hasFinalNewline ? newline : '')
}

export class ServerPropertiesManager {
  private readonly backupRoot: string

  constructor(private readonly db: AppDatabase, private readonly servers: ServerRegistry, private readonly now: () => number = Date.now) {
    this.backupRoot = join(servers.dataDirectory, 'properties-backups')
  }

  async get(serverId: string): Promise<ServerPropertiesResponse> {
    const server = this.serverRow(serverId)
    const propertiesPath = await this.propertiesPath(server)
    const original = await this.readProperties(propertiesPath)
    const parsed = parseSettings(original.text.split(/\r?\n/))
    const history = this.db.select({ id: localServerPropertiesBackups.id, createdAt: localServerPropertiesBackups.createdAt, sha256: localServerPropertiesBackups.sha256 })
      .from(localServerPropertiesBackups).where(eq(localServerPropertiesBackups.serverId, serverId))
      .orderBy(desc(localServerPropertiesBackups.createdAt)).limit(20).all()
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    return {
      ...parsed,
      backups: history,
      restartRequired: runtime?.restartRequired ?? false,
    }
  }

  async update(serverId: string, actorUserId: string, update: ServerPropertiesUpdate): Promise<ServerPropertiesResponse> {
    const server = this.serverRow(serverId)
    const propertiesPath = await this.propertiesPath(server)
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    if (runtime && ['starting', 'stopping', 'external/unmanaged'].includes(runtime.status)) {
      throw new ServerPropertiesError('SERVER_BUSY', 'Properties cannot be edited while the server is starting, stopping, or unmanaged.')
    }
    const original = await this.readProperties(propertiesPath)
    const lines = original.text.split(/\r?\n/)
    const parsed = parseSettings(lines)
    const settings = serverPropertySettingsSchema.parse({ ...parsed.settings, ...update })
    const changed = Object.keys(update).some((key) => settings[key as keyof ServerPropertySettings] !== parsed.settings[key as keyof ServerPropertySettings])
    if (!changed) return this.get(serverId)

    const nextText = updateLines(original.text, update)
    if (Buffer.byteLength(nextText, 'utf8') > 65_536) throw new ServerPropertiesError('PROPERTIES_FILE_TOO_LARGE', 'The edited server.properties would exceed the supported 64 KiB limit.')
    const id = randomUUID()
    const createdAt = new Date(this.now()).toISOString()
    const backupFile = `${id}.properties`
    const backupDirectory = join(this.backupRoot, serverId)
    await mkdir(this.backupRoot, { recursive: true, mode: 0o700 })
    const backupRootStat = await lstat(this.backupRoot)
    if (!backupRootStat.isDirectory() || backupRootStat.isSymbolicLink()) throw new ServerPropertiesError('BACKUP_DIRECTORY_UNSAFE', 'The private properties backup location is not a safe directory.')
    await chmod(this.backupRoot, 0o700)
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
    const backupDirectoryStat = await lstat(backupDirectory)
    if (!backupDirectoryStat.isDirectory() || backupDirectoryStat.isSymbolicLink()) throw new ServerPropertiesError('BACKUP_DIRECTORY_UNSAFE', 'The server properties backup location is not a safe directory.')
    await chmod(backupDirectory, 0o700)
    const sha256 = createHash('sha256').update(original.bytes).digest('hex')
    const backupHandle = await open(join(backupDirectory, backupFile), 'wx', 0o600)
    try {
      await backupHandle.writeFile(original.bytes)
      await backupHandle.sync()
    } finally { await backupHandle.close() }

    const temporaryPath = join(dirname(propertiesPath), `.server.properties.${randomUUID()}.tmp`)
    const temporaryHandle = await open(temporaryPath, 'wx', 0o600)
    try {
      await temporaryHandle.writeFile(nextText, 'utf8')
      await temporaryHandle.sync()
    } finally { await temporaryHandle.close() }
    try {
      await rename(temporaryPath, propertiesPath)
      const directoryHandle = await open(dirname(propertiesPath), constants.O_RDONLY)
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }

    this.db.insert(localServerPropertiesBackups).values({ id, serverId, actorUserId, fileName: backupFile, sha256, createdAt }).run()
    const restartRequired = runtime?.status === 'running' || runtime?.restartRequired === true
    if (runtime) this.db.update(localServerRuntime).set({ restartRequired, updatedAt: createdAt }).where(eq(localServerRuntime.serverId, serverId)).run()
    else this.db.insert(localServerRuntime).values({ serverId, status: 'stopped', updatedAt: createdAt, restartRequired }).run()
    this.db.insert(localServerEvents).values({
      serverId, actorUserId, action: 'server-properties-updated', outcome: 'success', occurredAt: createdAt,
      detail: JSON.stringify({ backupId: id, changedKeys: Object.keys(update).filter((key) => settings[key as keyof ServerPropertySettings] !== parsed.settings[key as keyof ServerPropertySettings]) }),
    }).run()
    return this.get(serverId)
  }

  async previewRestore(serverId: string, backupId: string): Promise<ServerPropertiesRestorePreview> {
    const server = this.serverRow(serverId)
    const path = await this.propertiesPath(server)
    const row = this.db.select().from(localServerPropertiesBackups)
      .where(and(eq(localServerPropertiesBackups.serverId, serverId), eq(localServerPropertiesBackups.id, backupId))).get()
    if (!row) throw new ServerPropertiesError('PROPERTY_BACKUP_NOT_FOUND', 'The selected properties recovery copy was not found.')
    const current = await this.readProperties(path)
    const currentSha256 = createHash('sha256').update(current.bytes).digest('hex')
    const backup = await this.readBackup(row.id, row.serverId, row.fileName, row.sha256)
    const checksumValid = backup.checksumValid
    const changedSettings: ServerPropertiesRestorePreview['changedSettings'] = []
    if (checksumValid) {
      const active = parseSettings(current.text.split(/\r?\n/)).settings
      const restored = parseSettings(backup.bytes.toString('utf8').split(/\r?\n/)).settings
      for (const key of Object.keys(PROPERTY_NAMES) as (keyof ServerPropertySettings)[]) {
        const before = active[key]
        const after = restored[key]
        if (before !== after) changedSettings.push({ key: PROPERTY_NAMES[key], current: String(before), restored: String(after) })
      }
    }
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    const running = runtime?.status === 'running'
    return {
      backupId: row.id,
      createdAt: row.createdAt,
      checksumValid,
      backupSha256: row.sha256,
      currentSha256,
      running,
      restartRequiredAfterRestore: running || runtime?.restartRequired === true,
      otherContentDiffers: checksumValid && hiddenContent(current.text) !== hiddenContent(backup.bytes.toString('utf8')),
      changedSettings,
    }
  }

  async restore(serverId: string, actorUserId: string, backupId: string, expectedCurrentSha256: string): Promise<{ properties: ServerPropertiesResponse; recoveryBackupId: string | null }> {
    const server = this.serverRow(serverId)
    const path = await this.propertiesPath(server)
    const row = this.db.select().from(localServerPropertiesBackups)
      .where(and(eq(localServerPropertiesBackups.serverId, serverId), eq(localServerPropertiesBackups.id, backupId))).get()
    if (!row) throw new ServerPropertiesError('PROPERTY_BACKUP_NOT_FOUND', 'The selected properties recovery copy was not found.')
    const backup = await this.readBackup(row.id, row.serverId, row.fileName, row.sha256)
    if (!backup.checksumValid) throw new ServerPropertiesError('PROPERTY_BACKUP_CHECKSUM_FAILED', 'The selected recovery copy failed its SHA-256 checksum check.')
    const current = await this.readProperties(path)
    const currentSha256 = createHash('sha256').update(current.bytes).digest('hex')
    if (currentSha256 !== expectedCurrentSha256) throw new ServerPropertiesError('PROPERTY_RESTORE_CONFLICT', 'server.properties changed after the restore preview. Reload the preview before restoring.')
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    if (runtime && ['starting', 'stopping', 'external/unmanaged'].includes(runtime.status)) throw new ServerPropertiesError('SERVER_BUSY', 'Properties cannot be restored while the server is starting, stopping, or unmanaged.')
    if (currentSha256 === row.sha256) return { properties: await this.get(serverId), recoveryBackupId: null }

    const recoveryBackupId = await this.createRecoveryBackup(serverId, actorUserId, current.bytes)
    const restoreBytes = backup.bytes
    const restoreSha256 = createHash('sha256').update(restoreBytes).digest('hex')
    const occurredAt = new Date(this.now()).toISOString()
    try {
      await this.atomicReplaceProperties(path, restoreBytes, current.bytes, current.stat, currentSha256)
      this.db.transaction((tx) => {
        const restartRequired = runtime?.status === 'running' || runtime?.restartRequired === true
        if (runtime) tx.update(localServerRuntime).set({ restartRequired, updatedAt: occurredAt }).where(eq(localServerRuntime.serverId, serverId)).run()
        else tx.insert(localServerRuntime).values({ serverId, status: 'stopped', updatedAt: occurredAt, restartRequired }).run()
        tx.insert(localServerEvents).values({
          serverId, actorUserId, action: 'server-properties-restored', outcome: 'success', occurredAt,
          detail: JSON.stringify({ backupId, recoveryBackupId, sha256: restoreSha256 }),
        }).run()
      })
    } catch (error) {
      try {
        const afterFailure = await this.readProperties(path)
        const afterHash = createHash('sha256').update(afterFailure.bytes).digest('hex')
        if (afterHash === restoreSha256) await this.atomicReplaceProperties(path, current.bytes, afterFailure.bytes, afterFailure.stat, restoreSha256)
        else if (afterHash !== currentSha256) throw new ServerPropertiesError('PROPERTY_RESTORE_ROLLBACK_FAILED', 'The restore failed after another writer changed server.properties. The recovery copy remains available.')
      } catch { throw new ServerPropertiesError('PROPERTY_RESTORE_ROLLBACK_FAILED', 'The restore failed and the original server.properties could not be restored automatically. The recovery copy remains available.') }
      throw error
    }
    return { properties: await this.get(serverId), recoveryBackupId }
  }

  private serverRow(serverId: string) {
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) throw new ServerPropertiesError('SERVER_NOT_FOUND', 'The registered server was not found.')
    if (server.source !== 'created' || !server.managed) throw new ServerPropertiesError('SERVER_NOT_PANEL_MANAGED', 'Imported folders are read only and cannot be edited.')
    return server
  }

  private async propertiesPath(server: typeof localServers.$inferSelect): Promise<string> {
    const directory = resolve(server.directory)
    const root = await realpath(this.servers.managedRoot)
    if (dirname(directory) !== root || await realpath(directory).catch(() => '') !== directory) {
      throw new ServerPropertiesError('SERVER_DIRECTORY_REJECTED', 'This server is not a safe direct child of the managed root.')
    }
    return join(directory, 'server.properties')
  }

  private async readProperties(path: string): Promise<{ bytes: Buffer; text: string; stat: Awaited<ReturnType<typeof lstat>> }> {
    const stat = await lstat(path).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new ServerPropertiesError('PROPERTIES_FILE_UNSAFE', 'A regular server.properties file under 64 KiB is required.')
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { throw new ServerPropertiesError('PROPERTIES_FILE_UNSAFE', 'The server.properties file could not be opened safely.') }
    try {
      const openedStat = await file.stat()
      if (!openedStat.isFile() || openedStat.size > 65_536) throw new ServerPropertiesError('PROPERTIES_FILE_UNSAFE', 'The server.properties file changed while it was being opened.')
      const bytes = await file.readFile()
      if (bytes.byteLength > 65_536) throw new ServerPropertiesError('PROPERTIES_FILE_TOO_LARGE', 'The server.properties file is larger than the supported 64 KiB limit.')
      return { bytes, text: bytes.toString('utf8'), stat: openedStat }
    } finally { await file.close() }
  }

  private async readBackup(id: string, serverId: string, fileName: string, expectedSha256: string): Promise<{ bytes: Buffer; checksumValid: boolean }> {
    if (fileName !== `${id}.properties`) throw new ServerPropertiesError('PROPERTY_BACKUP_UNSAFE', 'The recovery-copy ledger contains an unsafe filename.')
    const directory = join(this.backupRoot, serverId)
    const rootStat = await lstat(this.backupRoot).catch(() => null)
    const directoryStat = await lstat(directory).catch(() => null)
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || !directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || await realpath(directory).catch(() => '') !== directory) {
      throw new ServerPropertiesError('PROPERTY_BACKUP_UNAVAILABLE', 'The private properties recovery directory is unavailable or unsafe.')
    }
    const backupPath = join(directory, fileName)
    const stat = await lstat(backupPath).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 65_536) throw new ServerPropertiesError('PROPERTY_BACKUP_UNAVAILABLE', 'The selected properties recovery copy is missing or unsafe.')
    let handle
    try { handle = await open(backupPath, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch { throw new ServerPropertiesError('PROPERTY_BACKUP_UNAVAILABLE', 'The selected properties recovery copy could not be opened safely.') }
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink > 1 || opened.size > 65_536) throw new ServerPropertiesError('PROPERTY_BACKUP_UNAVAILABLE', 'The selected properties recovery copy changed while it was opened.')
      const bytes = await handle.readFile()
      if (bytes.byteLength > 65_536) throw new ServerPropertiesError('PROPERTY_BACKUP_UNAVAILABLE', 'The selected properties recovery copy exceeds its size limit.')
      return { bytes, checksumValid: createHash('sha256').update(bytes).digest('hex') === expectedSha256 }
    } finally { await handle.close() }
  }

  private async createRecoveryBackup(serverId: string, actorUserId: string, bytes: Buffer): Promise<string> {
    const id = randomUUID()
    const fileName = `${id}.properties`
    const backupDirectory = join(this.backupRoot, serverId)
    await mkdir(this.backupRoot, { recursive: true, mode: 0o700 })
    const backupRootStat = await lstat(this.backupRoot)
    if (!backupRootStat.isDirectory() || backupRootStat.isSymbolicLink() || await realpath(this.backupRoot) !== resolve(this.backupRoot)) throw new ServerPropertiesError('BACKUP_DIRECTORY_UNSAFE', 'The private properties backup location is not a safe directory.')
    await chmod(this.backupRoot, 0o700)
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
    const backupDirectoryStat = await lstat(backupDirectory)
    if (!backupDirectoryStat.isDirectory() || backupDirectoryStat.isSymbolicLink() || await realpath(backupDirectory) !== resolve(backupDirectory)) throw new ServerPropertiesError('BACKUP_DIRECTORY_UNSAFE', 'The server properties backup location is not a safe directory.')
    await chmod(backupDirectory, 0o700)
    const handle = await open(join(backupDirectory, fileName), 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    const createdAt = new Date(this.now()).toISOString()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    this.db.insert(localServerPropertiesBackups).values({ id, serverId, actorUserId, fileName, sha256, createdAt }).run()
    return id
  }

  private async atomicReplaceProperties(path: string, bytes: Buffer, expectedBytes: Buffer, expectedStat: Awaited<ReturnType<typeof lstat>>, expectedSha256: string): Promise<void> {
    const snapshot = await this.readProperties(path)
    if (snapshot.stat.dev !== expectedStat.dev || snapshot.stat.ino !== expectedStat.ino || createHash('sha256').update(snapshot.bytes).digest('hex') !== expectedSha256) {
      throw new ServerPropertiesError('PROPERTY_RESTORE_CONFLICT', 'server.properties changed while the restore was staged.')
    }
    const temporary = join(dirname(path), `.server.properties.${randomUUID()}.restore`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try {
      const latest = await this.readProperties(path)
      if (latest.stat.dev !== expectedStat.dev || latest.stat.ino !== expectedStat.ino || createHash('sha256').update(latest.bytes).digest('hex') !== expectedSha256) throw new ServerPropertiesError('PROPERTY_RESTORE_CONFLICT', 'server.properties changed while the restore was staged.')
      if (!expectedBytes.equals(latest.bytes)) throw new ServerPropertiesError('PROPERTY_RESTORE_CONFLICT', 'server.properties contents changed while the restore was staged.')
      await rename(temporary, path)
      const directoryHandle = await open(dirname(path), constants.O_RDONLY)
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    } catch (error) { await rm(temporary, { force: true }); throw error }
  }
}
