import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerPropertiesBackups, localServerRuntime, localServerEvents, localServers } from '../db/schema.js'
import type { ServerPropertiesResponse, ServerPropertiesRestorePreview, ServerPropertiesUpdate, ServerPropertySettings } from '@mmsmanager/shared'
import { serverPropertySettingsSchema } from '@mmsmanager/shared'
import { serverPropertiesCatalog, serverPropertyAvailable } from '@mmsmanager/shared'
import type { ServerPropertyCatalogEntry } from '@mmsmanager/shared'
import type { ServerRegistry } from './registry.js'
import { isLoopbackPortAvailable } from './install.js'
import { parseJavaProperties, parseServerPort } from './java-properties.js'

const PROPERTY_NAMES = {
  onlineMode: 'online-mode',
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
  onlineMode: true,
  motd: 'A Minecraft Server', gameMode: 'survival', difficulty: 'easy', maxPlayers: 20,
  viewDistance: 10, simulationDistance: 10, spawnProtection: 16,
  pvp: true, whiteList: false, allowNether: true,
}
const SUPPORTED_NAMES = new Set<string>(Object.values(PROPERTY_NAMES))
const ADVANCED_BY_KEY = new Map<string, ServerPropertyCatalogEntry>(serverPropertiesCatalog.map((entry) => [entry.key, entry]))
const PROTECTED_PROPERTY_REASONS = [
  ['server-ip', 'The panel keeps server binding settings separate from the local web interface.'],
  ['enable-query', 'This enables an additional network listener that the panel does not manage.'],
  ['query.port', 'This opens an additional network listener that the panel does not manage.'],
  ['enable-rcon', 'RCON is an additional remote-control listener and is not managed here.'],
  ['rcon.port', 'RCON is an additional remote-control listener and is not managed here.'],
  ['rcon.password', 'This is a secret and is never shown or edited in Properties.'],
  ['management-server-enabled', 'The alternate management protocol is not managed by MMSManager.'],
  ['management-server-host', 'The alternate management protocol is not managed by MMSManager.'],
  ['management-server-port', 'The alternate management protocol is not managed by MMSManager.'],
  ['management-server-secret', 'This is a secret and is never shown or edited in Properties.'],
  ['management-server-tls-keystore', 'The alternate management protocol is not managed by MMSManager.'],
  ['management-server-tls-keystore-password', 'This is a secret and is never shown or edited in Properties.'],
  ['text-filtering-config', 'Arbitrary server-side file paths are not edited in Properties.'],
  ['text-filtering-version', 'This key is managed together with the protected text-filtering configuration.'],
] as const
const PROTECTED_PROPERTY_KEYS = new Set<string>(PROTECTED_PROPERTY_REASONS.map(([key]) => key))
const WORLD_GENERATION_KEYS = new Set(['generate-structures', 'level-seed', 'level-type', 'generator-settings'])
const RESOURCE_PACK_KEYS = new Set(['resource-pack', 'resource-pack-sha1', 'resource-pack-prompt', 'require-resource-pack'])

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

function parseSettings(lines: string[]): { settings: ServerPropertySettings; advancedProperties: Record<string, string>; presentKeys: string[]; unknownKeys: string[] } {
  const values = new Map<string, string>()
  const advancedProperties: Record<string, string> = {}
  const presentKeys = new Set<string>()
  const unknownKeys = new Set<string>()
  let parsed: Map<string, string>
  try { parsed = parseJavaProperties(lines.join('\n')) }
  catch {
    parsed = new Map<string, string>()
    for (const line of lines) {
      const parts = propertyParts(line)
      if (parts) parsed.set(parts.key, parts.value)
    }
  }
  for (const [key, value] of parsed) {
    if (SUPPORTED_NAMES.has(key)) { values.set(key, value); presentKeys.add(key) }
    else if (ADVANCED_BY_KEY.has(key)) { advancedProperties[key] = value; presentKeys.add(key) }
    else if (isProtectedProperty(key)) presentKeys.add(key)
    else unknownKeys.add(key)
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
      onlineMode: booleanValue(PROPERTY_NAMES.onlineMode, DEFAULT_SETTINGS.onlineMode),
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
    advancedProperties,
    presentKeys: [...presentKeys].sort(),
    unknownKeys: [...unknownKeys].sort().slice(0, 256),
  }
}

function isProtectedProperty(key: string): boolean {
  return PROTECTED_PROPERTY_KEYS.has(key) || key.startsWith('management-server-') || key.startsWith('text-filtering-')
}

function protectedPropertyList(presentKeys: string[]) {
  const reasons = new Map<string, string>(PROTECTED_PROPERTY_REASONS.map(([key, reason]) => [key, reason]))
  const keys = new Set([...reasons.keys(), ...presentKeys.filter(isProtectedProperty)])
  return [...keys].map((key) => ({
    key,
    reason: reasons.get(key) ?? (key.startsWith('management-server-')
      ? 'The alternate management protocol is not managed by MMSManager.'
      : key.startsWith('text-filtering-') ? 'Arbitrary server-side file paths are not edited in Properties.' : 'This configuration key is withheld from the general editor.'),
    configured: presentKeys.includes(key),
  }))
}

function hiddenContent(text: string): string {
  return text.split(/\r?\n/).filter((line) => {
    const parsed = propertyParts(line)
    return !parsed || (!SUPPORTED_NAMES.has(parsed.key) && !ADVANCED_BY_KEY.has(parsed.key))
  }).join('\n')
}

function encodeValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return value.replaceAll('\\', '\\\\').replaceAll('=', '\\=').replaceAll(':', '\\:').replace(/^ /, '\\ ')
}

function containsUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true
  }
  return false
}

function updateLines(original: string, update: ServerPropertiesUpdate, advancedProperties: Record<string, string>): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalNewline = original.endsWith('\n')
  const lines = original.split(/\r?\n/)
  if (hasFinalNewline) lines.pop()
  const changes = [
    ...(Object.keys(update) as (keyof ServerPropertySettings)[]).map((setting) => [PROPERTY_NAMES[setting], update[setting]!] as const),
    ...Object.entries(advancedProperties),
  ]
  for (const [propertyName, value] of changes) {
    const normalized = `${propertyName}=${encodeValue(value)}`
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

  constructor(
    private readonly db: AppDatabase,
    private readonly servers: ServerRegistry,
    private readonly now: () => number = Date.now,
    private readonly isPortAvailable: (port: number) => Promise<boolean> = isLoopbackPortAvailable,
  ) {
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
    const portConfiguration = await this.servers.getPortConfiguration(serverId)
    const processActive = runtime && ['starting', 'running', 'stopping', 'external/unmanaged'].includes(runtime.status)
    return {
      ...parsed,
      sha256: createHash('sha256').update(original.bytes).digest('hex'),
      serverVersion: server.version ?? 'unknown',
      serverSoftware: server.software,
      configuredPort: portConfiguration.port,
      portStatus: portConfiguration.status,
      portErrorCode: portConfiguration.errorCode,
      protectedProperties: protectedPropertyList(parsed.presentKeys),
      unsupportedKeys: serverPropertiesCatalog.filter((entry) => !serverPropertyAvailable(entry, server.software, server.version ?? 'unknown')).map((entry) => entry.key),
      backups: history,
      restartRequired: Boolean(runtime?.restartRequired || (server.source === 'created' && server.managed && runtime && ['running', 'external/unmanaged'].includes(runtime.status) && runtime.processPort === null) || (processActive && runtime?.processPort !== null && runtime?.processPort !== portConfiguration.port)),
    }
  }

  async update(serverId: string, actorUserId: string, update: ServerPropertiesUpdate, options: {
    expectedSha256: string
    advancedProperties?: Record<string, string>
    confirmOnlineModeChange?: boolean
    confirmLevelNameChange?: boolean
    confirmWorldGenerationChange?: boolean
    confirmResourcePackChange?: boolean
    confirmGamePortChange?: boolean
  }): Promise<ServerPropertiesResponse> {
    const server = this.serverRow(serverId)
    await this.servers.refreshPortConfigurations(true)
    const propertiesPath = await this.propertiesPath(server)
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    if (runtime && ['starting', 'stopping', 'external/unmanaged'].includes(runtime.status)) {
      throw new ServerPropertiesError('SERVER_BUSY', 'Properties cannot be edited while the server is starting, stopping, or unmanaged.')
    }
    const original = await this.readProperties(propertiesPath)
    const lines = original.text.split(/\r?\n/)
    const parsed = parseSettings(lines)
    const originalSha256 = createHash('sha256').update(original.bytes).digest('hex')
    if (originalSha256 !== options.expectedSha256) throw new ServerPropertiesError('PROPERTY_SAVE_CONFLICT', 'server.properties changed after this page was loaded. Reload before saving your changes.')
    const settings = serverPropertySettingsSchema.parse({ ...parsed.settings, ...update })
    const onlineModeChanged = settings.onlineMode !== parsed.settings.onlineMode
    if (onlineModeChanged && !options.confirmOnlineModeChange) {
      throw new ServerPropertiesError('ONLINE_MODE_CONFIRMATION_REQUIRED', 'Explicitly confirm the online-mode change before saving.')
    }
    if (onlineModeChanged && runtime?.status !== 'stopped') {
      throw new ServerPropertiesError('ONLINE_MODE_REQUIRES_STOPPED', 'Online mode can only change while the managed server is confirmed stopped.')
    }
    const advancedUpdates = this.validateAdvancedUpdates(server, options.advancedProperties ?? {})
    const currentAdvancedValue = (key: string) => parsed.advancedProperties[key] ?? ADVANCED_BY_KEY.get(key)?.defaultValue ?? ''
    const changedAdvanced = Object.fromEntries(Object.entries(advancedUpdates).filter(([key, value]) => parsed.advancedProperties[key] === undefined || value !== parsed.advancedProperties[key]))
    const levelNameChanged = changedAdvanced['level-name'] !== undefined && changedAdvanced['level-name'] !== currentAdvancedValue('level-name')
    if (levelNameChanged && !options.confirmLevelNameChange) throw new ServerPropertiesError('LEVEL_NAME_CONFIRMATION_REQUIRED', 'Confirm the world-folder change before saving.')
    const worldGenerationChanged = Object.keys(changedAdvanced).some((key) => WORLD_GENERATION_KEYS.has(key))
    if (worldGenerationChanged && !options.confirmWorldGenerationChange) throw new ServerPropertiesError('WORLD_GENERATION_CONFIRMATION_REQUIRED', 'Confirm the world-generation change before saving.')
    const resourcePackChanged = Object.keys(changedAdvanced).some((key) => RESOURCE_PACK_KEYS.has(key))
    if (resourcePackChanged && !options.confirmResourcePackChange) throw new ServerPropertiesError('RESOURCE_PACK_CONFIRMATION_REQUIRED', 'Confirm the resource-pack change before saving.')
    const currentPortConfiguration = parseServerPort(original.text)
    const currentPort = currentPortConfiguration.status === 'valid' ? currentPortConfiguration.port : null
    const requestedPort = changedAdvanced['server-port'] === undefined ? currentPort : Number(changedAdvanced['server-port'])
    const gamePortChanged = requestedPort !== currentPort
    if (gamePortChanged && requestedPort === null) throw new ServerPropertiesError('PORT_VALUE_INVALID', 'Enter a valid server-port between 1 and 65535.')
    const targetPort = requestedPort
    if (gamePortChanged && !options.confirmGamePortChange) throw new ServerPropertiesError('GAME_PORT_CONFIRMATION_REQUIRED', 'Confirm the game-port change before saving.')
    if (gamePortChanged) {
      if (runtime?.status !== 'stopped') throw new ServerPropertiesError('GAME_PORT_REQUIRES_STOPPED', 'The game port can only change while the server is confirmed stopped.')
      if (targetPort === null) throw new ServerPropertiesError('PORT_VALUE_INVALID', 'Enter a valid server-port between 1 and 65535.')
      const collision = await this.servers.findPortConflict(serverId, targetPort)
      if (collision) throw new ServerPropertiesError('GAME_PORT_CONFLICT', `Game port ${targetPort} is already assigned to “${collision.name}”.`)
      if (!await this.isPortAvailable(targetPort)) throw new ServerPropertiesError('GAME_PORT_IN_USE', `Game port ${targetPort} is already in use on this computer.`)
    }
    const changed = Object.keys(update).some((key) => settings[key as keyof ServerPropertySettings] !== parsed.settings[key as keyof ServerPropertySettings])
      || Object.keys(changedAdvanced).length > 0
    if (!changed) return this.get(serverId)

    const nextText = updateLines(original.text, update, changedAdvanced)
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

    await this.atomicReplaceProperties(propertiesPath, Buffer.from(nextText, 'utf8'), original.bytes, original.stat, originalSha256)

    this.db.insert(localServerPropertiesBackups).values({ id, serverId, actorUserId, fileName: backupFile, sha256, createdAt }).run()
    await this.servers.refreshPortConfigurations(true)
    const restartRequired = runtime?.status === 'running' || runtime?.restartRequired === true
    if (runtime) this.db.update(localServerRuntime).set({ restartRequired, updatedAt: createdAt }).where(eq(localServerRuntime.serverId, serverId)).run()
    else this.db.insert(localServerRuntime).values({ serverId, status: 'stopped', updatedAt: createdAt, restartRequired }).run()
    this.db.insert(localServerEvents).values({
      serverId, actorUserId, action: 'server-properties-updated', outcome: 'success', occurredAt: createdAt,
      detail: JSON.stringify({ backupId: id, changedKeys: [
        ...Object.keys(update).filter((key) => settings[key as keyof ServerPropertySettings] !== parsed.settings[key as keyof ServerPropertySettings]),
        ...Object.keys(changedAdvanced),
      ] }),
    }).run()
    return this.get(serverId)
  }

  private validateAdvancedUpdates(server: typeof localServers.$inferSelect, changes: Record<string, string>): Record<string, string> {
    const validated: Record<string, string> = {}
    for (const [key, value] of Object.entries(changes)) {
      const definition = ADVANCED_BY_KEY.get(key)
      if (!definition || isProtectedProperty(key)) throw new ServerPropertiesError('PROPERTY_KEY_REJECTED', `“${key}” is not available in the safe Properties catalog.`)
      if (!serverPropertyAvailable(definition, server.software, server.version ?? 'unknown')) throw new ServerPropertiesError('PROPERTY_UNSUPPORTED_VERSION', `“${key}” is not supported for ${server.software} ${server.version ?? 'unknown'}.`)
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8192 || containsUnsupportedControlCharacter(value)) {
        throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', `“${key}” contains unsupported text or is too long.`)
      }
      if (definition.kind === 'boolean' && value !== 'true' && value !== 'false') throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', `“${key}” must be true or false.`)
      if (definition.kind === 'integer') {
        const number = Number(value)
        if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number) || number < (definition.minimum ?? Number.MIN_SAFE_INTEGER) || number > (definition.maximum ?? Number.MAX_SAFE_INTEGER)) {
          throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', `“${key}” is outside its documented integer range.`)
        }
      }
      const enumOptions = [...(definition.options ?? []), ...(server.software === 'paper' ? definition.softwareOptions?.paper ?? [] : [])]
      if (definition.kind === 'enum' && !enumOptions.includes(value)) throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', `“${key}” must use one of the supported options.`)
      if (definition.kind === 'json') {
        let parsed: unknown
        try { parsed = JSON.parse(value) as unknown } catch { throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', `“${key}” must contain valid JSON.`) }
        if (!parsed || typeof parsed !== 'object') throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', `“${key}” must contain a JSON object or array.`)
      }
      if (key === 'level-name' && (!value || value === '.' || value === '..' || value.length > 64 || /[\\/:*?"<>|]/.test(value) || /[. ]$/.test(value))) {
        throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', 'The world folder name must be a single safe folder name.')
      }
      if (key === 'level-seed' && value.length > 128) throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', 'The world seed must be 128 characters or fewer.')
      if (key === 'generator-settings' && Buffer.byteLength(value, 'utf8') > 4096) throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', 'Generator settings are limited to 4 KiB of JSON.')
      if (key === 'resource-pack' && value) {
        let url: URL
        try { url = new URL(value) } catch { throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', 'The resource-pack URL must be a valid HTTP or HTTPS address.') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 2048) throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', 'The resource-pack URL must be a valid HTTP or HTTPS address without embedded credentials.')
      }
      if (key === 'resource-pack-sha1' && value && !/^[a-f\d]{40}$/i.test(value)) throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', 'The resource-pack SHA-1 must contain exactly 40 hexadecimal characters.')
      if (key === 'resource-pack-prompt' && value.length > 4096) throw new ServerPropertiesError('PROPERTY_VALUE_REJECTED', 'The resource-pack prompt is limited to 4096 characters.')
      validated[key] = value
    }
    return validated
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
      const active = parseSettings(current.text.split(/\r?\n/))
      const restored = parseSettings(backup.bytes.toString('utf8').split(/\r?\n/))
      for (const key of Object.keys(PROPERTY_NAMES) as (keyof ServerPropertySettings)[]) {
        const before = active.settings[key]
        const after = restored.settings[key]
        if (before !== after) changedSettings.push({ key: PROPERTY_NAMES[key], current: String(before), restored: String(after) })
      }
      const advancedKeys = new Set([...Object.keys(active.advancedProperties), ...Object.keys(restored.advancedProperties)])
      for (const key of advancedKeys) {
        if (active.advancedProperties[key] === restored.advancedProperties[key]) continue
        const visibleBefore = active.advancedProperties[key] === undefined ? 'Inherited default' : 'Saved value'
        const visibleAfter = restored.advancedProperties[key] === undefined ? 'Inherited default' : 'Backup value'
        changedSettings.push({ key, current: visibleBefore, restored: visibleAfter })
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

    await this.servers.refreshPortConfigurations(true)
    const restoredPort = parseServerPort(backup.bytes.toString('utf8'))
    if (restoredPort.status === 'valid' && restoredPort.port !== parseServerPort(current.text).port) {
      const collision = await this.servers.findPortConflict(serverId, restoredPort.port!)
      if (collision) throw new ServerPropertiesError('GAME_PORT_CONFLICT', `Game port ${restoredPort.port} is already assigned to “${collision.name}”.`)
      if (runtime?.status === 'stopped' && !await this.isPortAvailable(restoredPort.port!)) {
        throw new ServerPropertiesError('GAME_PORT_IN_USE', `Game port ${restoredPort.port} is already in use on this computer.`)
      }
    }

    const recoveryBackupId = await this.createRecoveryBackup(serverId, actorUserId, current.bytes)
    const restoreBytes = backup.bytes
    const restoreSha256 = createHash('sha256').update(restoreBytes).digest('hex')
    const occurredAt = new Date(this.now()).toISOString()
    try {
      await this.atomicReplaceProperties(path, restoreBytes, current.bytes, current.stat, currentSha256)
      await this.servers.refreshPortConfigurations(true)
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
