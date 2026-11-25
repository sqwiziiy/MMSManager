import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { localServerEvents, localServerFileRecoveries, localServers, users } from '../db/schema.js'
import { openDatabase } from '../db/client.js'
import { ServerRegistry } from './registry.js'
import { ServerProcessManager } from './processes.js'
import { ServerFileService } from './files.js'

describe('managed server file manager', () => {
  let temp: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let registry: ServerRegistry
  let processes: ServerProcessManager
  let service: ServerFileService
  let userId: string
  let managedId: string
  let importedId: string
  let serverDirectory: string
  let outside: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-files-'))
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    registry = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: join(temp, 'servers') })
    await registry.prepare()
    userId = randomUUID(); managedId = randomUUID(); importedId = randomUUID()
    const now = new Date().toISOString()
    await opened.db.insert(users).values({ id: userId, username: 'files-owner', usernameKey: 'files-owner', displayName: 'Files Owner', role: 'administrator', passwordHash: 'test-only-hash', createdAt: now, updatedAt: now, passwordChangedAt: now })
    serverDirectory = join(registry.managedRoot, 'files-fixture')
    const importedDirectory = join(registry.managedRoot, 'imported-fixture')
    await mkdir(join(serverDirectory, 'config'), { recursive: true })
    await mkdir(join(serverDirectory, 'mods'), { recursive: true })
    await mkdir(join(serverDirectory, 'world'), { recursive: true })
    await mkdir(importedDirectory)
    outside = join(temp, 'outside.txt')
    await writeFile(outside, 'outside stays private')
    await writeFile(join(serverDirectory, 'readme.txt'), 'first version\n', { mode: 0o640 })
    await writeFile(join(serverDirectory, 'server.properties'), 'motd=Private\nrcon.password=do-not-show\n')
    await writeFile(join(serverDirectory, 'server.jar'), 'protected jar placeholder')
    await writeFile(join(serverDirectory, 'rcon.password'), 'secret')
    await writeFile(join(serverDirectory, 'world', 'level.dat'), 'world data')
    await opened.db.insert(localServers).values([
      { id: managedId, name: 'Files Fixture', directory: serverDirectory, source: 'created', software: 'fabric', version: '1.21.4', jarName: 'server.jar', javaPath: null, javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: 25565, eula: 'accepted', managed: true, worldFolders: '["world"]', createdBy: userId, createdAt: now, updatedAt: now },
      { id: importedId, name: 'Imported Files Fixture', directory: importedDirectory, source: 'imported', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath: null, javaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024, port: null, eula: 'unknown', managed: false, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now },
    ]).run()
    processes = new ServerProcessManager(opened.db, registry)
    await processes.prepare()
    service = new ServerFileService(opened.db, registry, processes, () => Date.parse('2026-11-23T12:00:00.000Z'))
  })

  afterEach(async () => {
    try { await processes?.shutdown() } finally {
      opened?.native.close()
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('lists scoped files, creates folders and text files, uploads, downloads, and moves without overwriting', async () => {
    const root = await service.list(managedId)
    expect(root.entries.map((item) => item.name)).toContain('readme.txt')
    expect(root.entries.map((item) => item.name)).not.toContain('.mmsmanager')
    expect(root.entries.find((item) => item.name === 'server.jar')).toMatchObject({ contentState: 'protected', canDownload: false, canEdit: false, canTrash: false })
    expect(root.entries.find((item) => item.name === 'world')).toMatchObject({ contentState: 'protected' })

    const created = await service.create(managedId, userId, 'notes', 'folder')
    expect(created.entries.map((item) => item.name)).toContain('notes')
    await service.create(managedId, userId, 'notes/new.txt', 'file', 'created text\n')
    const uploaded = await service.upload(managedId, userId, 'config', 'uploaded.txt', Readable.from([Buffer.from('uploaded safely\n')]), () => false)
    expect(uploaded.entries.map((item) => item.name)).toContain('uploaded.txt')
    await expect(service.download(managedId, 'config/uploaded.txt')).resolves.toMatchObject({ name: 'uploaded.txt', bytes: Buffer.from('uploaded safely\n') })
    await expect(service.upload(managedId, userId, 'config', 'uploaded.txt', Readable.from([Buffer.from('replace')]), () => false)).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' })
    await expect(service.upload(managedId, userId, 'config', 'fake.sh', Readable.from([Buffer.from('echo unsafe')]), () => false)).rejects.toMatchObject({ code: 'FILE_PROTECTED' })
    const binaryImage = Buffer.from([0x00, 0xff, 0x10])
    await service.upload(managedId, userId, 'config', 'fake.png', Readable.from([binaryImage]), () => false)
    await expect(service.download(managedId, 'config/fake.png')).resolves.toMatchObject({ bytes: binaryImage })
    const moved = await service.move(managedId, userId, 'notes/new.txt', 'config/renamed.txt')
    expect(moved.path).toBe('notes')
    expect(moved.entries).toEqual([])
    expect((await service.list(managedId, 'config')).entries.map((item) => item.name)).toContain('renamed.txt')
    expect(await readFile(join(serverDirectory, 'config', 'renamed.txt'), 'utf8')).toBe('created text\n')
    await expect(service.move(managedId, userId, 'config/renamed.txt', 'config/uploaded.txt')).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' })
  })

  it('streams binary batches into nested folders, creates empty directories and never overwrites', async () => {
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x41, 0x0a])
    const manifest = { files: ['resource-pack/data/chunk.bin', 'notes/readme.txt'], directories: ['empty/child'] }
    const uploads = async function* () {
      yield { relativePath: manifest.files[0]!, stream: Readable.from([binary.subarray(0, 2), binary.subarray(2)]), truncated: () => false }
      yield { relativePath: manifest.files[1]!, stream: Readable.from([Buffer.from('fixture note\n')]), truncated: () => false }
    }
    const inventory = await service.uploadBatch(managedId, userId, 'config', manifest, uploads())
    expect(inventory.path).toBe('config')
    expect(inventory.entries.map((item) => item.name)).toEqual(expect.arrayContaining(['empty', 'notes', 'resource-pack']))
    expect(await readFile(join(serverDirectory, 'config', 'resource-pack', 'data', 'chunk.bin'))).toEqual(binary)
    expect(await readFile(join(serverDirectory, 'config', 'notes', 'readme.txt'), 'utf8')).toBe('fixture note\n')
    expect(await readdir(join(serverDirectory, 'config', 'empty', 'child'))).toEqual([])
    await expect(service.download(managedId, 'config/resource-pack/data/chunk.bin')).resolves.toMatchObject({ bytes: binary })

    await expect(service.uploadBatch(managedId, userId, 'config', manifest, uploads())).rejects.toMatchObject({ code: 'FILE_ALREADY_EXISTS' })
    expect(await readFile(join(serverDirectory, 'config', 'resource-pack', 'data', 'chunk.bin'))).toEqual(binary)
    expect((await readdir(join(serverDirectory, 'config'))).some((name) => /^\.mms-file-.*\.tmp$/.test(name))).toBe(false)
  })

  it('removes staged files and newly created folders after an interrupted batch', async () => {
    const interrupted = async function* () {
      yield Buffer.from('partial bytes')
      throw new Error('fixture stream interrupted')
    }
    const uploads = async function* () {
      yield { relativePath: 'new-folder/broken.bin', stream: Readable.from(interrupted()), truncated: () => false }
    }
    await expect(service.uploadBatch(managedId, userId, 'config', { files: ['new-folder/broken.bin'], directories: [] }, uploads()))
      .rejects.toMatchObject({ code: 'FILE_UPLOAD_FAILED' })
    expect(await readdir(join(serverDirectory, 'config'))).not.toContain('new-folder')
    expect((await readdir(join(serverDirectory, 'config'))).some((name) => /^\.mms-file-.*\.tmp$/.test(name))).toBe(false)
  })

  it('rejects upload path traversal, protected artifacts, portable name collisions and excessive nesting', async () => {
    const empty = async function* () { /* the manifest is rejected before any body is accepted */ }
    await expect(service.uploadBatch(managedId, userId, 'config', { files: ['../escape.bin'], directories: [] }, empty())).rejects.toMatchObject({ code: 'FILE_PATH_REJECTED' })
    await expect(service.uploadBatch(managedId, userId, 'config', { files: ['mods/unsafe.bin'], directories: [] }, empty())).rejects.toMatchObject({ code: 'FILE_PROTECTED' })
    await expect(service.uploadBatch(managedId, userId, 'config', { files: ['A.bin', 'a.bin'], directories: [] }, empty())).rejects.toMatchObject({ code: 'FILE_NAME_COLLISION' })
    await expect(service.uploadBatch(managedId, userId, 'config', { files: ['too/deep/path/one/two/three/four/five/six/seven/eight/nine/ten/eleven/twelve/thirteen/fourteen/fifteen.bin'], directories: [] }, empty())).rejects.toMatchObject({ code: 'FILE_PATH_REJECTED' })
    expect(await readFile(outside, 'utf8')).toBe('outside stays private')
  })

  it('rejects nested bind mounts even when their device identifiers match the managed root', async () => {
    const nested = join(serverDirectory, 'mounted')
    const mountInfo = `40 1 8:1 / ${serverDirectory.replaceAll(' ', '\\040')} rw - ext4 /dev/test rw\n41 40 8:1 / ${nested.replaceAll(' ', '\\040')} rw - ext4 /dev/test rw\n`
    const mountedService = new ServerFileService(opened.db, registry, processes, Date.now, async () => mountInfo)
    await expect(mountedService.uploadBatch(managedId, userId, '', { files: [], directories: ['mounted'] }, (async function* () {})()))
      .rejects.toMatchObject({ code: 'FILE_MOUNT_REJECTED' })
    expect(await readdir(serverDirectory)).not.toContain('mounted')
  })

  it('keeps file edits atomic, creates private recoveries, restores them and detects stale writes', async () => {
    const original = await service.read(managedId, 'readme.txt')
    expect(original).toMatchObject({ contentState: 'editable', text: 'first version\n' })
    const changed = await service.writeText(managedId, userId, 'readme.txt', 'second version\n', original.sha256!)
    expect(changed.text).toBe('second version\n')
    expect(await readFile(join(serverDirectory, 'readme.txt'), 'utf8')).toBe('second version\n')
    const recoveryList = await service.listRecoveries(managedId, 'readme.txt')
    expect(recoveryList).toHaveLength(1)
    const recoveryPath = join(temp, 'server-file-recoveries', managedId, `${recoveryList[0]!.id}.bin`)
    expect(await readFile(recoveryPath, 'utf8')).toBe('first version\n')
    expect((await lstat(recoveryPath)).mode & 0o777).toBe(0o600)

    const restored = await service.restoreRecovery(managedId, userId, recoveryList[0]!.id, changed.sha256!)
    expect(restored.text).toBe('first version\n')
    expect(await readFile(join(serverDirectory, 'readme.txt'), 'utf8')).toBe('first version\n')
    expect(await service.listRecoveries(managedId, 'readme.txt')).toHaveLength(2)

    const stale = await service.read(managedId, 'readme.txt')
    await writeFile(join(serverDirectory, 'readme.txt'), 'external writer\n')
    await expect(service.writeText(managedId, userId, 'readme.txt', 'would overwrite external data', stale.sha256!)).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    expect(await readFile(join(serverDirectory, 'readme.txt'), 'utf8')).toBe('external writer\n')
  })

  it('moves deletions to a recoverable trash across service restart and restores exact contents', async () => {
    const original = Buffer.from('recover these exact bytes\n')
    await writeFile(join(serverDirectory, 'config', 'recover.txt'), original)
    const result = await service.trash(managedId, userId, 'config/recover.txt')
    expect(await readdir(join(serverDirectory, 'config'))).not.toContain('recover.txt')
    expect(result.item).toMatchObject({ name: 'recover.txt', originalPath: 'config/recover.txt', kind: 'file' })
    const stored = join(serverDirectory, '.mmsmanager', 'trash', 'file-manager', result.item.id)
    expect(await readFile(stored)).toEqual(original)
    const afterRestart = new ServerFileService(opened.db, registry, processes)
    expect(afterRestart.listTrash(managedId)).toHaveLength(1)
    const restored = await afterRestart.restoreTrash(managedId, userId, result.item.id)
    expect(restored.path).toBe('config')
    expect(await readFile(join(serverDirectory, 'config', 'recover.txt'))).toEqual(original)
    expect(afterRestart.listTrash(managedId)).toHaveLength(0)
    expect((await opened.db.select().from(localServerEvents).where(eq(localServerEvents.serverId, managedId)).all()).map((event) => event.action)).toContain('server-file-restored')
  })

  it('rejects recovery-ledger filenames that leave the private recovery directory', async () => {
    const original = await service.read(managedId, 'readme.txt')
    const changed = await service.writeText(managedId, userId, 'readme.txt', 'changed safely\n', original.sha256!)
    const [recovery] = await service.listRecoveries(managedId, 'readme.txt')
    expect(recovery).toBeDefined()
    await opened.db.update(localServerFileRecoveries).set({ fileName: '../../outside.txt' }).where(eq(localServerFileRecoveries.id, recovery!.id)).run()
    await expect(service.restoreRecovery(managedId, userId, recovery!.id, changed.sha256!)).rejects.toMatchObject({ code: 'FILE_RECOVERY_UNSAFE' })
    expect(await readFile(join(serverDirectory, 'readme.txt'), 'utf8')).toBe('changed safely\n')
    expect(await readFile(outside, 'utf8')).toBe('outside stays private')
  })

  it('rejects traversal, symlink, hard-link, protected-path and imported-server access', async () => {
    await symlink(outside, join(serverDirectory, 'escape.txt'))
    await link(join(serverDirectory, 'readme.txt'), join(serverDirectory, 'hardlink.txt'))
    await expect(service.list(managedId, '../outside')).rejects.toMatchObject({ code: 'FILE_PATH_REJECTED' })
    await expect(service.list(managedId, '/etc')).rejects.toMatchObject({ code: 'FILE_PATH_REJECTED' })
    await expect(service.read(managedId, 'escape.txt')).rejects.toMatchObject({ code: 'FILE_UNSAFE' })
    await expect(service.read(managedId, 'hardlink.txt')).rejects.toMatchObject({ code: 'FILE_UNSAFE' })
    await expect(service.read(managedId, 'server.jar')).resolves.toMatchObject({ contentState: 'protected', text: null })
    await expect(service.read(managedId, 'rcon.password')).resolves.toMatchObject({ contentState: 'protected', text: null })
    await expect(service.read(managedId, 'server.properties')).resolves.toMatchObject({ contentState: 'protected', text: null })
    await expect(service.download(managedId, 'server.properties')).rejects.toMatchObject({ code: 'FILE_PROTECTED' })
    await expect(service.trash(managedId, userId, 'world')).rejects.toMatchObject({ code: 'FILE_PROTECTED' })
    await expect(service.trash(managedId, userId, 'server.jar')).rejects.toMatchObject({ code: 'FILE_PROTECTED' })
    await expect(service.move(managedId, userId, 'readme.txt', 'mods/readme.txt')).rejects.toMatchObject({ code: 'FILE_PROTECTED' })
    await expect(service.list(importedId)).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
    await expect(service.create(importedId, userId, 'new.txt', 'file')).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
    expect(await readFile(outside, 'utf8')).toBe('outside stays private')
  })

  it('does not move a folder that contains protected assets or unsafe links', async () => {
    await mkdir(join(serverDirectory, 'bundle', 'mods'), { recursive: true })
    await writeFile(join(serverDirectory, 'bundle', 'mods', 'addon.jar'), 'mod')
    await expect(service.move(managedId, userId, 'bundle', 'other-bundle')).rejects.toMatchObject({ code: 'FILE_PROTECTED' })
    await symlink(outside, join(serverDirectory, 'bundle', 'escape.txt'))
    await rm(join(serverDirectory, 'bundle', 'mods'), { recursive: true })
    await expect(service.trash(managedId, userId, 'bundle')).rejects.toMatchObject({ code: 'FILE_UNSAFE' })
    expect(await readFile(outside, 'utf8')).toBe('outside stays private')
  })
})
