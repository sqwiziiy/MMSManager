import { constants } from 'node:fs'
import { lstat, open, realpath, readdir, mkdir, chmod } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerEvents, localServers } from '../db/schema.js'

export class ServerInventoryError extends Error {
  constructor(readonly code: 'invalid-path' | 'outside-allowlist' | 'not-directory' | 'unsafe-file' | 'duplicate' | 'not-found', message: string) {
    super(message)
  }
}

export type ImportPreview = {
  path: string
  directoryName: string
  software: 'vanilla' | 'fabric' | 'paper' | 'unknown'
  version: string | null
  jarName: string | null
  port: number | null
  eula: 'accepted' | 'not-accepted' | 'unknown'
  worldFolders: string[]
  alreadyRegistered: boolean
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
}

async function readSmallRegularFile(directory: string, name: string, maxBytes: number): Promise<string | null> {
  const path = join(directory, name)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) throw new ServerInventoryError('unsafe-file', `The ${name} file is not a small regular file.`)
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > maxBytes) throw new ServerInventoryError('unsafe-file', `The ${name} file is not a small regular file.`)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch (error) {
    if (error instanceof ServerInventoryError) throw error
    if (isNodeError(error) && error.code === 'ENOENT') return null
    if (isNodeError(error) && (error.code === 'ELOOP' || error.code === 'EACCES')) {
      throw new ServerInventoryError('unsafe-file', `The ${name} file could not be safely read.`)
    }
    throw error
  } finally {
    await handle?.close()
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function propertyValue(contents: string | null, key: string): string | null {
  if (!contents) return null
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!=:\s]+)\s*[=:]\s*(.*?)\s*$/)
    if (match?.[1] === key) return match[2] ?? ''
  }
  return null
}

function validPort(value: string | null): number | null {
  if (!value || !/^\d{1,5}$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
}

function detectJar(names: string[]): { jarName: string | null; software: ImportPreview['software']; version: string | null } {
  const jars = names.filter((name) => name.toLowerCase().endsWith('.jar')).sort((a, b) => a.localeCompare(b))
  const jarName = jars.find((name) => /^(?:server(?:[-_.].+)?|minecraft[-_.].+)\.jar$/i.test(name))
    ?? jars.find((name) => /fabric.*server.*\.jar$/i.test(name))
    ?? jars.find((name) => /^paper.*\.jar$/i.test(name))
    ?? jars[0]
    ?? null
  if (!jarName) return { jarName: null, software: 'unknown', version: null }
  const software: ImportPreview['software'] = /fabric/i.test(jarName) ? 'fabric' : /paper/i.test(jarName) ? 'paper' : /^(server(?:[-_.]|\.jar)|minecraft[-_.])/i.test(jarName) ? 'vanilla' : 'unknown'
  const version = jarName.match(/(?:^|[-_])((?:1\.)?\d{1,2}(?:\.\d{1,2}){0,2})(?=[-_.])/i)?.[1] ?? null
  return { jarName, software, version }
}

export class ServerRegistry {
  readonly managedRoot: string
  readonly importRoots: string[]
  readonly dataDirectory: string
  private readonly appOwnedRoot: boolean

  constructor(
    private readonly db: AppDatabase,
    dataDirectory: string,
    env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now,
  ) {
    this.dataDirectory = resolve(dataDirectory)
    this.managedRoot = resolve(env['MMSMANAGER_SERVER_ROOT'] || join(dataDirectory, 'servers'))
    this.appOwnedRoot = !env['MMSMANAGER_SERVER_ROOT']
    const configuredRoots = env['MMSMANAGER_IMPORT_ROOTS']
      ?.split(process.platform === 'win32' ? ';' : ':')
      .map((item) => item.trim())
      .filter(Boolean)
    this.importRoots = (configuredRoots?.length ? configuredRoots : [this.managedRoot]).map((item) => resolve(item))
  }

  async prepare(): Promise<void> {
    await mkdir(this.managedRoot, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.managedRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('The configured local server root must be a real directory, not a symbolic link.')
    }
    if (this.appOwnedRoot) await chmod(this.managedRoot, 0o700)
  }

  async list() {
    const rows = await this.db.select().from(localServers).orderBy(localServers.createdAt)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      directory: row.directory,
      source: row.source,
      software: row.software,
      version: row.version,
      jarName: row.jarName,
      javaPath: row.javaPath,
      javaMajor: row.javaMajor,
      minMemoryMb: row.minMemoryMb,
      maxMemoryMb: row.maxMemoryMb,
      port: row.port,
      eula: row.eula,
      managed: row.managed,
      worldFolders: parseWorldFolders(row.worldFolders),
      createdAt: row.createdAt,
    }))
  }

  async listPublic() {
    const rows = await this.list()
    return rows.map(({ id, name, source, software, version, jarName, javaMajor, minMemoryMb, maxMemoryMb, port, eula, managed, worldFolders, createdAt }) => ({
      id, name, source, software, version, jarName, javaMajor, minMemoryMb, maxMemoryMb, port, eula, managed, worldFolders, createdAt,
    }))
  }

  async inspect(requestedPath: string): Promise<ImportPreview> {
    if (!isAbsolute(requestedPath) || requestedPath.length > 1024) {
      throw new ServerInventoryError('invalid-path', 'Enter an absolute path to one server directory.')
    }
    const normalized = resolve(requestedPath)
    let candidateStat
    try {
      candidateStat = await lstat(normalized)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') throw new ServerInventoryError('not-directory', 'The selected directory does not exist.')
      throw error
    }
    if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
      throw new ServerInventoryError('not-directory', 'Select a real directory, not a file or symbolic link.')
    }
    const canonical = await realpath(normalized)
    let allowed = false
    for (const rootPath of this.importRoots) {
      let canonicalRoot: string
      try {
        canonicalRoot = await realpath(rootPath)
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') continue
        throw error
      }
      if (isWithin(canonicalRoot, canonical)) allowed = true
    }
    if (!allowed) throw new ServerInventoryError('outside-allowlist', 'This path is outside the configured import folders.')

    const entries = await readdir(canonical, { withFileTypes: true })
    const regularFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    const regularNames = new Set(regularFiles)
    const [properties, eulaText] = await Promise.all([
      readSmallRegularFile(canonical, 'server.properties', 65_536),
      readSmallRegularFile(canonical, 'eula.txt', 8_192),
    ])
    const detected = detectJar(regularFiles)
    const worldFolders = entries
      .filter((entry) => entry.isDirectory() && ['world', 'world_nether', 'world_the_end'].includes(entry.name))
      .map((entry) => entry.name)
      .sort()
    const eulaLine = eulaText?.split(/\r?\n/).find((line) => /^\s*eula\s*=/.test(line.trim()))
    const eula = eulaLine ? (/^\s*eula\s*=\s*true\s*$/i.test(eulaLine) ? 'accepted' : 'not-accepted') : 'unknown'
    const existing = await this.db.select({ id: localServers.id }).from(localServers).where(eq(localServers.directory, canonical)).get()
    const dirStat = await lstat(canonical)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new ServerInventoryError('not-directory', 'The selected directory changed while it was being inspected.')
    const safeJar = detected.jarName && regularNames.has(detected.jarName) ? detected.jarName : null
    return {
      path: canonical,
      directoryName: canonical.split(sep).filter(Boolean).at(-1) ?? 'server',
      ...detected,
      jarName: safeJar,
      port: validPort(propertyValue(properties, 'server-port')),
      eula,
      worldFolders,
      alreadyRegistered: Boolean(existing),
    }
  }

  async registerImport(input: { path: string; name: string; minMemoryMb: number; maxMemoryMb: number }, actorUserId: string) {
    const preview = await this.inspect(input.path)
    if (preview.alreadyRegistered) throw new ServerInventoryError('duplicate', 'This server directory is already in the local registry.')
    const at = new Date(this.now()).toISOString()
    const id = randomUUID()
    try {
      this.db.transaction((tx) => {
        tx.insert(localServers).values({
          id,
          name: input.name,
          directory: preview.path,
          source: 'imported',
          software: preview.software,
          version: preview.version,
          jarName: preview.jarName,
          javaPath: null,
          javaMajor: null,
          minMemoryMb: input.minMemoryMb,
          maxMemoryMb: input.maxMemoryMb,
          port: preview.port,
          eula: preview.eula,
          managed: false,
          worldFolders: JSON.stringify(preview.worldFolders),
          createdBy: actorUserId,
          createdAt: at,
          updatedAt: at,
        }).run()
        tx.insert(localServerEvents).values({
          serverId: id,
          actorUserId,
          action: 'server-imported',
          outcome: 'success',
          occurredAt: at,
          detail: 'A local server directory was added to the read-only inventory.',
        }).run()
      })
    } catch (error) {
      if (isNodeError(error) && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ServerInventoryError('duplicate', 'This server directory is already in the local registry.')
      }
      throw error
    }
    return (await this.list()).find((server) => server.id === id)!
  }

  async updateMetadata(serverId: string, name: string, actorUserId: string) {
    const exists = await this.db.select({ id: localServers.id }).from(localServers).where(eq(localServers.id, serverId)).get()
    if (!exists) throw new ServerInventoryError('not-found', 'The registered server was not found.')
    const at = new Date(this.now()).toISOString()
    this.db.transaction((tx) => {
      tx.update(localServers).set({ name, updatedAt: at }).where(eq(localServers.id, serverId)).run()
      tx.insert(localServerEvents).values({ serverId, actorUserId, action: 'server-metadata-updated', outcome: 'success', occurredAt: at, detail: '{}' }).run()
    })
    return (await this.listPublic()).find((server) => server.id === serverId)!
  }
}

function parseWorldFolders(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
