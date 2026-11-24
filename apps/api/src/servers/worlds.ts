import { constants } from 'node:fs'
import { open, lstat, opendir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServers } from '../db/schema.js'
import type { ServerWorldEntry, ServerWorlds } from '@mmsmanager/shared'
import type { ServerRegistry } from './registry.js'
import type { ServerBackupService } from './backups.js'

const MAX_PROPERTIES_BYTES = 65_536
const MAX_WORLD_DEPTH = 32
const MAX_WORLD_ENTRIES = 20_000
const MAX_WORLD_SCAN_MS = 5_000
const MAX_WORLDS = 100

export class ServerWorldsError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function fsError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path))
}
function safeWorldPath(value: string): string | null {
  const path = value.trim()
  if (!path || path.length > 2048 || path.includes('\\') || path.startsWith('/') || path.includes(':')) return null
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 255 || /[. ]$/.test(part) || Array.from(part).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127))) return null
  return parts.join('/')
}
function parseProperties(text: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    result.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  return result
}
function configuredWorldFolders(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
      .map(safeWorldPath).filter((item): item is string => item !== null)
  } catch { return [] }
}

export class ServerWorldService {
  constructor(private readonly db: AppDatabase, private readonly servers: ServerRegistry, private readonly backups?: Pick<ServerBackupService, 'hasWorldSnapshot'>) {}

  async get(serverId: string): Promise<ServerWorlds> {
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) throw new ServerWorldsError('SERVER_NOT_FOUND', 'The registered server was not found.')
    if (server.source !== 'created' || !server.managed) {
      return { serverId, status: 'unavailable', levelName: null, levelNameSource: 'unavailable', entries: [], reason: 'Imported server folders remain read only and are not scanned.' }
    }
    const root = await realpath(this.servers.managedRoot)
    const directory = resolve(server.directory)
    if (dirname(directory) !== root || await realpath(directory).catch(() => '') !== directory) {
      throw new ServerWorldsError('SERVER_DIRECTORY_REJECTED', 'This server is not a direct child of the managed root.')
    }
    const serverStat = await lstat(directory)
    if (!serverStat.isDirectory() || serverStat.isSymbolicLink()) throw new ServerWorldsError('SERVER_DIRECTORY_UNSAFE', 'The managed server directory is unavailable or unsafe.')
    const properties = await this.readProperties(join(directory, 'server.properties'))
    if (!properties.ok) return { serverId, status: 'unavailable', levelName: null, levelNameSource: 'unavailable', entries: [], reason: properties.reason }
    const serverStatAfterRead = await lstat(directory).catch(() => null)
    if (!serverStatAfterRead || !serverStatAfterRead.isDirectory() || serverStatAfterRead.isSymbolicLink()
      || serverStatAfterRead.dev !== serverStat.dev || serverStatAfterRead.ino !== serverStat.ino
      || await realpath(directory).catch(() => '') !== directory) {
      throw new ServerWorldsError('SERVER_DIRECTORY_UNSAFE', 'The managed server directory changed during world inspection.')
    }
    const values = parseProperties(properties.text)
    const configured = values.get('level-name')
    const levelName = configured === undefined || configured === '' ? 'world' : safeWorldPath(configured)
    if (levelName === null) return { serverId, status: 'unavailable', levelName: null, levelNameSource: 'unavailable', entries: [], reason: 'The configured level-name is not a safe server-relative path.' }
    const levelNameSource: ServerWorlds['levelNameSource'] = configured === undefined || configured === '' ? 'minecraft-default' : 'server.properties'
    const candidates = new Map<string, ServerWorldEntry['dimension']>()
    candidates.set(levelName, 'overworld')
    if (!levelName.includes('/')) {
      candidates.set(levelName + '_nether', 'nether')
      candidates.set(levelName + '_the_end', 'end')
    }
    for (const path of configuredWorldFolders(server.worldFolders)) {
      if (!candidates.has(path)) candidates.set(path, 'custom')
    }
    if (candidates.size > MAX_WORLDS) throw new ServerWorldsError('WORLD_LIMIT', 'The registered world folder list exceeds the safe inventory limit.')
    const entries: ServerWorldEntry[] = []
    for (const [path, dimension] of candidates) entries.push(await this.inspectWorld(serverId, directory, serverStat.dev, path, dimension))
    return { serverId, status: 'available', levelName, levelNameSource, entries, reason: null }
  }

  private async readProperties(path: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
    const stat = await lstat(path).catch((error) => fsError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) return { ok: false, reason: 'server.properties is not available, so the active world name is unknown.' }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_PROPERTIES_BYTES) return { ok: false, reason: 'server.properties is linked, not a regular file, or exceeds the 64 KiB inspection limit.' }
    let handle
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
    catch { return { ok: false, reason: 'server.properties could not be opened without following a link.' } }
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink > 1 || opened.size > MAX_PROPERTIES_BYTES) {
        return { ok: false, reason: 'server.properties changed during the bounded world-name inspection.' }
      }
      const bytes = await handle.readFile()
      if (bytes.byteLength > MAX_PROPERTIES_BYTES) return { ok: false, reason: 'server.properties exceeds the 64 KiB inspection limit.' }
      try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } }
      catch { return { ok: false, reason: 'server.properties is not valid UTF-8.' } }
    } finally { await handle.close() }
  }

  private async inspectWorld(serverId: string, serverDirectory: string, serverDevice: number, path: string, dimension: ServerWorldEntry['dimension']): Promise<ServerWorldEntry> {
    const parts = path.split('/')
    const absolute = join(serverDirectory, ...parts)
    const base = { name: parts.at(-1)!, path, dimension, backupAvailable: false }
    let rootStat
    try { rootStat = await lstat(absolute) }
    catch (error) {
      if (fsError(error) && error.code === 'ENOENT') return { ...base, state: 'missing', sizeBytes: null, sizeComplete: false, modifiedAt: null, reason: 'No directory exists at the configured server-relative world path.' }
      throw error
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev !== serverDevice || !inside(serverDirectory, await realpath(absolute).catch(() => ''))) {
      return { ...base, state: 'unsafe', sizeBytes: null, sizeComplete: false, modifiedAt: null, reason: 'This path is not a safe directory inside the managed server folder.' }
    }
    let inspected = 0
    let sizeBytes = 0
    let modifiedMs = rootStat.mtimeMs
    let complete = true
    let reason: string | null = null
    let stopScan = false
    const deadline = Date.now() + MAX_WORLD_SCAN_MS
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_WORLD_DEPTH) { complete = false; reason ??= 'World size inspection stopped at ' + MAX_WORLD_DEPTH + ' nested levels.'; return }
      let directoryStat
      let canonical
      try {
        directoryStat = await lstat(directory)
        canonical = await realpath(directory)
      } catch { complete = false; reason ??= 'A folder changed during inspection.'; return }
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.dev !== serverDevice || !inside(serverDirectory, canonical)) {
        complete = false; reason ??= 'A folder changed or moved outside the managed server directory.'; return
      }
      let directoryHandle
      try { directoryHandle = await opendir(directory, { bufferSize: 32 }) }
      catch { complete = false; reason ??= 'A folder could not be read; the size is a lower bound.'; return }
      try {
        let afterRead
        try { afterRead = await lstat(directory) } catch { complete = false; reason ??= 'A folder changed during inspection.'; return }
        if (!afterRead.isDirectory() || afterRead.isSymbolicLink() || afterRead.dev !== directoryStat.dev || afterRead.ino !== directoryStat.ino
          || await realpath(directory).catch(() => '') !== canonical) {
          complete = false; reason ??= 'A folder changed during inspection.'; return
        }
        for await (const entry of directoryHandle) {
          if (Date.now() > deadline) { complete = false; stopScan = true; reason ??= 'World size inspection stopped at the 5 second time limit.'; return }
          if (inspected >= MAX_WORLD_ENTRIES) { complete = false; stopScan = true; reason ??= 'World size inspection stopped at ' + MAX_WORLD_ENTRIES + ' entries.'; return }
          inspected += 1
          let currentParent
          try { currentParent = await lstat(directory) } catch { complete = false; stopScan = true; reason ??= 'A folder changed during inspection.'; return }
          if (!currentParent.isDirectory() || currentParent.isSymbolicLink() || currentParent.dev !== directoryStat.dev || currentParent.ino !== directoryStat.ino
            || await realpath(directory).catch(() => '') !== canonical) {
            complete = false; stopScan = true; reason ??= 'A folder changed during inspection.'; return
          }
          const childPath = join(directory, entry.name)
          let stat
          try { stat = await lstat(childPath) } catch { complete = false; reason ??= 'A filesystem entry changed during inspection.'; continue }
          if (stat.mtimeMs > modifiedMs) modifiedMs = stat.mtimeMs
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.dev !== serverDevice || (stat.isFile() && stat.nlink > 1)) {
            complete = false
            reason ??= 'Links, special files, hard links and nested mounts were skipped.'
            continue
          }
          if (stat.isDirectory()) await visit(childPath, depth + 1)
          else {
            if (!Number.isSafeInteger(stat.size) || sizeBytes > Number.MAX_SAFE_INTEGER - stat.size) {
              complete = false
              reason ??= 'The total size exceeds the safe integer range.'
            } else sizeBytes += stat.size
          }
          if (stopScan) return
        }
      } finally { await directoryHandle.close().catch(() => undefined) }
    }
    await visit(absolute, 0)
    return {
      ...base,
      state: complete ? 'available' : 'incomplete',
      backupAvailable: await this.backups?.hasWorldSnapshot(serverId, path) ?? false,
      sizeBytes,
      sizeComplete: complete,
      modifiedAt: new Date(modifiedMs).toISOString(),
      reason,
    }
  }
}
