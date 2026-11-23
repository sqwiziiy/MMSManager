import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, open, opendir, realpath, unlink, chmod } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerEvents, localServerRuntime, localServers } from '../db/schema.js'
import type { ServerModEntry, ServerModsInventory } from '@mmsmanager/shared'
import type { ServerRegistry } from './registry.js'
import type { ServerProcessManager } from './processes.js'

export const MAX_MOD_JAR_BYTES = 128 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 500
const MAX_JARS = 250
const MAX_CENTRAL_DIRECTORY_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_METADATA_BYTES = 64 * 1024
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

type JarMetadata = Pick<ServerModEntry, 'metadataKind' | 'metadataState' | 'modId' | 'name' | 'artifactVersion' | 'minecraftConstraint' | 'loaderConstraint' | 'dependencies'>
type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number }

export class ServerModsError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) && !path.includes('\0'))
}
function safeJarName(name: string): boolean {
  return name.length > 4 && name.length <= 180 && name.toLowerCase().endsWith('.jar')
    && /^[A-Za-z0-9][A-Za-z0-9._ -]*\.jar$/.test(name) && !/[. ]$/.test(name.slice(0, -4)) && name !== '.' && name !== '..'
}
function zipPathSafe(name: string): boolean {
  if (!name || name.startsWith('/') || name.startsWith('\\') || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name)) return false
  const clean = name.endsWith('/') ? name.slice(0, -1) : name
  return Boolean(clean) && clean.split('/').every((part) => part !== '' && part !== '..' && part !== '.')
}
function readExact(buffer: Buffer, offset: number, length: number): Buffer {
  if (offset < 0 || length < 0 || offset + length > buffer.byteLength) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR archive has an invalid directory entry.')
  return buffer.subarray(offset, offset + length)
}
async function readAt(handle: Awaited<ReturnType<typeof open>>, position: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size)
  const { bytesRead } = await handle.read(buffer, 0, size, position)
  if (bytesRead !== size) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR archive is incomplete or malformed.')
  return buffer
}
function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
function parseScalar(raw: string): string | null {
  const value = raw.trim().replace(/\s+#.*$/, '')
  if (!value || value === 'null' || value === '~' || value.startsWith('{') || value.startsWith('[')) return null
  const unquoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value
  const hasControls = [...unquoted].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  return unquoted.length > 0 && unquoted.length <= 160 && !hasControls ? unquoted : null
}
function parsePaperYaml(text: string): JarMetadata {
  let section = ''
  let dependenciesUnknown = false
  const fields = new Map<string, string>()
  const dependencies: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 512 || /^\s*[&*!]|\t/.test(line)) continue
    if (/^dependencies\s*:/.test(line)) { dependenciesUnknown = true; section = ''; continue }
    const heading = /^(depend|softdepend|loadbefore):\s*(.*?)\s*$/.exec(line)
    if (heading) {
      section = heading[1]!
      const raw = heading[2]!.replace(/\s+#.*$/, '').trim()
      if (!raw) continue
      if (!['depend', 'softdepend'].includes(section)) { section = ''; continue }
      if (raw.startsWith('[') && raw.endsWith(']')) {
        const parsed = raw.slice(1, -1).split(',').map((item) => parseScalar(item)).filter((item): item is string => item !== null)
        if (parsed.some((item) => !/^[A-Za-z0-9_.-]{1,128}$/.test(item))) dependenciesUnknown = true
        else dependencies.push(...parsed.slice(0, Math.max(0, 64 - dependencies.length)))
      } else dependenciesUnknown = true
      section = ''
      continue
    }
    const entry = /^\s+-\s*([^\s#]+)\s*(?:#.*)?$/.exec(line)
    if (entry && ['depend', 'softdepend'].includes(section)) {
      if (dependencies.length < 64 && /^[A-Za-z0-9_.-]{1,128}$/.test(entry[1]!)) dependencies.push(entry[1]!)
      else dependenciesUnknown = true
      continue
    }
    if (section && line.trim() && !line.trimStart().startsWith('#')) { section = ''; dependenciesUnknown = true }
    const scalar = /^(name|version|main|api-version):\s*(.*?)\s*$/.exec(line)
    if (scalar) {
      section = ''
      const parsed = parseScalar(scalar[2]!)
      if (parsed) fields.set(scalar[1]!, parsed)
    }
  }
  const name = fields.get('name') ?? null
  const version = fields.get('version') ?? null
  return {
    metadataKind: 'paper', metadataState: name && version ? 'known' : 'unknown', modId: name,
    name, artifactVersion: version, minecraftConstraint: fields.get('api-version') ?? null,
    loaderConstraint: null, dependencies: dependenciesUnknown ? null : [...new Set(dependencies)],
  }
}
function parseFabricJson(text: string): JarMetadata {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid')
    const record = value as Record<string, unknown>
    const boundedString = (input: unknown, max: number) => typeof input === 'string' && input.length > 0 && input.length <= max ? input : null
    const id = boundedString(record['id'], 128)
    const name = boundedString(record['name'], 160)
    const version = typeof record['version'] === 'string' || typeof record['version'] === 'number' ? String(record['version']).slice(0, 120) : null
    const rawDepends = record['depends']
    const depends = rawDepends && typeof rawDepends === 'object' && !Array.isArray(rawDepends) ? rawDepends as Record<string, unknown> : {}
    const dependencyKeys = Object.keys(depends)
    const dependencies = dependencyKeys.filter((key) => /^[A-Za-z0-9_.-]{1,128}$/.test(key))
    const dependenciesParsed = (rawDepends === undefined || (typeof rawDepends === 'object' && rawDepends !== null && !Array.isArray(rawDepends)))
      && dependencies.length === dependencyKeys.length && dependencyKeys.length <= 64
    return {
      metadataKind: 'fabric', metadataState: id && name && version ? 'known' : 'unknown', modId: id, name, artifactVersion: version,
      minecraftConstraint: boundedString(depends['minecraft'], 120), loaderConstraint: boundedString(depends['fabricloader'], 120), dependencies: dependenciesParsed ? dependencies : null,
    }
  } catch {
    return { metadataKind: 'fabric', metadataState: 'unknown', modId: null, name: null, artifactVersion: null, minecraftConstraint: null, loaderConstraint: null, dependencies: null }
  }
}

/** Reads only bounded ZIP directory records and the two small root metadata files. Nothing is extracted. */
export async function inspectModJar(filePath: string): Promise<JarMetadata> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null)
  if (!handle) throw new ServerModsError('UNSAFE_FILE', 'The JAR could not be opened as a safe regular file.')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_MOD_JAR_BYTES) throw new ServerModsError('INVALID_ARCHIVE', 'Upload a JAR archive no larger than 128 MiB.')
    const tailSize = Math.min(stat.size, 65_557)
    const tail = await readAt(handle, stat.size - tailSize, tailSize)
    let eocd = -1
    for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE && index + 22 + tail.readUInt16LE(index + 20) === tail.byteLength) { eocd = index; break }
    }
    if (eocd < 0) throw new ServerModsError('INVALID_ARCHIVE', 'The upload is not a complete JAR/ZIP archive.')
    const disk = tail.readUInt16LE(eocd + 4)
    const directoryDisk = tail.readUInt16LE(eocd + 6)
    const entriesOnDisk = tail.readUInt16LE(eocd + 8)
    const entriesTotal = tail.readUInt16LE(eocd + 10)
    const directorySize = tail.readUInt32LE(eocd + 12)
    const directoryOffset = tail.readUInt32LE(eocd + 16)
    const absoluteEocd = stat.size - tailSize + eocd
    if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entriesTotal || entriesTotal === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
      || entriesTotal > MAX_ARCHIVE_ENTRIES || directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize > absoluteEocd) {
      throw new ServerModsError('INVALID_ARCHIVE', 'The JAR archive uses unsupported or oversized ZIP directory structures.')
    }
    const directory = await readAt(handle, directoryOffset, directorySize)
    let offset = 0
    const metadataEntries = new Map<string, { method: number; compressedSize: number; size: number; crc: number; localOffset: number }>()
    for (let index = 0; index < entriesTotal; index += 1) {
      if (offset + 46 > directory.byteLength) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR central directory is truncated.')
      if (readExact(directory, offset, 4).readUInt32LE(0) !== CENTRAL_SIGNATURE) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR central directory is malformed.')
      const flags = directory.readUInt16LE(offset + 8)
      const method = directory.readUInt16LE(offset + 10)
      const crc = directory.readUInt32LE(offset + 16)
      const compressedSize = directory.readUInt32LE(offset + 20)
      const size = directory.readUInt32LE(offset + 24)
      const nameLength = directory.readUInt16LE(offset + 28)
      const extraLength = directory.readUInt16LE(offset + 30)
      const commentLength = directory.readUInt16LE(offset + 32)
      const diskStart = directory.readUInt16LE(offset + 34)
      const externalAttributes = directory.readUInt32LE(offset + 38)
      const localOffset = directory.readUInt32LE(offset + 42)
      const recordLength = 46 + nameLength + extraLength + commentLength
      const rawName = readExact(directory, offset + 46, nameLength)
      offset += recordLength
      if (diskStart !== 0 || !zipPathSafe(rawName.toString(flags & 0x800 ? 'utf8' : 'latin1')) || flags & 1 || ![0, 8].includes(method)
        || compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
        throw new ServerModsError('INVALID_ARCHIVE', 'The JAR contains an unsafe, encrypted, multi-disk, or unsupported ZIP entry.')
      }
      const dataStart = localOffset + 30 + nameLength + extraLength
      if (localOffset + 30 > directoryOffset || dataStart + compressedSize > directoryOffset) throw new ServerModsError('INVALID_ARCHIVE', 'A JAR entry points outside the archive data area.')
      const unixMode = externalAttributes >>> 16
      if ((unixMode & 0xf000) === 0xa000) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR contains a symbolic-link entry.')
      const fileName = rawName.toString(flags & 0x800 ? 'utf8' : 'latin1')
      if (fileName === 'fabric.mod.json' || fileName === 'plugin.yml' || fileName === 'paper-plugin.yml') {
        if (metadataEntries.has(fileName) || size > MAX_METADATA_BYTES || compressedSize > MAX_METADATA_BYTES) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR metadata is duplicated or exceeds the 64 KiB limit.')
        metadataEntries.set(fileName, { method, compressedSize, size, crc, localOffset })
      }
    }
    if (offset !== directory.byteLength) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR central directory length does not match its entries.')
    const readMetadata = async (entry: NonNullable<ReturnType<typeof metadataEntries.get>>): Promise<Buffer> => {
      const header = await readAt(handle, entry.localOffset, 30)
      if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR metadata entry has an invalid local header.')
      const nameLength = header.readUInt16LE(26)
      const extraLength = header.readUInt16LE(28)
      const start = entry.localOffset + 30 + nameLength + extraLength
      if (start + entry.compressedSize > directoryOffset) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR metadata entry points outside its file data area.')
      const compressed = await readAt(handle, start, entry.compressedSize)
      let output: Buffer
      try {
        output = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_METADATA_BYTES })
      } catch { throw new ServerModsError('INVALID_ARCHIVE', 'The JAR metadata could not be safely decompressed.') }
      if (output.byteLength !== entry.size || crc32(output) !== entry.crc) throw new ServerModsError('INVALID_ARCHIVE', 'The JAR metadata checksum or uncompressed size is invalid.')
      return output
    }
    const fabric = metadataEntries.get('fabric.mod.json')
    if (fabric) return parseFabricJson((await readMetadata(fabric)).toString('utf8'))
    const paper = metadataEntries.get('paper-plugin.yml') ?? metadataEntries.get('plugin.yml')
    if (paper) return parsePaperYaml((await readMetadata(paper)).toString('utf8'))
    return { metadataKind: 'unknown', metadataState: 'unknown', modId: null, name: null, artifactVersion: null, minecraftConstraint: null, loaderConstraint: null, dependencies: null }
  } finally { await handle.close() }
}

export class ServerModsService {
  constructor(private readonly db: AppDatabase, private readonly servers: ServerRegistry, private readonly processes: ServerProcessManager, private readonly now: () => number = Date.now) {}

  async list(serverId: string): Promise<ServerModsInventory> {
    const server = this.serverRow(serverId)
    const loader = server.software === 'fabric' ? 'fabric' : server.software === 'paper' ? 'paper' : 'unsupported'
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    const status = server.source === 'imported' || !server.managed ? 'external/unmanaged' : runtime?.status ?? 'stopped'
    const base = { serverId, supported: loader !== 'unsupported', loader, loadDirectory: loader === 'fabric' ? 'mods' : loader === 'paper' ? 'plugins' : null, truncated: false, restartRequired: runtime?.restartRequired ?? false, runtimeStatus: status } as const
    if (loader === 'unsupported') return { ...base, items: [] }
    const serverPath = await this.serverPath(server)
    const loadPath = await this.loadPath(serverPath, base.loadDirectory!, false)
    const active = await this.readJarDirectory(loadPath, 'enabled', server.software)
    const disabledPath = await this.privatePath(serverPath, join('disabled-mods', server.software), false)
    const disabled = await this.readJarDirectory(disabledPath, 'disabled', server.software, true)
    const quarantinePath = await this.privatePath(serverPath, join('quarantine', 'mods'), false)
    const quarantined = await this.readJarDirectory(quarantinePath, 'quarantined', server.software, true)
    const items = [...active.items, ...disabled.items, ...quarantined.items].slice(0, 300)
    return { ...base, items, truncated: active.truncated || disabled.truncated || quarantined.truncated || items.length < active.items.length + disabled.items.length + quarantined.items.length }
  }

  async upload(serverId: string, actorUserId: string, originalName: string, stream: NodeJS.ReadableStream, truncated: () => boolean): Promise<ServerModsInventory> {
    if (!safeJarName(originalName)) throw new ServerModsError('INVALID_FILENAME', 'Choose a JAR file with a simple filename (letters, numbers, spaces, dot, underscore or hyphen).')
    return this.mutate(serverId, actorUserId, 'mod-uploaded', async (server, serverPath, loadPath, running) => {
      await mkdir(loadPath, { recursive: true, mode: 0o700 })
      await this.assertRealDirectory(loadPath)
      const entries = await this.listLoadNames(loadPath)
      if (entries.some((entry) => entry.toLowerCase() === originalName.toLowerCase())) throw new ServerModsError('MOD_DUPLICATE', 'A mod or plugin with that filename already exists.')
      const stagedPath = join(loadPath, `.mms-${randomUUID()}.part`)
      const target = join(loadPath, originalName)
      const hash = createHash('sha256')
      let size = 0
      let installedIdentity: { dev: number; ino: number } | null = null
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength
        if (size > MAX_MOD_JAR_BYTES) { callback(new ServerModsError('MOD_TOO_LARGE', 'A mod or plugin JAR may not exceed 128 MiB.')); return }
        hash.update(chunk)
        callback(null, chunk)
      } })
      try {
        await pipeline(stream, meter, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }))
        if (truncated()) throw new ServerModsError('MOD_TOO_LARGE', 'The upload exceeded the 128 MiB limit.')
        if (size === 0) throw new ServerModsError('INVALID_ARCHIVE', 'The uploaded JAR is empty.')
        const metadata = await inspectModJar(stagedPath)
        const stagedStat = await lstat(stagedPath)
        if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) throw new ServerModsError('UNSAFE_FILE', 'The staged upload is not a regular file.')
        await link(stagedPath, target).catch((error: unknown) => {
          if (isNodeError(error) && error.code === 'EEXIST') throw new ServerModsError('MOD_DUPLICATE', 'A mod or plugin with that filename already exists.')
          throw error
        })
        const linkedStat = await lstat(target)
        installedIdentity = { dev: linkedStat.dev, ino: linkedStat.ino }
        await unlink(stagedPath)
        await chmod(target, 0o600)
        await this.audit(server.id, actorUserId, 'mod-uploaded', 'success', { fileName: originalName, sizeBytes: size, sha256: hash.digest('hex'), metadataKind: metadata.metadataKind, metadataState: metadata.metadataState })
        this.markRestartRequired(server.id, running)
      } catch (error) {
        if (installedIdentity) {
          const current = await lstat(target).catch(() => null)
          if (current?.dev === installedIdentity.dev && current.ino === installedIdentity.ino) await unlink(target).catch(() => undefined)
        }
        await unlink(stagedPath).catch(() => undefined)
        throw error
      }
      void serverPath
    })
  }

  async setEnabled(serverId: string, actorUserId: string, fileName: string, enabled: boolean): Promise<ServerModsInventory> {
    if (!safeJarName(fileName)) throw new ServerModsError('INVALID_FILENAME', 'The selected mod filename is invalid.')
    return this.mutate(serverId, actorUserId, enabled ? 'mod-enabled' : 'mod-disabled', async (server, serverPath, loadPath, running) => {
      const source = enabled ? await this.privatePath(serverPath, join('disabled-mods', server.software), true) : loadPath
      const targetDirectory = enabled ? loadPath : await this.privatePath(serverPath, join('disabled-mods', server.software), true)
      const sourceName = enabled ? this.findDisabledName(await this.listLoadNames(source), fileName) : fileName
      if (!sourceName) throw new ServerModsError('MOD_NOT_FOUND', 'The selected mod or plugin was not found.')
      await this.safeMove(source, sourceName, targetDirectory, enabled ? fileName : this.disabledName(fileName))
      await this.audit(server.id, actorUserId, enabled ? 'mod-enabled' : 'mod-disabled', 'success', { fileName, state: enabled ? 'enabled' : 'disabled' })
      this.markRestartRequired(server.id, running)
    })
  }

  async quarantine(serverId: string, actorUserId: string, fileName: string): Promise<ServerModsInventory> {
    if (!safeJarName(fileName)) throw new ServerModsError('INVALID_FILENAME', 'The selected mod filename is invalid.')
    return this.mutate(serverId, actorUserId, 'mod-quarantined', async (server, serverPath, loadPath, running) => {
      const activeNames = await this.listLoadNames(loadPath)
      const disabledPath = await this.privatePath(serverPath, join('disabled-mods', server.software), true)
      const disabledNames = await this.listLoadNames(disabledPath)
      const source = activeNames.includes(fileName) ? loadPath : disabledNames.includes(this.disabledName(fileName)) ? disabledPath : null
      const sourceName = source === disabledPath ? this.disabledName(fileName) : fileName
      if (!source) throw new ServerModsError('MOD_NOT_FOUND', 'The selected mod or plugin was not found.')
      const quarantinePath = await this.privatePath(serverPath, join('quarantine', 'mods'), true)
      const archiveName = `${randomUUID()}--${fileName}`
      const stat = await lstat(join(source, sourceName))
      const sha256 = await hashFile(join(source, sourceName), stat)
      await this.safeMove(source, sourceName, quarantinePath, archiveName)
      await this.audit(server.id, actorUserId, 'mod-quarantined', 'success', { fileName, sizeBytes: stat.size, sha256 })
      this.markRestartRequired(server.id, running)
    })
  }

  async restoreQuarantine(serverId: string, actorUserId: string, id: string): Promise<ServerModsInventory> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ServerModsError('MOD_NOT_FOUND', 'The quarantine item was not found.')
    return this.mutate(serverId, actorUserId, 'mod-restored', async (server, serverPath, loadPath, running) => {
      const quarantinePath = await this.privatePath(serverPath, join('quarantine', 'mods'), true)
      const names = await this.listLoadNames(quarantinePath)
      const archiveName = names.find((name) => name.startsWith(`${id}--`))
      if (!archiveName) throw new ServerModsError('MOD_NOT_FOUND', 'The quarantine item was not found.')
      const fileName = archiveName.slice(38)
      if (!safeJarName(fileName)) throw new ServerModsError('UNSAFE_FILE', 'The quarantined filename is invalid.')
      const activeNames = await this.listLoadNames(loadPath)
      const disabledPath = await this.privatePath(serverPath, join('disabled-mods', server.software), true)
      const disabledNames = await this.listLoadNames(disabledPath)
      if ([...activeNames, ...disabledNames].some((name) => name.toLowerCase() === fileName.toLowerCase() || name.endsWith(`--${fileName}`))) throw new ServerModsError('MOD_DUPLICATE', 'A file with the original name already exists. Resolve the collision before restoring.')
      await this.safeMove(quarantinePath, archiveName, loadPath, fileName)
      await this.audit(server.id, actorUserId, 'mod-restored', 'success', { fileName, quarantineId: id })
      this.markRestartRequired(server.id, running)
    })
  }

  private async mutate(serverId: string, actorUserId: string, action: string, operation: (server: typeof localServers.$inferSelect, serverPath: string, loadPath: string, running: boolean) => Promise<void>): Promise<ServerModsInventory> {
    const server = this.serverRow(serverId)
    const loader = server.software === 'fabric' ? 'mods' : server.software === 'paper' ? 'plugins' : null
    if (!loader) throw new ServerModsError('MODS_UNSUPPORTED', 'File management currently supports Fabric mods and Paper plugins only.')
    if (server.source !== 'created' || !server.managed) throw new ServerModsError('SERVER_NOT_PANEL_MANAGED', 'Imported server folders are read only.')
    try {
      await this.processes.withServerFileMutation(serverId, async (running) => {
        const serverPath = await this.serverPath(server)
        const loadPath = await this.loadPath(serverPath, loader, true)
        await operation(server, serverPath, loadPath, running)
      })
    } catch (error) {
      await this.audit(server.id, actorUserId, action, 'failure', { code: error instanceof ServerModsError ? error.code : 'MOD_OPERATION_FAILED' }).catch(() => undefined)
      throw error
    }
    return this.list(serverId)
  }

  private async serverPath(server: typeof localServers.$inferSelect): Promise<string> {
    const candidate = resolve(server.directory)
    const stat = await lstat(candidate).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new ServerModsError('SERVER_DIRECTORY_UNSAFE', 'The registered server directory is unavailable or unsafe.')
    const canonical = await realpath(candidate)
    if (candidate !== canonical) throw new ServerModsError('SERVER_DIRECTORY_UNSAFE', 'The registered server directory resolves through a symbolic link.')
    if (server.source === 'created' && server.managed) {
      const root = await realpath(this.servers.managedRoot).catch(() => '')
      const rel = root ? relative(root, candidate) : ''
      if (!root || !isWithin(root, candidate) || !rel || rel.includes(sep)) throw new ServerModsError('SERVER_DIRECTORY_UNSAFE', 'The server is outside the direct child of the managed server root.')
    }
    return canonical
  }

  private async loadPath(serverPath: string, name: string, create: boolean): Promise<string> {
    const path = join(serverPath, name)
    if (create) await mkdir(path, { recursive: true, mode: 0o700 })
    try { await this.assertRealDirectory(path) } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT' && !create) return path
      throw error
    }
    return path
  }

  private async privatePath(serverPath: string, relativePath: string, create: boolean): Promise<string> {
    const root = join(serverPath, '.mmsmanager')
    if (create) await mkdir(root, { recursive: true, mode: 0o700 })
    try { await this.assertRealDirectory(root) } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT' && !create) return join(root, relativePath)
      throw error
    }
    const target = join(root, relativePath)
    if (create) await mkdir(target, { recursive: true, mode: 0o700 })
    try { await this.assertRealDirectory(target) } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT' && !create) return target
      throw error
    }
    if (!isWithin(root, await realpath(target))) throw new ServerModsError('UNSAFE_DIRECTORY', 'The private mod storage resolved outside its managed directory.')
    return target
  }

  private async assertRealDirectory(path: string): Promise<void> {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServerModsError('UNSAFE_DIRECTORY', 'A mod storage folder is not a safe directory.')
    await chmod(path, 0o700)
    if (await realpath(path) !== resolve(path)) throw new ServerModsError('UNSAFE_DIRECTORY', 'A mod storage folder resolved through a symbolic link.')
  }

  private async readJarDirectory(path: string, state: ServerModEntry['state'], software: string, prefixed = false): Promise<{ items: ServerModEntry[]; truncated: boolean }> {
    const items: ServerModEntry[] = []
    let truncated = false
    let directory
    try { directory = await opendir(path) } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { items, truncated }
      throw new ServerModsError('MOD_DIRECTORY_UNAVAILABLE', 'The mod directory could not be read safely.')
    }
    let count = 0
    for await (const entry of directory) {
      count += 1
      if (count > MAX_DIRECTORY_ENTRIES) { truncated = true; break }
      if (!entry.isFile()) continue
      const isJar = prefixed ? /^(?:disabled-[a-f0-9]{8}|[0-9a-f-]{36})--.+\.jar$/i.test(entry.name) : safeJarName(entry.name)
      if (!isJar) continue
      if (items.length >= MAX_JARS) { truncated = true; break }
      const storedName = entry.name
      const fileName = prefixed ? storedName.replace(/^(?:disabled-[a-f0-9]{8}|[0-9a-f-]{36})--/i, '') : storedName
      if (!safeJarName(fileName)) continue
      const filePath = join(path, storedName)
      const fileStat = await lstat(filePath)
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_MOD_JAR_BYTES) continue
      let metadata: JarMetadata
      try { metadata = await inspectModJar(filePath) } catch {
        metadata = { metadataKind: 'unknown', metadataState: 'unknown', modId: null, name: null, artifactVersion: null, minecraftConstraint: null, loaderConstraint: null, dependencies: null }
      }
      const quarantineId = state === 'quarantined' ? storedName.slice(0, 36) : null
      items.push({ id: quarantineId ?? fileName, fileName, sizeBytes: fileStat.size, state, ...metadata })
    }
    void software
    return { items, truncated }
  }

  private async listLoadNames(path: string): Promise<string[]> {
    const names: string[] = []
    try {
      for await (const entry of await opendir(path)) {
        if (names.length >= MAX_DIRECTORY_ENTRIES) throw new ServerModsError('MOD_DIRECTORY_LIMIT', 'The mod directory has too many entries to mutate safely.')
        names.push(entry.name)
      }
      return names
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      throw error
    }
  }

  private findDisabledName(names: string[], fileName: string): string | null {
    const expected = this.disabledName(fileName)
    return names.includes(expected) ? expected : null
  }
  private disabledName(fileName: string): string { return `disabled-${createHash('sha256').update(fileName).digest('hex').slice(0, 8)}--${fileName}` }

  private async safeMove(sourceDirectory: string, sourceName: string, targetDirectory: string, targetName: string): Promise<void> {
    if (!safeJarName(sourceName.replace(/^(?:disabled-[a-f0-9]{8}|[0-9a-f-]{36})--/, '')) && !/^[0-9a-f-]{36}--.+\.jar$/.test(sourceName)) throw new ServerModsError('INVALID_FILENAME', 'The selected file name is invalid.')
    if (!safeJarName(targetName) && !/^[0-9a-f-]{36}--.+\.jar$/.test(targetName)) throw new ServerModsError('INVALID_FILENAME', 'The target file name is invalid.')
    const source = join(sourceDirectory, sourceName)
    const target = join(targetDirectory, targetName)
    const before = await lstat(source).catch(() => null)
    if (!before?.isFile() || before.isSymbolicLink() || before.size > MAX_MOD_JAR_BYTES) throw new ServerModsError('MOD_NOT_FOUND', 'The selected mod or plugin file is missing or unsafe.')
    await link(source, target).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'EEXIST') throw new ServerModsError('MOD_DUPLICATE', 'A file with the target name already exists.')
      throw error
    })
    const [linked, current] = await Promise.all([lstat(target), lstat(source).catch(() => null)])
    const sameFile = current && before.dev === linked.dev && before.ino === linked.ino && current.dev === before.dev && current.ino === before.ino
    if (!linked.isFile() || linked.isSymbolicLink() || !sameFile || linked.size !== before.size) {
      await unlink(target).catch(() => undefined)
      throw new ServerModsError('FILE_CHANGED', 'The selected mod changed during the operation. No replacement was applied.')
    }
    await chmod(target, 0o600)
    const confirmed = await lstat(source).catch(() => null)
    if (!confirmed || confirmed.dev !== before.dev || confirmed.ino !== before.ino) {
      await unlink(target).catch(() => undefined)
      throw new ServerModsError('FILE_CHANGED', 'The selected mod changed before it could be moved.')
    }
    await unlink(source)
  }

  private markRestartRequired(serverId: string, running: boolean): void {
    if (!running) return
    const at = new Date(this.now()).toISOString()
    this.db.update(localServerRuntime).set({ restartRequired: true, updatedAt: at }).where(eq(localServerRuntime.serverId, serverId)).run()
  }

  private async audit(serverId: string, actorUserId: string, action: string, outcome: 'success' | 'failure', metadata: Record<string, string | number>): Promise<void> {
    this.db.insert(localServerEvents).values({ serverId, actorUserId, action, outcome, occurredAt: new Date(this.now()).toISOString(), detail: JSON.stringify(metadata) }).run()
  }

  private serverRow(serverId: string) {
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) throw new ServerModsError('SERVER_NOT_FOUND', 'The registered server was not found.')
    return server
  }
}

async function hashFile(path: string, expected: FileIdentity): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) throw new ServerModsError('FILE_CHANGED', 'The selected mod changed during the operation.')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path, { fd: handle.fd, autoClose: false })) hash.update(chunk as Buffer)
    const after = await handle.stat()
    if (after.size !== expected.size || after.mtimeMs !== expected.mtimeMs) throw new ServerModsError('FILE_CHANGED', 'The selected mod changed while it was being inspected.')
    return hash.digest('hex')
  } finally { await handle.close() }
}
