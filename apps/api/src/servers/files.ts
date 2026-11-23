import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { desc, eq, isNull, and } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerEvents, localServerFileRecoveries, localServerFileTrash, localServerRuntime, localServers } from '../db/schema.js'
import type { ServerFileEntry, ServerFileList, ServerFileRead, ServerFileRecovery, ServerFileTrash } from '@mmsmanager/shared'
import type { ServerRegistry } from './registry.js'
import type { ServerProcessManager } from './processes.js'

export const MAX_SERVER_FILE_UPLOAD_BYTES = 16 * 1024 * 1024
export const MAX_SERVER_FILE_DOWNLOAD_BYTES = 16 * 1024 * 1024
export const MAX_SERVER_FILE_TEXT_BYTES = 512 * 1024
const MAX_DIRECTORY_ENTRIES = 500
const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.md', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv', '.cfg', '.ini', '.conf'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.exe', '.dll', '.so', '.dylib', '.jar', '.class', '.py', '.js', '.ts', '.mjs', '.cjs'])
const WORLD_NAMES = new Set(['world', 'world_nether', 'world_the_end'])

export class ServerFilesError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function fsError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function containsPathControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}
function containsDisallowedTextControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
  })
}
function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function safeParts(path: string, allowRoot = false): string[] {
  if (typeof path !== 'string' || path.length > 2048 || path.includes('\\') || path.includes('\0') || path.startsWith('/')) {
    throw new ServerFilesError('FILE_PATH_REJECTED', 'Use a relative path inside this managed server.')
  }
  if (!path && allowRoot) return []
  const parts = path.split('/')
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.length > 255 || part.includes(':') || containsPathControl(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new ServerFilesError('FILE_PATH_REJECTED', 'The server-relative path contains an invalid segment.')
  }
  if (parts.some((part) => part.toLowerCase() === '.mmsmanager')) {
    throw new ServerFilesError('FILE_PATH_PROTECTED', 'MMSManager private operation files are not exposed in the file browser.')
  }
  return parts
}
function protectedReason(parts: string[], worldFolders: ReadonlySet<string> = WORLD_NAMES): string | null {
  const lower = parts.map((part) => part.toLowerCase())
  const name = lower.at(-1) ?? ''
  if (lower.some((part) => part === 'mods' || part === 'plugins')) return 'Use the Mods page to manage loader artifacts.'
  if (lower.some((part) => worldFolders.has(part))) return 'World data is protected until the world backup workflow is available.'
  if (name === 'server.properties') return 'Use the typed Properties editor for this configuration file.'
  if (name === 'server.jar' || SCRIPT_EXTENSIONS.has(extname(name))) return 'Executable server assets are protected from file-manager changes.'
  if (name === 'eula.txt') return 'EULA state is controlled by the installation flow.'
  if (['ops.json', 'whitelist.json', 'usercache.json', 'banned-ips.json', 'banned-players.json'].includes(name)) return 'Access-control and player identity files are protected.'
  if (name === '.env' || /(?:password|secret|credential|token|private[._-]?key)/i.test(name) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name)) return 'Files that may contain credentials are protected.'
  return null
}
function entryState(parts: string[], stat: Awaited<ReturnType<typeof lstat>>, isDirectory: boolean, worldFolders: ReadonlySet<string>): Pick<ServerFileEntry, 'contentState' | 'reason' | 'canDownload' | 'canEdit' | 'canRename' | 'canTrash'> {
  const reason = protectedReason(parts, worldFolders)
  const hardlinked = !isDirectory && stat.nlink > 1
  if (stat.isSymbolicLink() || (!stat.isFile() && !isDirectory) || hardlinked) return { contentState: 'unsafe', reason: hardlinked ? 'Hard-linked files are not opened or changed.' : 'Symbolic links and special files are not followed.', canDownload: false, canEdit: false, canRename: false, canTrash: false }
  if (reason) return { contentState: 'protected', reason, canDownload: false, canEdit: false, canRename: false, canTrash: false }
  if (isDirectory) return { contentState: 'read-only', reason: null, canDownload: false, canEdit: false, canRename: true, canTrash: true }
  const ext = extname(parts.at(-1) ?? '').toLowerCase()
  const editable = TEXT_EXTENSIONS.has(ext) && stat.size <= MAX_SERVER_FILE_TEXT_BYTES
  const oversized = TEXT_EXTENSIONS.has(ext) && stat.size > MAX_SERVER_FILE_TEXT_BYTES
  return {
    contentState: oversized ? 'oversized' : editable ? 'editable' : 'read-only',
    reason: oversized ? 'Text editing is limited to files up to 512 KiB.' : editable ? null : 'This file type is available as a bounded download only.',
    canDownload: stat.size <= MAX_SERVER_FILE_DOWNLOAD_BYTES,
    canEdit: editable,
    canRename: true,
    canTrash: true,
  }
}

type SafeFile = { absolute: string; stat: Awaited<ReturnType<typeof lstat>>; bytes?: Buffer }

export class ServerFileService {
  private readonly recoveryRoot: string
  private readonly mutations = new Set<string>()

  constructor(private readonly db: AppDatabase, private readonly servers: ServerRegistry, private readonly processes: ServerProcessManager, private readonly now: () => number = Date.now) {
    this.recoveryRoot = join(servers.dataDirectory, 'server-file-recoveries')
  }

  async list(serverId: string, path = ''): Promise<ServerFileList> {
    const root = await this.serverRoot(serverId)
    const parts = safeParts(path, true)
    const worldFolders = this.worldFolders(serverId)
    const directory = await this.resolveExisting(root, parts, 'directory')
    const handles = await readdir(directory.absolute, { withFileTypes: true })
    const visible = handles.filter((entry) => entry.name.toLowerCase() !== '.mmsmanager' && !/^\.mms-file-[0-9a-f-]+\.tmp$/i.test(entry.name))
    const items: ServerFileEntry[] = []
    for (const entry of visible.slice(0, MAX_DIRECTORY_ENTRIES)) {
      let stat: Awaited<ReturnType<typeof lstat>>
      try { stat = await lstat(join(directory.absolute, entry.name)) } catch { continue }
      const childParts = [...parts, entry.name]
      const isDirectory = stat.isDirectory() && !stat.isSymbolicLink()
      const state = entryState(childParts, stat, isDirectory, worldFolders)
      const kind: ServerFileEntry['kind'] = stat.isSymbolicLink() ? 'symlink' : isDirectory ? 'folder' : stat.isFile() ? 'file' : 'unsupported'
      items.push({
        name: entry.name,
        path: childParts.join('/'),
        kind,
        sizeBytes: stat.isFile() && !stat.isSymbolicLink() ? Number(stat.size) : null,
        modifiedAt: stat.isSymbolicLink() ? null : stat.mtime.toISOString(),
        ...state,
      })
    }
    items.sort((left, right) => Number(right.kind === 'folder') - Number(left.kind === 'folder') || left.name.localeCompare(right.name))
    const breadcrumbs: ServerFileList['breadcrumbs'] = []
    let built = ''
    for (const name of parts) {
      built = built ? `${built}/${name}` : name
      breadcrumbs.push({ name, path: built })
    }
    const trashCount = this.db.select({ id: localServerFileTrash.id }).from(localServerFileTrash)
      .where(and(eq(localServerFileTrash.serverId, serverId), isNull(localServerFileTrash.restoredAt))).all().length
    return { serverId, path: parts.join('/'), breadcrumbs, entries: items, truncated: visible.length > MAX_DIRECTORY_ENTRIES, trashCount }
  }

  async read(serverId: string, path: string): Promise<ServerFileRead> {
    const root = await this.serverRoot(serverId)
    const parts = safeParts(path)
    const reason = this.protectedReason(serverId, parts)
    if (reason) {
      const protectedFile = await this.resolveExisting(root, parts, 'file')
      return { path: parts.join('/'), sizeBytes: Number(protectedFile.stat.size), modifiedAt: protectedFile.stat.mtime.toISOString(), sha256: null, text: null, contentState: 'protected', reason }
    }
    const file = await this.openRegular(root, parts, MAX_SERVER_FILE_TEXT_BYTES)
    const base = { path: parts.join('/'), sizeBytes: Number(file.stat.size), modifiedAt: file.stat.mtime.toISOString() }
    if (!TEXT_EXTENSIONS.has(extname(parts.at(-1) ?? '').toLowerCase())) return { ...base, sha256: null, text: null, contentState: 'read-only', reason: 'This file type is available as a bounded download only.' }
    if (file.stat.size > MAX_SERVER_FILE_TEXT_BYTES) return { ...base, sha256: null, text: null, contentState: 'oversized', reason: 'Text editing is limited to files up to 512 KiB.' }
    const bytes = file.bytes!
    const decoded = decodeText(bytes)
    if (decoded === null) return { ...base, sha256: null, text: null, contentState: 'binary', reason: 'This file does not contain valid UTF-8 text.' }
    return { ...base, sha256: sha256(bytes), text: decoded, contentState: 'editable', reason: null }
  }

  async download(serverId: string, path: string): Promise<{ name: string; bytes: Buffer }> {
    const root = await this.serverRoot(serverId)
    const parts = safeParts(path)
    const reason = this.protectedReason(serverId, parts)
    if (reason) throw new ServerFilesError('FILE_PROTECTED', reason)
    const file = await this.openRegular(root, parts, MAX_SERVER_FILE_DOWNLOAD_BYTES)
    if (file.stat.size > MAX_SERVER_FILE_DOWNLOAD_BYTES) throw new ServerFilesError('FILE_TOO_LARGE', 'Downloads are limited to 16 MiB per file.')
    return { name: parts.at(-1)!, bytes: file.bytes! }
  }

  async upload(serverId: string, actorUserId: string, directoryPath: string, name: string, stream: AsyncIterable<Buffer | string>, truncated: () => boolean): Promise<ServerFileList> {
    return this.withMutation(serverId, async () => {
      const root = await this.serverRoot(serverId)
      const directoryParts = safeParts(directoryPath, true)
      const nameParts = safeParts(name)
      if (nameParts.length !== 1) throw new ServerFilesError('FILE_NAME_REJECTED', 'Upload a file with a single safe filename.')
      const fileName = nameParts[0]!
      const extension = extname(fileName).toLowerCase()
      const reason = this.protectedReason(serverId, [...directoryParts, fileName])
      if (reason) throw new ServerFilesError('FILE_PROTECTED', reason)
      if (!TEXT_EXTENSIONS.has(extension) && !IMAGE_EXTENSIONS.has(extension)) throw new ServerFilesError('FILE_TYPE_REJECTED', 'Uploads support UTF-8 text and common image files only.')
      const directory = await this.resolveExisting(root, directoryParts, 'directory')
      const target = join(directory.absolute, fileName)
      if (await pathExists(target)) throw new ServerFilesError('FILE_ALREADY_EXISTS', 'A file with that name already exists. Rename it or move it first.')
      const temporary = join(directory.absolute, `.mms-file-${randomUUID()}.tmp`)
      const handle = await open(temporary, 'wx', 0o600)
      let total = 0
      const chunks: Buffer[] = []
      let imageHeader = Buffer.alloc(0)
      try {
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          total += chunk.byteLength
          if (total > MAX_SERVER_FILE_UPLOAD_BYTES) throw new ServerFilesError('FILE_TOO_LARGE', 'Uploads are limited to 16 MiB.')
          if (TEXT_EXTENSIONS.has(extension)) chunks.push(chunk)
          else if (imageHeader.byteLength < 16) imageHeader = Buffer.concat([imageHeader, chunk.subarray(0, 16 - imageHeader.byteLength)])
          await handle.write(chunk)
        }
        if (truncated()) throw new ServerFilesError('FILE_TOO_LARGE', 'The upload exceeded its size limit.')
        if (TEXT_EXTENSIONS.has(extension)) {
          const content = Buffer.concat(chunks, total)
          if (content.byteLength > MAX_SERVER_FILE_TEXT_BYTES || decodeText(content) === null) throw new ServerFilesError('FILE_CONTENT_REJECTED', 'Text uploads must be valid UTF-8 and no larger than 512 KiB.')
        } else if (!validImageHeader(extension, imageHeader)) {
          throw new ServerFilesError('FILE_CONTENT_REJECTED', 'The image bytes do not match the selected PNG, JPEG or WebP extension.')
        }
        await handle.sync()
      } catch (error) {
        await handle.close()
        await rm(temporary, { force: true })
        throw error
      }
      await handle.close()
      try {
        await this.assertSameDirectory(root, directoryParts, directory.stat)
        await link(temporary, target)
        await unlink(temporary)
        this.audit(serverId, actorUserId, 'server-file-uploaded', { path: [...directoryParts, fileName].join('/'), sizeBytes: total })
      } catch (error) {
        await rm(temporary, { force: true })
        if (fsError(error) && error.code === 'EEXIST') throw new ServerFilesError('FILE_ALREADY_EXISTS', 'A file with that name already exists.')
        throw error
      }
      return this.list(serverId, directoryParts.join('/'))
    })
  }

  async create(serverId: string, actorUserId: string, path: string, kind: 'file' | 'folder', text = ''): Promise<ServerFileList> {
    return this.withMutation(serverId, async () => {
      const root = await this.serverRoot(serverId)
      const parts = safeParts(path)
      const reason = this.protectedReason(serverId, parts)
      if (reason) throw new ServerFilesError('FILE_PROTECTED', reason)
      const parentParts = parts.slice(0, -1)
      const parent = await this.resolveExisting(root, parentParts, 'directory')
      const target = join(parent.absolute, parts.at(-1)!)
      if (await pathExists(target)) throw new ServerFilesError('FILE_ALREADY_EXISTS', 'A file or folder with that name already exists.')
      await this.assertSameDirectory(root, parentParts, parent.stat)
      if (kind === 'folder') await mkdir(target, { mode: 0o700 })
      else {
        const extension = extname(parts.at(-1)!).toLowerCase()
        if (!TEXT_EXTENSIONS.has(extension)) throw new ServerFilesError('FILE_TYPE_REJECTED', 'New files must use a supported text extension such as .txt, .json or .yml.')
        const bytes = Buffer.from(text, 'utf8')
        if (bytes.byteLength > MAX_SERVER_FILE_TEXT_BYTES || decodeText(bytes) === null) throw new ServerFilesError('FILE_CONTENT_REJECTED', 'New text files must be valid UTF-8 and no larger than 512 KiB.')
        const handle = await open(target, 'wx', 0o600)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      }
      this.audit(serverId, actorUserId, kind === 'folder' ? 'server-folder-created' : 'server-file-created', { path: parts.join('/') })
      return this.list(serverId, parentParts.join('/'))
    })
  }

  async move(serverId: string, actorUserId: string, sourcePath: string, destinationPath: string): Promise<ServerFileList> {
    return this.withMutation(serverId, async () => {
      const root = await this.serverRoot(serverId)
      const sourceParts = safeParts(sourcePath)
      const destinationParts = safeParts(destinationPath)
      if (sourceParts.join('/') === destinationParts.join('/')) throw new ServerFilesError('FILE_PATH_REJECTED', 'Choose a different destination path.')
      for (const parts of [sourceParts, destinationParts]) {
        const reason = this.protectedReason(serverId, parts)
        if (reason) throw new ServerFilesError('FILE_PROTECTED', reason)
      }
      const source = await this.resolveExisting(root, sourceParts, 'any')
      if (source.stat.isSymbolicLink() || (!source.stat.isDirectory() && !source.stat.isFile()) || (source.stat.isFile() && source.stat.nlink > 1)) throw new ServerFilesError('FILE_UNSAFE', 'Symbolic links, special files and hard-linked files cannot be moved.')
      if (source.stat.isDirectory()) await this.assertTreeSafe(root, source.absolute, sourceParts, this.worldFolders(serverId))
      const destinationParentParts = destinationParts.slice(0, -1)
      const destinationParent = await this.resolveExisting(root, destinationParentParts, 'directory')
      const destination = join(destinationParent.absolute, destinationParts.at(-1)!)
      if (await pathExists(destination)) throw new ServerFilesError('FILE_ALREADY_EXISTS', 'The destination already exists. Files are never overwritten.')
      if (source.stat.isDirectory() && destination.startsWith(source.absolute + sep)) throw new ServerFilesError('FILE_PATH_REJECTED', 'A folder cannot be moved into itself.')
      await this.assertSameDirectory(root, destinationParentParts, destinationParent.stat)
      const sourceParent = await this.resolveExisting(root, sourceParts.slice(0, -1), 'directory')
      await this.assertSameDirectory(root, sourceParts.slice(0, -1), sourceParent.stat)
      await this.moveNoReplace(source.absolute, destination, source.stat)
      this.audit(serverId, actorUserId, 'server-file-moved', { from: sourceParts.join('/'), to: destinationParts.join('/') })
      return this.list(serverId, sourceParts.slice(0, -1).join('/'))
    })
  }

  async trash(serverId: string, actorUserId: string, path: string): Promise<{ item: ServerFileTrash; inventory: ServerFileList }> {
    return this.withMutation(serverId, async () => {
      const root = await this.serverRoot(serverId)
      const parts = safeParts(path)
      const reason = this.protectedReason(serverId, parts)
      if (reason) throw new ServerFilesError('FILE_PROTECTED', reason)
      const source = await this.resolveExisting(root, parts, 'any')
      if (source.stat.isSymbolicLink() || (!source.stat.isDirectory() && !source.stat.isFile()) || (source.stat.isFile() && source.stat.nlink > 1)) throw new ServerFilesError('FILE_UNSAFE', 'Symbolic links, special files and hard-linked files cannot be moved to trash.')
      if (source.stat.isDirectory()) await this.assertTreeSafe(root, source.absolute, parts, this.worldFolders(serverId))
      const parentParts = parts.slice(0, -1)
      const parent = await this.resolveExisting(root, parentParts, 'directory')
      const trashId = randomUUID()
      const trashDirectory = await this.ensureTrashDirectory(root)
      const stored = join(trashDirectory, trashId)
      await this.assertSameDirectory(root, parentParts, parent.stat)
      await this.moveNoReplace(source.absolute, stored, source.stat)
      const deletedAt = new Date(this.now()).toISOString()
      const kind = source.stat.isDirectory() ? 'folder' : 'file'
      const sizeBytes = kind === 'file' ? Number(source.stat.size) : null
      try {
        this.db.insert(localServerFileTrash).values({ id: trashId, serverId, actorUserId, name: parts.at(-1)!, originalPath: parts.join('/'), storedName: trashId, kind, sizeBytes, deletedAt, restoredAt: null }).run()
        this.audit(serverId, actorUserId, 'server-file-trashed', { path: parts.join('/'), kind })
      } catch (error) {
        try { await this.moveNoReplace(stored, source.absolute, await lstat(stored)) } catch { throw new ServerFilesError('FILE_ROLLBACK_FAILED', 'The trash ledger failed and the original path could not be restored automatically.') }
        throw error
      }
      return { item: { id: trashId, name: parts.at(-1)!, originalPath: parts.join('/'), kind, sizeBytes, deletedAt }, inventory: await this.list(serverId, parentParts.join('/')) }
    })
  }

  listTrash(serverId: string): ServerFileTrash[] {
    return this.db.select({ id: localServerFileTrash.id, name: localServerFileTrash.name, originalPath: localServerFileTrash.originalPath, kind: localServerFileTrash.kind, sizeBytes: localServerFileTrash.sizeBytes, deletedAt: localServerFileTrash.deletedAt })
      .from(localServerFileTrash).where(and(eq(localServerFileTrash.serverId, serverId), isNull(localServerFileTrash.restoredAt)))
      .orderBy(desc(localServerFileTrash.deletedAt)).limit(500).all()
  }

  async restoreTrash(serverId: string, actorUserId: string, id: string): Promise<ServerFileList> {
    return this.withMutation(serverId, async () => {
      const root = await this.serverRoot(serverId)
      const record = this.db.select().from(localServerFileTrash).where(and(eq(localServerFileTrash.serverId, serverId), eq(localServerFileTrash.id, id), isNull(localServerFileTrash.restoredAt))).get()
      if (!record) throw new ServerFilesError('FILE_TRASH_NOT_FOUND', 'The recoverable file item was not found.')
      const parts = safeParts(record.originalPath)
      const reason = this.protectedReason(serverId, parts)
      if (reason) throw new ServerFilesError('FILE_PROTECTED', `This item is protected and cannot be restored through the file browser: ${reason}`)
      const parentParts = parts.slice(0, -1)
      const parent = await this.resolveExisting(root, parentParts, 'directory')
      const trashDirectory = await this.ensureTrashDirectory(root)
      const stored = join(trashDirectory, record.storedName)
      const storedStat = await lstat(stored).catch(() => null)
      if (!storedStat || storedStat.isSymbolicLink() || (!storedStat.isFile() && !storedStat.isDirectory())) throw new ServerFilesError('FILE_TRASH_UNAVAILABLE', 'The recoverable copy is missing or unsafe.')
      const destination = join(parent.absolute, parts.at(-1)!)
      if (await pathExists(destination)) throw new ServerFilesError('FILE_ALREADY_EXISTS', 'The original path is occupied. Rename or move the current item before restoring.')
      await this.assertSameDirectory(root, parentParts, parent.stat)
      await this.moveNoReplace(stored, destination, storedStat)
      const restoredAt = new Date(this.now()).toISOString()
      try {
        this.db.update(localServerFileTrash).set({ restoredAt }).where(and(eq(localServerFileTrash.id, id), eq(localServerFileTrash.serverId, serverId))).run()
        this.audit(serverId, actorUserId, 'server-file-restored', { path: parts.join('/') })
      } catch (error) {
        try { await this.moveNoReplace(destination, stored, await lstat(destination)) } catch { throw new ServerFilesError('FILE_ROLLBACK_FAILED', 'The restore ledger failed and the item could not be returned to trash automatically.') }
        throw error
      }
      return this.list(serverId, parentParts.join('/'))
    })
  }

  async writeText(serverId: string, actorUserId: string, path: string, text: string, expectedSha256: string): Promise<ServerFileRead> {
    return this.withMutation(serverId, () => this.replaceText(serverId, actorUserId, path, Buffer.from(text, 'utf8'), expectedSha256))
  }

  async listRecoveries(serverId: string, path: string): Promise<ServerFileRecovery[]> {
    const normalized = safeParts(path).join('/')
    await this.serverRoot(serverId)
    return this.db.select({ id: localServerFileRecoveries.id, path: localServerFileRecoveries.originalPath, sizeBytes: localServerFileRecoveries.sizeBytes, sha256: localServerFileRecoveries.sha256, createdAt: localServerFileRecoveries.createdAt })
      .from(localServerFileRecoveries).where(and(eq(localServerFileRecoveries.serverId, serverId), eq(localServerFileRecoveries.originalPath, normalized)))
      .orderBy(desc(localServerFileRecoveries.createdAt)).limit(100).all()
  }

  async restoreRecovery(serverId: string, actorUserId: string, id: string, expectedCurrentSha256: string): Promise<ServerFileRead> {
    return this.withMutation(serverId, async () => {
      await this.serverRoot(serverId)
      const row = this.db.select().from(localServerFileRecoveries).where(and(eq(localServerFileRecoveries.serverId, serverId), eq(localServerFileRecoveries.id, id))).get()
      if (!row) throw new ServerFilesError('FILE_RECOVERY_NOT_FOUND', 'The private recovery copy was not found.')
      if (row.fileName !== `${row.id}.bin`) throw new ServerFilesError('FILE_RECOVERY_UNSAFE', 'The private recovery ledger contains an unsafe filename.')
      const filePath = join(this.recoveryRoot, serverId, row.fileName)
      const backup = await readPrivateFile(filePath, MAX_SERVER_FILE_TEXT_BYTES)
      if (sha256(backup.bytes) !== row.sha256) throw new ServerFilesError('FILE_RECOVERY_CHECKSUM_FAILED', 'The private recovery copy checksum does not match its ledger.')
      return this.replaceText(serverId, actorUserId, row.originalPath, backup.bytes, expectedCurrentSha256)
    })
  }

  private async replaceText(serverId: string, actorUserId: string, path: string, nextBytes: Buffer, expectedSha256: string): Promise<ServerFileRead> {
    const root = await this.serverRoot(serverId)
    const parts = safeParts(path)
    const reason = this.protectedReason(serverId, parts)
    if (reason) throw new ServerFilesError('FILE_PROTECTED', reason)
    if (!TEXT_EXTENSIONS.has(extname(parts.at(-1) ?? '').toLowerCase()) || nextBytes.byteLength > MAX_SERVER_FILE_TEXT_BYTES || decodeText(nextBytes) === null) throw new ServerFilesError('FILE_CONTENT_REJECTED', 'Only valid UTF-8 text files up to 512 KiB can be saved.')
    const current = await this.openRegular(root, parts, MAX_SERVER_FILE_TEXT_BYTES)
    if (current.stat.size > MAX_SERVER_FILE_TEXT_BYTES) throw new ServerFilesError('FILE_TOO_LARGE', 'Text editing is limited to files up to 512 KiB.')
    const oldBytes = current.bytes!
    const currentHash = sha256(oldBytes)
    if (currentHash !== expectedSha256) throw new ServerFilesError('FILE_CONFLICT', 'The file changed since it was opened. Reload it before saving.')
    if (decodeText(oldBytes) === null) throw new ServerFilesError('FILE_BINARY', 'This file does not contain valid UTF-8 text.')
    const recoveryId = randomUUID()
    const createdAt = new Date(this.now()).toISOString()
    const recoveryDirectory = join(this.recoveryRoot, serverId)
    await this.ensurePrivateDirectory(recoveryDirectory, this.recoveryRoot)
    const recoveryFileName = `${recoveryId}.bin`
    await writePrivateFile(join(recoveryDirectory, recoveryFileName), oldBytes)
    this.db.insert(localServerFileRecoveries).values({ id: recoveryId, serverId, actorUserId, originalPath: parts.join('/'), fileName: recoveryFileName, sha256: currentHash, sizeBytes: oldBytes.byteLength, createdAt }).run()
    const newHash = sha256(nextBytes)
    let replacementStarted = false
    try {
      replacementStarted = true
      await this.atomicReplace(root, parts, nextBytes, Number(current.stat.mode) & 0o666, currentHash, current.stat)
      const persisted = await this.openRegular(root, parts, MAX_SERVER_FILE_TEXT_BYTES)
      if (sha256(persisted.bytes!) !== newHash) throw new ServerFilesError('FILE_VERIFY_FAILED', 'The saved text did not match its expected checksum.')
      this.audit(serverId, actorUserId, 'server-file-edited', { path: parts.join('/'), recoveryId, sha256: newHash })
    } catch (error) {
      if (replacementStarted) {
        try {
          const currentFile = await this.openRegular(root, parts, MAX_SERVER_FILE_TEXT_BYTES)
          if (!currentFile.bytes) throw new ServerFilesError('FILE_ROLLBACK_FAILED', 'The file changed to an oversized state during recovery.')
          const currentHashAfterFailure = sha256(currentFile.bytes)
          if (currentHashAfterFailure === newHash) await this.atomicReplace(root, parts, oldBytes, Number(current.stat.mode) & 0o666, newHash, currentFile.stat)
          else if (currentHashAfterFailure !== currentHash) throw new ServerFilesError('FILE_ROLLBACK_FAILED', 'Saving failed after another writer changed the file. The private recovery copy is available.')
        } catch { throw new ServerFilesError('FILE_ROLLBACK_FAILED', 'Saving failed and the original file could not be restored automatically. A private recovery copy is available.') }
      }
      throw error
    }
    return this.read(serverId, parts.join('/'))
  }

  private async atomicReplace(root: string, parts: string[], bytes: Buffer, mode: number, expectedHash: string, expectedStat: Awaited<ReturnType<typeof lstat>>): Promise<void> {
    const existing = await this.resolveExisting(root, parts, 'file')
    if (existing.stat.nlink > 1) throw new ServerFilesError('FILE_UNSAFE', 'Hard-linked files are never replaced.')
    if (existing.stat.dev !== expectedStat.dev || existing.stat.ino !== expectedStat.ino) throw new ServerFilesError('FILE_CONFLICT', 'The file identity changed before it could be saved.')
    const latest = await this.openRegular(root, parts, MAX_SERVER_FILE_TEXT_BYTES)
    if (latest.stat.dev !== expectedStat.dev || latest.stat.ino !== expectedStat.ino || sha256(latest.bytes!) !== expectedHash) throw new ServerFilesError('FILE_CONFLICT', 'The file changed before it could be saved.')
    const parentParts = parts.slice(0, -1)
    const parent = await this.resolveExisting(root, parentParts, 'directory')
    const temporary = join(parent.absolute, `.mms-file-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', (mode & 0o666) || 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    try {
      const finalRead = await this.openRegular(root, parts, MAX_SERVER_FILE_TEXT_BYTES)
      if (!finalRead.bytes || finalRead.stat.dev !== expectedStat.dev || finalRead.stat.ino !== expectedStat.ino || sha256(finalRead.bytes) !== expectedHash) throw new ServerFilesError('FILE_CONFLICT', 'The file changed while the replacement was staged.')
      const before = await lstat(existing.absolute)
      if (!before.isFile() || before.isSymbolicLink() || before.dev !== existing.stat.dev || before.ino !== existing.stat.ino) throw new ServerFilesError('FILE_CONFLICT', 'The file identity changed before it could be saved.')
      await this.assertSameDirectory(root, parentParts, parent.stat)
      await rename(temporary, existing.absolute)
      const directoryHandle = await open(parent.absolute, constants.O_RDONLY)
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    } catch (error) { await rm(temporary, { force: true }); throw error }
  }

  private async openRegular(root: string, parts: string[], maxBytes: number): Promise<SafeFile> {
    const file = await this.resolveExisting(root, parts, 'file')
    if (file.stat.nlink > 1) throw new ServerFilesError('FILE_UNSAFE', 'Hard-linked files are not opened.')
    if (file.stat.size > maxBytes) return { absolute: file.absolute, stat: file.stat }
    let handle
    try { handle = await open(file.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
    catch { throw new ServerFilesError('FILE_UNSAFE', 'The file could not be opened without following links.') }
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== file.stat.dev || opened.ino !== file.stat.ino || opened.nlink > 1) throw new ServerFilesError('FILE_CONFLICT', 'The file changed while it was being opened.')
      if (opened.size > maxBytes) return { absolute: file.absolute, stat: opened }
      const bytes = await handle.readFile()
      if (bytes.byteLength > maxBytes) throw new ServerFilesError('FILE_TOO_LARGE', 'The file exceeded its bounded read limit.')
      return { absolute: file.absolute, stat: opened, bytes }
    } finally { await handle.close() }
  }

  private async resolveExisting(root: string, parts: string[], expected: 'file' | 'directory' | 'any'): Promise<SafeFile> {
    const absolute = join(root, ...parts)
    if (!within(root, absolute)) throw new ServerFilesError('FILE_PATH_REJECTED', 'The path leaves the managed server directory.')
    let current = root
    const rootStat = await lstat(root)
    let stat = rootStat
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServerFilesError('SERVER_DIRECTORY_UNSAFE', 'The managed server directory is unavailable or unsafe.')
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!)
      try { stat = await lstat(current) } catch (error) {
        if (fsError(error) && error.code === 'ENOENT') throw new ServerFilesError('FILE_NOT_FOUND', 'The requested file or folder was not found.')
        throw error
      }
      if (stat.isSymbolicLink()) throw new ServerFilesError('FILE_UNSAFE', 'Symbolic links are not followed by the file manager.')
      if (stat.dev !== rootStat.dev) throw new ServerFilesError('FILE_UNSAFE', 'Mounted folders on another filesystem are not traversed.')
      if (index < parts.length - 1 && !stat.isDirectory()) throw new ServerFilesError('FILE_NOT_DIRECTORY', 'A parent path segment is not a directory.')
    }
    if (expected === 'file' && !stat.isFile()) throw new ServerFilesError('FILE_NOT_REGULAR', 'The requested path is not a regular file.')
    if (expected === 'directory' && !stat.isDirectory()) throw new ServerFilesError('FILE_NOT_DIRECTORY', 'The requested path is not a directory.')
    if (parts.length) {
      const canonicalParent = await realpath(dirname(absolute))
      if (!within(root, canonicalParent)) throw new ServerFilesError('FILE_PATH_REJECTED', 'The path resolves outside the managed server directory.')
    }
    return { absolute, stat }
  }

  private async assertSameDirectory(root: string, parts: string[], originalStat: Awaited<ReturnType<typeof lstat>>): Promise<void> {
    const current = await this.resolveExisting(root, parts, 'directory')
    if (current.stat.dev !== originalStat.dev || current.stat.ino !== originalStat.ino) throw new ServerFilesError('FILE_CONFLICT', 'The parent folder changed during the operation.')
  }

  private async moveNoReplace(source: string, destination: string, expectedSource: Awaited<ReturnType<typeof lstat>>): Promise<void> {
    if (expectedSource.isDirectory()) {
      try { await mkdir(destination, { mode: 0o700 }) }
      catch (error) {
        if (fsError(error) && error.code === 'EEXIST') throw new ServerFilesError('FILE_ALREADY_EXISTS', 'The destination already exists. Files are never overwritten.')
        throw error
      }
      const reservation = await lstat(destination)
      try {
        const current = await lstat(source)
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expectedSource.dev || current.ino !== expectedSource.ino) throw new ServerFilesError('FILE_CONFLICT', 'The source folder changed during the move.')
        const target = await lstat(destination)
        if (!target.isDirectory() || target.dev !== reservation.dev || target.ino !== reservation.ino) throw new ServerFilesError('FILE_CONFLICT', 'The destination changed during the move.')
        await rename(source, destination)
      } catch (error) {
        const target = await lstat(destination).catch(() => null)
        if (target?.dev === reservation.dev && target.ino === reservation.ino) await rm(destination, { recursive: false, force: true })
        throw error
      }
      return
    }
    try {
      const current = await lstat(source)
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== expectedSource.dev || current.ino !== expectedSource.ino || current.nlink > 1) throw new ServerFilesError('FILE_CONFLICT', 'The source file changed during the move.')
      await link(source, destination)
      const moved = await lstat(destination)
      if (!moved.isFile() || moved.isSymbolicLink() || moved.dev !== expectedSource.dev || moved.ino !== expectedSource.ino) {
        await unlink(destination)
        throw new ServerFilesError('FILE_CONFLICT', 'The destination file did not preserve the source identity.')
      }
      try { await unlink(source) } catch (error) { await unlink(destination).catch(() => undefined); throw error }
    } catch (error) {
      if (fsError(error) && error.code === 'EEXIST') throw new ServerFilesError('FILE_ALREADY_EXISTS', 'The destination already exists. Files are never overwritten.')
      throw error
    }
  }

  private async serverRoot(serverId: string): Promise<string> {
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) throw new ServerFilesError('SERVER_NOT_FOUND', 'The registered server was not found.')
    if (server.source !== 'created' || !server.managed) throw new ServerFilesError('SERVER_NOT_PANEL_MANAGED', 'Imported folders remain read only in the server file manager.')
    const root = await realpath(this.servers.managedRoot)
    const directory = resolve(server.directory)
    if (dirname(directory) !== root || await realpath(directory).catch(() => '') !== directory) throw new ServerFilesError('SERVER_DIRECTORY_REJECTED', 'This server is not a safe direct child of the managed root.')
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServerFilesError('SERVER_DIRECTORY_UNSAFE', 'The managed server folder is not a real directory.')
    return directory
  }

  private worldFolders(serverId: string): Set<string> {
    const row = this.db.select({ worldFolders: localServers.worldFolders }).from(localServers).where(eq(localServers.id, serverId)).get()
    const names = new Set(WORLD_NAMES)
    try {
      const values: unknown = JSON.parse(row?.worldFolders ?? '[]')
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === 'string' && value.length <= 255 && !/[\\/:]/.test(value) && !containsPathControl(value) && value !== '.' && value !== '..') names.add(value.toLowerCase())
        }
      }
    } catch { /* malformed old registry metadata cannot broaden writable access past defaults */ }
    return names
  }

  private protectedReason(serverId: string, parts: string[]): string | null {
    return protectedReason(parts, this.worldFolders(serverId))
  }

  private async ensurePrivateDirectory(path: string, root: string): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== resolve(root)) throw new ServerFilesError('PRIVATE_DIRECTORY_UNSAFE', 'The private recovery root is not a safe directory.')
    const canonicalRoot = await realpath(root)
    const canonicalPath = resolve(path)
    if (!within(canonicalRoot, canonicalPath)) throw new ServerFilesError('PRIVATE_DIRECTORY_UNSAFE', 'The private storage location leaves its allowed root.')
    const segments = relative(canonicalRoot, canonicalPath).split(sep).filter(Boolean)
    let current = canonicalRoot
    for (const segment of segments) {
      current = join(current, segment)
      try { await mkdir(current, { mode: 0o700 }) } catch (error) { if (!fsError(error) || error.code !== 'EEXIST') throw error }
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) throw new ServerFilesError('PRIVATE_DIRECTORY_UNSAFE', 'The private recovery location is not a safe directory.')
      await chmod(current, 0o700)
    }
  }

  private async ensureTrashDirectory(serverRoot: string): Promise<string> {
    let current = serverRoot
    for (const segment of ['.mmsmanager', 'trash', 'file-manager']) {
      current = join(current, segment)
      try { await mkdir(current, { mode: 0o700 }) } catch (error) { if (!fsError(error) || error.code !== 'EEXIST') throw error }
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current || !within(serverRoot, current)) throw new ServerFilesError('PRIVATE_DIRECTORY_UNSAFE', 'The managed trash location is not a safe directory.')
      await chmod(current, 0o700)
    }
    return current
  }

  private async assertTreeSafe(root: string, directory: string, parts: string[], worldFolders: ReadonlySet<string>): Promise<void> {
    let inspected = 0
    const rootDevice = (await lstat(root)).dev
    const visit = async (current: string, pathParts: string[], depth: number): Promise<void> => {
      if (depth > 32) throw new ServerFilesError('FILE_TREE_LIMIT', 'Folder operations are limited to 32 nested levels.')
      for (const entry of await readdir(current, { withFileTypes: true })) {
        inspected += 1
        if (inspected > 20_000) throw new ServerFilesError('FILE_TREE_LIMIT', 'Folder operations are limited to 20,000 entries.')
        const childParts = [...pathParts, entry.name]
        if (childParts.some((part) => part.toLowerCase() === '.mmsmanager')) throw new ServerFilesError('FILE_PROTECTED', 'MMSManager private folders cannot be moved as part of another folder.')
        const reason = protectedReason(childParts, worldFolders)
        if (reason) throw new ServerFilesError('FILE_PROTECTED', `This folder contains protected content: ${reason}`)
        const child = join(current, entry.name)
        const stat = await lstat(child)
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1) || stat.dev !== rootDevice) {
          throw new ServerFilesError('FILE_UNSAFE', 'Folder operations do not follow symbolic links, special files, hard links or mounted filesystems.')
        }
        if (stat.isDirectory()) await visit(child, childParts, depth + 1)
      }
    }
    await visit(directory, parts, 0)
  }

  private async withMutation<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    if (this.mutations.has(serverId)) throw new ServerFilesError('SERVER_FILE_BUSY', 'Another file operation is already in progress.')
    this.mutations.add(serverId)
    try { return await this.processes.withServerFileMutation(serverId, operation) }
    catch (error) {
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('SERVER_')) throw new ServerFilesError(error.code, error.message)
      throw error
    } finally { this.mutations.delete(serverId) }
  }

  private audit(serverId: string, actorUserId: string, action: string, details: Record<string, string | number>): void {
    const occurredAt = new Date(this.now()).toISOString()
    this.db.insert(localServerEvents).values({ serverId, actorUserId, action, outcome: 'success', occurredAt, detail: JSON.stringify(details) }).run()
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    if (runtime?.status === 'running') this.db.update(localServerRuntime).set({ restartRequired: true, updatedAt: occurredAt }).where(eq(localServerRuntime.serverId, serverId)).run()
  }
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return containsDisallowedTextControl(text) ? null : text
  } catch { return null }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if (fsError(error) && error.code === 'ENOENT') return false; throw error }
}

async function writePrivateFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}

async function readPrivateFile(path: string, maxBytes: number): Promise<{ bytes: Buffer }> {
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > maxBytes) throw new ServerFilesError('FILE_RECOVERY_UNSAFE', 'The private recovery copy is missing, linked, or too large.')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new ServerFilesError('FILE_RECOVERY_UNSAFE', 'The private recovery copy changed while it was opened.')
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) throw new ServerFilesError('FILE_RECOVERY_UNSAFE', 'The private recovery copy exceeded its size limit.')
    return { bytes }
  } finally { await handle.close() }
}

function validImageHeader(extension: string, bytes: Buffer): boolean {
  if (extension === '.png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return extension === '.webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
}
