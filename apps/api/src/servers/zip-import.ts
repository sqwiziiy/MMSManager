import { constants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, realpath, readdir, rename, rm, statfs, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { and, eq, isNull } from 'drizzle-orm'
import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import type { LocalServerSummary, ServerZipImportPreview } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { localServerEvents, localServers, serverZipImports } from '../db/schema.js'
import type { JavaRuntimeRegistry } from './java.js'
import type { ServerRegistry } from './registry.js'

export const MAX_SERVER_ZIP_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_ARCHIVE_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_ARCHIVE_RATIO = 200
const MAX_ARCHIVE_DEPTH = 32
const MAX_METADATA_BYTES = 64 * 1024
const IMPORT_TTL_MS = 30 * 60 * 1000
const IGNORED_NAMES = /(?:^|\/)__MACOSX(?:\/|$)|(?:^|\/)\.DS_Store$/i

type ArchiveRecord = {
  entry: Entry
  originalName: string
  relativeName: string
  directory: boolean
  size: number
  compressedSize: number
  excluded: boolean
}
type ArchiveInspection = {
  entries: ArchiveRecord[]
  preview: Omit<ServerZipImportPreview, 'token' | 'uploadName' | 'compressedBytes'>
}
type StoredImport = { preview: ServerZipImportPreview; archiveSha256: string; options?: ZipPublishOptions }
type ZipPublishOptions = {
  name: string; javaPath: string; javaMajor: number; minMemoryMb: number; maxMemoryMb: number; acceptEula: boolean; trustExecutable: true
}
type ZipImportRow = typeof serverZipImports.$inferSelect

function isFsError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 0x20 || codePoint === 0x7f
  })
}
function safeBasename(filename: string): string {
  const normalized = filename.replaceAll('\\', '/')
  return basename(normalized).slice(0, 255)
}
function advertisedPath(name: string, directory: boolean): string {
  if (yauzl.validateFileName(name)) throw new ServerZipImportError('ZIP_PATH_REJECTED', 'The archive contains an absolute or traversing path.')
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0')) {
    throw new ServerZipImportError('ZIP_PATH_REJECTED', 'The archive contains an unsafe path.')
  }
  const withoutSlash = directory && name.endsWith('/') ? name.slice(0, -1) : name
  const segments = withoutSlash.split('/')
  if (!withoutSlash || segments.length > MAX_ARCHIVE_DEPTH || segments.some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255 || containsControl(part))) {
    throw new ServerZipImportError('ZIP_PATH_REJECTED', 'The archive contains an empty, too-deep, or invalid path segment.')
  }
  if (Buffer.byteLength(withoutSlash, 'utf8') > 4096) throw new ServerZipImportError('ZIP_PATH_REJECTED', 'The archive contains a path that is too long.')
  return segments.join('/')
}
function parsePort(contents: string | null): number | null {
  const value = contents?.split(/\r?\n/).map((line) => line.match(/^\s*server-port\s*[=:]\s*(.*?)\s*$/)?.[1]).find((item) => item !== undefined)
  if (!value || !/^\d{1,5}$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= 65535 ? port : null
}
function parseEula(contents: string | null): 'accepted' | 'not-accepted' | 'unknown' {
  const line = contents?.split(/\r?\n/).find((item) => /^\s*eula\s*=/.test(item.trim()))
  if (!line) return 'unknown'
  return /^\s*eula\s*=\s*true\s*$/i.test(line) ? 'accepted' : 'not-accepted'
}
function detectJar(paths: string[]): { jarName: string | null; software: 'vanilla' | 'fabric' | 'paper' | 'unknown'; version: string | null; requiredJavaMajor: number | null } {
  const candidates = paths.filter((name) => !name.includes('/') && name.toLowerCase().endsWith('.jar')).sort((a, b) => a.localeCompare(b))
  const jarName = candidates.find((name) => /^(?:server(?:[-_.].+)?|minecraft[-_.].+|paper[-_.].+|fabric.*server.*)\.jar$/i.test(name)) ?? null
  if (!jarName) return { jarName: null, software: 'unknown', version: null, requiredJavaMajor: null }
  const software = /fabric/i.test(jarName) ? 'fabric' : /paper/i.test(jarName) ? 'paper' : /^(?:server|minecraft)[-_.]/i.test(jarName) || /^server\.jar$/i.test(jarName) ? 'vanilla' : 'unknown'
  const version = jarName.match(/(?:^|[-_])((?:1\.)?\d{1,2}(?:\.\d{1,2}){0,2})(?=[-_.])/i)?.[1] ?? null
  const match = version?.match(/^(?:1\.)?(\d{1,2})(?:\.(\d{1,2}))?/) ?? null
  const major = match?.[1] ? Number(match[1]) : null
  const minor = match?.[2] ? Number(match[2]) : null
  const requiredJavaMajor = major === null ? null : major > 21 ? 21 : major >= 21 || major === 20 && (minor ?? 0) >= 5 ? 21 : major >= 18 || major === 20 ? 17 : major === 17 ? 16 : 8
  return { jarName, software, version, requiredJavaMajor }
}
function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('The ZIP parser did not open the archive.'))
      else resolveZip(zip)
    })
  })
}
function collectEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolveEntries, reject) => {
    const entries: Entry[] = []
    zip.once('error', reject)
    zip.once('end', () => resolveEntries(entries))
    zip.on('entry', (entry: Entry) => {
      entries.push(entry)
      if (entries.length > MAX_ARCHIVE_ENTRIES) {
        zip.close()
        reject(new ServerZipImportError('ZIP_ENTRY_LIMIT', `The archive exceeds the ${MAX_ARCHIVE_ENTRIES.toLocaleString()} entry limit.`))
        return
      }
      zip.readEntry()
    })
    zip.readEntry()
  })
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
async function readEntryText(path: string, archiveName: string, maximum: number): Promise<string | null> {
  const zip = await openZip(path)
  try {
    const entries = await collectEntries(zip)
    const entry = entries.find((candidate) => candidate.fileName === archiveName)
    if (!entry) return null
    if (entry.uncompressedSize > maximum) throw new ServerZipImportError('ZIP_METADATA_TOO_LARGE', 'The archive properties file exceeds the 64 KiB preview limit.')
    const stream = await new Promise<Readable>((resolveStream, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolveStream(value)))
    const contents = await new Promise<Buffer>((resolveContents, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > maximum) {
          stream.destroy(new ServerZipImportError('ZIP_METADATA_TOO_LARGE', 'The archive properties file exceeds the 64 KiB preview limit.'))
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      stream.once('error', reject)
      stream.once('end', () => resolveContents(Buffer.concat(chunks)))
    })
    return contents.toString('utf8')
  } finally { zip.close() }
}
function parseStored(row: ZipImportRow): StoredImport {
  try {
    const parsed: unknown = JSON.parse(row.previewJson)
    if (typeof parsed === 'object' && parsed !== null && 'preview' in parsed && 'archiveSha256' in parsed) return parsed as StoredImport
  } catch { /* report malformed staging records below */ }
  throw new ServerZipImportError('ZIP_IMPORT_JOURNAL_INVALID', 'The staged import record is invalid. Upload the archive again.')
}
function remainingDiskBytes(value: Awaited<ReturnType<typeof statfs>>): number {
  return Number(value.bavail) * Number(value.bsize)
}

export class ServerZipImportError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class ServerZipImportService {
  readonly importRoot: string

  constructor(
    private readonly db: AppDatabase,
    private readonly servers: ServerRegistry,
    private readonly javaRuntimes: JavaRuntimeRegistry,
    private readonly now: () => number = Date.now,
  ) {
    this.importRoot = join(servers.dataDirectory, 'server-import-staging')
  }

  async prepare(): Promise<void> {
    await mkdir(this.importRoot, { recursive: true, mode: 0o700 })
    await chmod(this.importRoot, 0o700)
    const [importRoot, managedRoot] = await Promise.all([realpath(this.importRoot), realpath(this.servers.managedRoot)])
    const importStat = await lstat(importRoot)
    if (!importStat.isDirectory() || importStat.isSymbolicLink() || inside(managedRoot, importRoot) || inside(importRoot, managedRoot)) {
      throw new ServerZipImportError('ZIP_STAGING_UNSAFE', 'The private upload staging directory must be outside the managed server root.')
    }
    const rows = this.db.select().from(serverZipImports).where(eq(serverZipImports.state, 'ready')).all()
    for (const row of rows) {
      if (Date.parse(row.expiresAt) > this.now()) continue
      await this.removeArchive(row.id)
      this.db.update(serverZipImports).set({ state: 'expired' }).where(eq(serverZipImports.id, row.id)).run()
    }
    for (const row of this.db.select().from(serverZipImports).where(eq(serverZipImports.state, 'importing')).all()) {
      await this.recoverPublishing(row)
    }
    for (const entry of await readdir(this.importRoot, { withFileTypes: true })) {
      if (!/^[0-9a-f-]{36}\.upload$/.test(entry.name)) continue
      const file = join(this.importRoot, entry.name)
      const stat = await lstat(file)
      if (stat.isFile() && !stat.isSymbolicLink()) await unlink(file)
    }
  }

  async stage(uploadName: string, stream: Readable, truncated: () => boolean, actorUserId: string): Promise<ServerZipImportPreview> {
    const safeName = safeBasename(uploadName)
    if (!safeName || !safeName.toLowerCase().endsWith('.zip')) throw new ServerZipImportError('ZIP_FILE_REQUIRED', 'Choose a ZIP archive file.')
    const id = randomUUID()
    const temporaryPath = join(this.importRoot, `${id}.upload`)
    const zipPath = join(this.importRoot, `${id}.zip`)
    const hash = createHash('sha256')
    let received = 0
    let checkedAt = 0
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.byteLength
        if (received > MAX_SERVER_ZIP_BYTES) { callback(new ServerZipImportError('ZIP_COMPRESSED_LIMIT', 'The compressed archive exceeds the 128 MiB upload limit.')); return }
        hash.update(chunk)
        if (received - checkedAt < 8 * 1024 * 1024) { callback(null, chunk); return }
        checkedAt = received
        void statfs(this.importRoot).then((space) => {
          if (remainingDiskBytes(space) < 4 * 1024 * 1024) callback(new ServerZipImportError('ZIP_DISK_SPACE_LOW', 'There is not enough free space to safely stage this archive.'))
          else callback(null, chunk)
        }, callback)
      },
    })
    try {
      const available = await statfs(this.importRoot)
      if (remainingDiskBytes(available) < 4 * 1024 * 1024) throw new ServerZipImportError('ZIP_DISK_SPACE_LOW', 'There is not enough free space to stage this archive.')
      await pipeline(stream, limiter, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }))
      if (truncated()) throw new ServerZipImportError('ZIP_COMPRESSED_LIMIT', 'The compressed archive exceeds the 128 MiB upload limit.')
      if (received < 22) throw new ServerZipImportError('ZIP_INVALID', 'The selected file is not a valid ZIP archive.')
      await rename(temporaryPath, zipPath)
      const inspected = await this.inspect(zipPath)
      const preview: ServerZipImportPreview = {
        token: id,
        uploadName: safeName,
        compressedBytes: received,
        ...inspected.preview,
      }
      const atMs = this.now()
      const stored: StoredImport = { preview, archiveSha256: hash.digest('hex') }
      this.db.insert(serverZipImports).values({
        id, actorUserId, uploadName: safeName, compressedBytes: received, previewJson: JSON.stringify(stored),
        state: 'ready', serverId: null, errorCode: null,
        createdAt: new Date(atMs).toISOString(), expiresAt: new Date(atMs + IMPORT_TTL_MS).toISOString(),
      }).run()
      return preview
    } catch (error) {
      await this.removeOwnedPath(temporaryPath).catch(() => undefined)
      await this.removeOwnedPath(zipPath).catch(() => undefined)
      if (error instanceof ServerZipImportError) throw error
      throw new ServerZipImportError('ZIP_INVALID', 'The ZIP archive could not be read safely. Choose a complete, supported ZIP file.')
    }
  }

  async getPreview(token: string, actorUserId: string): Promise<ServerZipImportPreview> {
    const row = this.db.select().from(serverZipImports).where(and(eq(serverZipImports.id, token), eq(serverZipImports.actorUserId, actorUserId))).get()
    if (!row) throw new ServerZipImportError('ZIP_IMPORT_NOT_FOUND', 'The staged ZIP import was not found.')
    if (row.state !== 'ready') throw new ServerZipImportError('ZIP_IMPORT_NOT_READY', 'This ZIP import is no longer ready to publish.')
    if (Date.parse(row.expiresAt) <= this.now()) {
      await this.removeArchive(row.id)
      this.db.update(serverZipImports).set({ state: 'expired' }).where(eq(serverZipImports.id, row.id)).run()
      throw new ServerZipImportError('ZIP_IMPORT_EXPIRED', 'The staged ZIP expired. Upload it again to continue.')
    }
    return parseStored(row).preview
  }

  async publish(input: { token: string; name: string; javaPath: string; minMemoryMb: number; maxMemoryMb: number; acceptEula: boolean; trustExecutable: true }, actorUserId: string) {
    const row = this.db.select().from(serverZipImports).where(and(eq(serverZipImports.id, input.token), eq(serverZipImports.actorUserId, actorUserId))).get()
    if (!row || row.state !== 'ready') throw new ServerZipImportError('ZIP_IMPORT_NOT_READY', 'The staged ZIP import is missing or has already been used.')
    if (Date.parse(row.expiresAt) <= this.now()) throw new ServerZipImportError('ZIP_IMPORT_EXPIRED', 'The staged ZIP expired. Upload it again to continue.')
    const staged = parseStored(row)
    const preview = staged.preview
    if (!preview.supported || !preview.jarName || preview.software === 'unknown') throw new ServerZipImportError('ZIP_LOADER_UNSUPPORTED', preview.unsupportedReason ?? 'This archive does not contain a supported server loader JAR.')
    if (!input.trustExecutable) throw new ServerZipImportError('ZIP_TRUST_REQUIRED', 'Confirm that you trust the server JAR and mods before importing them.')
    const runtime = this.javaRuntimes.list().find((candidate) => candidate.path === input.javaPath)
    if (!runtime) throw new ServerZipImportError('JAVA_RUNTIME_REQUIRED', 'Choose a Java runtime discovered by MMSManager before importing this server.')
    if (preview.requiredJavaMajor !== null && runtime.major < preview.requiredJavaMajor) {
      throw new ServerZipImportError('JAVA_RUNTIME_INCOMPATIBLE', `This server requires Java ${preview.requiredJavaMajor} or newer. Choose a compatible installed runtime.`)
    }
    const zipPath = join(this.importRoot, `${row.id}.zip`)
    const zipStat = await lstat(zipPath).catch((error: unknown) => isFsError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!zipStat?.isFile() || zipStat.isSymbolicLink() || zipStat.size !== row.compressedBytes || await hashFile(zipPath) !== staged.archiveSha256) {
      throw new ServerZipImportError('ZIP_ARCHIVE_CHANGED', 'The staged archive changed after preview. Upload it again before importing.')
    }
    const options: ZipPublishOptions = {
      name: input.name.trim(), javaPath: runtime.path, javaMajor: runtime.major,
      minMemoryMb: input.minMemoryMb, maxMemoryMb: input.maxMemoryMb, acceptEula: input.acceptEula, trustExecutable: true,
    }
    this.db.update(serverZipImports).set({ state: 'importing', previewJson: JSON.stringify({ ...staged, options }), errorCode: null }).where(eq(serverZipImports.id, row.id)).run()
    try {
      const finalPath = await this.publishFiles(row.id, zipPath)
      return await this.persistImportedServer(row.id, actorUserId, finalPath, preview, options)
    } catch (error) {
      const finalPath = join(this.servers.managedRoot, `zip-${row.id}`)
      const finalStat = await lstat(finalPath).catch((statError: unknown) => isFsError(statError) && statError.code === 'ENOENT' ? null : Promise.reject(statError))
      if (finalStat?.isDirectory() && !finalStat.isSymbolicLink()) {
        const recovered = await this.recoverPublishing(this.db.select().from(serverZipImports).where(eq(serverZipImports.id, row.id)).get()!)
        if (recovered) return recovered
      } else {
        await this.cleanupPublishStaging(row.id).catch(() => undefined)
        this.db.update(serverZipImports).set({ state: 'ready', previewJson: JSON.stringify(staged), errorCode: error instanceof ServerZipImportError ? error.code : 'IMPORT_FAILED' }).where(eq(serverZipImports.id, row.id)).run()
      }
      if (error instanceof ServerZipImportError) throw error
      throw new ServerZipImportError('ZIP_IMPORT_FAILED', 'The archive could not be published. The original staged upload remains available for retry.')
    }
  }

  private async inspect(path: string): Promise<ArchiveInspection> {
    const zip = await openZip(path)
    let sourceEntries: Entry[]
    try { sourceEntries = await collectEntries(zip) }
    finally { zip.close() }
    if (!sourceEntries.length) throw new ServerZipImportError('ZIP_EMPTY', 'The archive is empty.')
    const names = new Map<string, { name: string; directory: boolean }>()
    const entries: ArchiveRecord[] = []
    let expandedBytes = 0
    let excludedCount = 0
    for (const entry of sourceEntries) {
      const directory = entry.fileName.endsWith('/')
      const name = advertisedPath(entry.fileName, directory)
      const comparison = name.normalize('NFC').toLocaleLowerCase('en-US')
      if (names.has(comparison)) throw new ServerZipImportError('ZIP_NAME_COLLISION', 'The archive has duplicate or case/Unicode-colliding paths.')
      names.set(comparison, { name, directory })
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000
      const hostSystem = (entry.versionMadeBy >>> 8) & 0xff
      if (entry.isEncrypted() || (entry.generalPurposeBitFlag & (1 | (1 << 5) | (1 << 6))) !== 0) {
        throw new ServerZipImportError('ZIP_ENCRYPTED', 'Encrypted or patched ZIP entries are not supported.')
      }
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new ServerZipImportError('ZIP_COMPRESSION_UNSUPPORTED', 'The archive uses an unsupported compression method.')
      if (hostSystem === 3 && mode !== 0 && mode !== (directory ? 0x4000 : 0x8000)) {
        throw new ServerZipImportError('ZIP_LINK_OR_SPECIAL_ENTRY', 'The archive contains a symbolic link or special filesystem entry.')
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || !Number.isSafeInteger(entry.compressedSize) || entry.uncompressedSize < 0 || entry.compressedSize < 0 || entry.uncompressedSize > MAX_ENTRY_BYTES) {
        throw new ServerZipImportError('ZIP_ENTRY_LIMIT', 'An archive entry exceeds the 512 MiB per-file limit.')
      }
      if (!directory && entry.uncompressedSize > 0 && (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > MAX_ARCHIVE_RATIO)) {
        throw new ServerZipImportError('ZIP_RATIO_LIMIT', 'The archive has a file with an unsafe compression ratio.')
      }
      expandedBytes += entry.uncompressedSize
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) throw new ServerZipImportError('ZIP_EXPANDED_LIMIT', 'The expanded archive exceeds the 2 GiB import limit.')
      entries.push({ entry, originalName: entry.fileName, relativeName: name, directory, size: entry.uncompressedSize, compressedSize: entry.compressedSize, excluded: IGNORED_NAMES.test(name) })
      if (IGNORED_NAMES.test(name)) excludedCount += 1
    }
    for (const entry of entries) {
      const parts = entry.relativeName.split('/')
      for (let index = 1; index < parts.length; index += 1) {
        const parent = parts.slice(0, index).join('/').normalize('NFC').toLocaleLowerCase('en-US')
        if (names.get(parent)?.directory === false) throw new ServerZipImportError('ZIP_NAME_COLLISION', 'A file path is also used as a parent folder in this archive.')
      }
    }
    const visible = entries.filter((entry) => !entry.excluded)
    const rootNames = new Set(visible.map((entry) => entry.relativeName.split('/')[0]!))
    const hasRootFile = visible.some((entry) => !entry.directory && !entry.relativeName.includes('/'))
    const rootFolder = !hasRootFile && rootNames.size === 1 ? [...rootNames][0]! : null
    for (const entry of entries) entry.relativeName = rootFolder
      ? entry.relativeName === rootFolder ? '' : entry.relativeName.startsWith(`${rootFolder}/`) ? entry.relativeName.slice(rootFolder.length + 1) : entry.relativeName
      : entry.relativeName
    const files = visible.filter((entry) => !entry.directory && entry.relativeName)
    const jar = detectJar(files.map((entry) => entry.relativeName))
    const property = entries.find((entry) => !entry.directory && !entry.excluded && entry.relativeName === 'server.properties')
    const eula = entries.find((entry) => !entry.directory && !entry.excluded && entry.relativeName === 'eula.txt')
    const propertyText = property ? await readEntryText(path, property.originalName, MAX_METADATA_BYTES) : null
    const eulaText = eula ? await readEntryText(path, eula.originalName, 8_192) : null
    const worldFolders = [...new Set(visible.map((entry) => entry.relativeName.split('/')[0]!).filter((name) => ['world', 'world_nether', 'world_the_end'].includes(name)))].sort()
    const supported = jar.software !== 'unknown' && jar.jarName !== null
    const excludedPaths = entries.filter((entry) => entry.excluded).slice(0, 50).map((entry) => entry.relativeName || entry.originalName)
    const warnings = [
      'This archive can contain server JARs and mods. Import only files you trust; MMSManager will not execute them during import.',
      ...(jar.software === 'unknown' ? ['The server loader could not be identified. This archive cannot be launched as a managed server.'] : []),
      ...(excludedCount > excludedPaths.length ? [`${excludedCount - excludedPaths.length} additional macOS metadata entries will be excluded.`] : []),
    ]
    return {
      entries,
      preview: {
        extractedBytes: expandedBytes,
        entryCount: entries.length,
        fileCount: entries.filter((entry) => !entry.directory && !entry.excluded).length,
        rootFolder,
        ...jar,
        port: parsePort(propertyText),
        eula: parseEula(eulaText),
        worldFolders,
        supported,
        unsupportedReason: supported ? null : 'A supported vanilla, Fabric, or Paper server JAR was not found at the archive root.',
        excludedPaths,
        excludedPathsTruncated: excludedCount > excludedPaths.length,
        warnings,
      },
    }
  }

  private async publishFiles(id: string, zipPath: string): Promise<string> {
    const extraction = join(this.importRoot, `${id}.extract`)
    const partial = join(this.servers.managedRoot, `.mmsmanager-import-${id}.partial`)
    const finalPath = join(this.servers.managedRoot, `zip-${id}`)
    await mkdir(extraction, { recursive: false, mode: 0o700 })
    await this.extract(zipPath, extraction)
    await mkdir(partial, { recursive: false, mode: 0o700 })
    await this.copyTree(extraction, partial)
    const row = this.db.select().from(serverZipImports).where(eq(serverZipImports.id, id)).get()
    if (!row) throw new ServerZipImportError('ZIP_IMPORT_NOT_FOUND', 'The import request disappeared before publication.')
    const stored = parseStored(row)
    const options = stored.options
    if (!options) throw new ServerZipImportError('ZIP_IMPORT_JOURNAL_INVALID', 'The import choices are missing from the journal.')
    const eulaText = `# By changing the setting below to TRUE you indicate your agreement to the Minecraft EULA (https://aka.ms/MinecraftEULA).\neula=${options.acceptEula ? 'true' : 'false'}\n`
    const eulaPath = join(partial, 'eula.txt')
    const eulaHandle = await open(eulaPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { await eulaHandle.writeFile(eulaText, 'utf8') } finally { await eulaHandle.close() }
    await chmod(partial, 0o700)
    const finalExisting = await lstat(finalPath).then(() => true, (error: unknown) => isFsError(error) && error.code === 'ENOENT' ? false : Promise.reject(error))
    if (finalExisting) throw new ServerZipImportError('ZIP_IMPORT_COLLISION', 'The new managed server directory already exists. Nothing was overwritten.')
    await rename(partial, finalPath)
    return finalPath
  }

  private async extract(zipPath: string, destination: string): Promise<void> {
    const inspection = await this.inspect(zipPath)
    const zip = await openZip(zipPath)
    try {
      const source = await collectEntries(zip)
      const records = new Map(inspection.entries.map((record) => [record.originalName, record]))
      const disk = await statfs(destination)
      if (remainingDiskBytes(disk) < inspection.preview.extractedBytes + 16 * 1024 * 1024) throw new ServerZipImportError('ZIP_DISK_SPACE_LOW', 'There is not enough free space to expand this archive safely.')
      for (const entry of source) {
        const record = records.get(entry.fileName)
        if (!record || record.excluded) continue
        const normalized = record.relativeName
        if (!normalized) continue
        const target = join(destination, ...normalized.split('/'))
        if (!inside(destination, target)) throw new ServerZipImportError('ZIP_PATH_REJECTED', 'An archive path escaped its private staging folder.')
        await this.ensureDirectory(dirname(target), destination)
        if (record.directory) {
          await mkdir(target, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
            if (!isFsError(error) || error.code !== 'EEXIST') throw error
          })
          const dirStat = await lstat(target)
          if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new ServerZipImportError('ZIP_PATH_COLLISION', 'The archive has a file and folder with the same path.')
          continue
        }
        const stream = await new Promise<Readable>((resolveStream, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolveStream(value)))
        const output = createWriteStream(target, { flags: 'wx', mode: 0o600 })
        await pipeline(stream, output)
        const written = await lstat(target)
        if (!written.isFile() || written.isSymbolicLink() || written.size !== record.size) throw new ServerZipImportError('ZIP_ENTRY_INVALID', 'An extracted archive entry did not match its declared size.')
      }
    } finally { zip.close() }
  }

  private async ensureDirectory(path: string, root: string): Promise<void> {
    const canonicalRoot = resolve(root)
    const candidate = resolve(path)
    if (candidate !== canonicalRoot && !inside(canonicalRoot, candidate)) throw new ServerZipImportError('ZIP_PATH_REJECTED', 'An archive folder escaped its private staging directory.')
    if (candidate === canonicalRoot) return
    const parent = dirname(candidate)
    await this.ensureDirectory(parent, canonicalRoot)
    await mkdir(candidate, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
      if (!isFsError(error) || error.code !== 'EEXIST') throw error
    })
    const stat = await lstat(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServerZipImportError('ZIP_PATH_COLLISION', 'An archive path collides with a non-directory entry.')
  }

  private async copyTree(source: string, destination: string): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name)
      const to = join(destination, entry.name)
      const stat = await lstat(from)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new ServerZipImportError('ZIP_STAGING_UNSAFE', 'A staged archive entry changed to a special file before publication.')
      if (stat.isDirectory()) {
        await mkdir(to, { recursive: false, mode: 0o700 })
        await this.copyTree(from, to)
      } else {
        await copyFile(from, to, constants.COPYFILE_EXCL)
        await chmod(to, 0o600)
      }
    }
  }

  private async persistImportedServer(token: string, actorUserId: string | null, directory: string, preview: ServerZipImportPreview, options: ZipPublishOptions): Promise<LocalServerSummary> {
    const row = this.db.select().from(serverZipImports).where(eq(serverZipImports.id, token)).get()
    if (!row) throw new ServerZipImportError('ZIP_IMPORT_NOT_FOUND', 'The import journal was not found after publication.')
    const stored = parseStored(row)
    const at = new Date(this.now()).toISOString()
    const serverId = randomUUID()
    this.db.transaction((tx) => {
      tx.insert(localServers).values({
        id: serverId, name: options.name, directory, source: 'created', software: preview.software as 'vanilla' | 'fabric' | 'paper',
        version: preview.version, jarName: preview.jarName, javaPath: options.javaPath, javaMajor: options.javaMajor, javaSelectionMode: 'auto',
        requiredJavaMajor: preview.requiredJavaMajor, minMemoryMb: options.minMemoryMb, maxMemoryMb: options.maxMemoryMb,
        port: preview.port, eula: options.acceptEula ? 'accepted' : 'not-accepted', managed: true,
        worldFolders: JSON.stringify(preview.worldFolders), createdBy: actorUserId, createdAt: at, updatedAt: at, removedAt: null,
      }).run()
      tx.insert(localServerEvents).values({
        serverId, actorUserId, action: 'server-zip-imported', outcome: 'success', occurredAt: at,
        detail: JSON.stringify({ uploadName: preview.uploadName, archiveSha256: stored.archiveSha256, trustedExecutable: options.trustExecutable, eulaAccepted: options.acceptEula, expandedBytes: preview.extractedBytes }),
      }).run()
      tx.update(serverZipImports).set({ state: 'published', serverId, errorCode: null }).where(eq(serverZipImports.id, token)).run()
    })
    await this.removeArchive(token)
    await this.cleanupPublishStaging(token)
    return (await this.servers.listPublic()).find((server) => server.id === serverId)!
  }

  private async recoverPublishing(row: ZipImportRow): Promise<LocalServerSummary | null> {
    const staged = parseStored(row)
    const preview = staged.preview
    const finalPath = join(this.servers.managedRoot, `zip-${row.id}`)
    const finalStat = await lstat(finalPath).catch((error: unknown) => isFsError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
    if (finalStat?.isDirectory() && !finalStat.isSymbolicLink()) {
      if (!staged.options || !preview.supported) throw new ServerZipImportError('ZIP_IMPORT_JOURNAL_INVALID', 'The published server folder has no trusted import options in its journal.')
      const existing = this.db.select().from(localServers).where(and(eq(localServers.directory, finalPath), isNull(localServers.removedAt))).get()
      const server = existing ? (await this.servers.listPublic()).find((candidate) => candidate.id === existing.id)! : await this.persistImportedServer(row.id, row.actorUserId ?? '', finalPath, preview, staged.options)
      return server
    }
    await this.cleanupPublishStaging(row.id)
    const archive = await lstat(join(this.importRoot, `${row.id}.zip`)).catch((error: unknown) => isFsError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
    if (archive?.isFile() && Date.parse(row.expiresAt) > this.now()) {
      this.db.update(serverZipImports).set({ state: 'ready', previewJson: JSON.stringify({ preview, archiveSha256: staged.archiveSha256 }) }).where(eq(serverZipImports.id, row.id)).run()
      return null
    }
    this.db.update(serverZipImports).set({ state: 'failed', errorCode: 'ZIP_IMPORT_INTERRUPTED' }).where(eq(serverZipImports.id, row.id)).run()
    return null
  }

  private async cleanupPublishStaging(id: string): Promise<void> {
    const extraction = join(this.importRoot, `${id}.extract`)
    const partial = join(this.servers.managedRoot, `.mmsmanager-import-${id}.partial`)
    await this.removeOwnedPath(extraction)
    await this.removeOwnedPath(partial)
  }

  private async removeArchive(id: string): Promise<void> {
    await this.removeOwnedPath(join(this.importRoot, `${id}.zip`))
    await this.removeOwnedPath(join(this.importRoot, `${id}.upload`))
  }

  private async removeOwnedPath(path: string): Promise<void> {
    const stat = await lstat(path).catch((error: unknown) => isFsError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) return
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new ServerZipImportError('ZIP_STAGING_UNSAFE', 'A staging entry changed to an unsafe filesystem object and was preserved.')
    if (stat.isFile()) { await unlink(path); return }
    for (const name of await readdir(path)) await this.removeOwnedPath(join(path, name))
    await rm(path, { recursive: false })
  }
}
