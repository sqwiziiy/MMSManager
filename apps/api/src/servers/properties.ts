import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { desc, eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerPropertiesBackups, localServerRuntime, localServerEvents, localServers } from '../db/schema.js'
import type { ServerPropertiesResponse, ServerPropertiesUpdate, ServerPropertySettings } from '@mmsmanager/shared'
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

  private async readProperties(path: string): Promise<{ bytes: Buffer; text: string }> {
    const stat = await lstat(path).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new ServerPropertiesError('PROPERTIES_FILE_UNSAFE', 'A regular server.properties file under 64 KiB is required.')
    let file
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { throw new ServerPropertiesError('PROPERTIES_FILE_UNSAFE', 'The server.properties file could not be opened safely.') }
    try {
      const openedStat = await file.stat()
      if (!openedStat.isFile() || openedStat.size > 65_536) throw new ServerPropertiesError('PROPERTIES_FILE_UNSAFE', 'The server.properties file changed while it was being opened.')
      const bytes = await file.readFile()
      if (bytes.byteLength > 65_536) throw new ServerPropertiesError('PROPERTIES_FILE_TOO_LARGE', 'The server.properties file is larger than the supported 64 KiB limit.')
      return { bytes, text: bytes.toString('utf8') }
    } finally { await file.close() }
  }
}
