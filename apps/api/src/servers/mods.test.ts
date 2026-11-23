import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { localServerEvents, localServers, users } from '../db/schema.js'
import { openDatabase } from '../db/client.js'
import { ServerRegistry } from './registry.js'
import { ServerProcessManager } from './processes.js'
import { inspectModJar, ServerModsError, ServerModsService } from './mods.js'

function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function makeJar(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const contents = Buffer.from(text)
    const crc = crc32(contents)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(contents.byteLength, 18)
    local.writeUInt32LE(contents.byteLength, 22)
    local.writeUInt16LE(nameBytes.byteLength, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBytes, contents)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(contents.byteLength, 20)
    central.writeUInt32LE(contents.byteLength, 24)
    central.writeUInt16LE(nameBytes.byteLength, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, nameBytes)
    localOffset += local.byteLength + nameBytes.byteLength + contents.byteLength
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralDirectory.byteLength, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

describe('managed server mod files', () => {
  let temp: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let registry: ServerRegistry
  let processes: ServerProcessManager
  let service: ServerModsService
  let userId: string
  let fabricId: string
  let importedId: string
  let vanillaId: string
  let fabricDirectory: string
  let importedDirectory: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-mods-'))
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    registry = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: join(temp, 'servers') })
    await registry.prepare()
    userId = randomUUID()
    const now = new Date().toISOString()
    await opened.db.insert(users).values({ id: userId, username: 'mods-owner', usernameKey: 'mods-owner', displayName: 'Mods Owner', role: 'administrator', passwordHash: 'test-only-hash', createdAt: now, updatedAt: now, passwordChangedAt: now }).run()
    fabricId = randomUUID()
    importedId = randomUUID()
    vanillaId = randomUUID()
    fabricDirectory = join(registry.managedRoot, 'fabric-fixture')
    importedDirectory = join(registry.managedRoot, 'imported-fixture')
    const vanillaDirectory = join(registry.managedRoot, 'vanilla-fixture')
    await Promise.all([mkdir(fabricDirectory), mkdir(importedDirectory), mkdir(vanillaDirectory)])
    const serverRow = (id: string, name: string, directory: string, software: 'fabric' | 'vanilla', source: 'created' | 'imported', managed: boolean) => ({
      id, name, directory, source, software, version: '1.21.4', jarName: 'server.jar', javaPath: null, javaMajor: null,
      minMemoryMb: 512, maxMemoryMb: 1024, port: null, eula: 'accepted' as const, managed,
      worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now,
    })
    await opened.db.insert(localServers).values([
      serverRow(fabricId, 'Fabric Fixture', fabricDirectory, 'fabric', 'created', true),
      serverRow(importedId, 'Imported Fabric', importedDirectory, 'fabric', 'imported', false),
      serverRow(vanillaId, 'Vanilla Fixture', vanillaDirectory, 'vanilla', 'created', true),
    ]).run()
    processes = new ServerProcessManager(opened.db, registry)
    await processes.prepare()
    service = new ServerModsService(opened.db, registry, processes)
  })

  afterEach(async () => {
    try { await processes?.shutdown() } finally {
      opened?.native.close()
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('reads bounded Fabric/Paper metadata and leaves archives without metadata unknown', async () => {
    const fabricPath = join(temp, 'fabric.jar')
    const paperPath = join(temp, 'paper.jar')
    const unknownPath = join(temp, 'unknown.jar')
    await writeFile(fabricPath, makeJar({ 'META-INF/': '', 'fabric.mod.json': JSON.stringify({ id: 'map_markers', name: 'Map Markers', version: '2.4.1', depends: { minecraft: '>=1.21', fabricloader: '>=0.16', cloth_config: '*' } }) }))
    await writeFile(paperPath, makeJar({ 'plugin.yml': 'name: FixturePlugin\nversion: 1.3.0\nmain: example.Plugin\napi-version: "1.21"\ndepend:\n  - LuckPerms\nsoftdepend: [PlaceholderAPI]\n' }))
    await writeFile(unknownPath, makeJar({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n' }))
    await expect(inspectModJar(fabricPath)).resolves.toMatchObject({ metadataKind: 'fabric', metadataState: 'known', modId: 'map_markers', artifactVersion: '2.4.1', minecraftConstraint: '>=1.21', loaderConstraint: '>=0.16', dependencies: ['minecraft', 'fabricloader', 'cloth_config'] })
    await expect(inspectModJar(paperPath)).resolves.toMatchObject({ metadataKind: 'paper', metadataState: 'known', modId: 'FixturePlugin', artifactVersion: '1.3.0', minecraftConstraint: '1.21', dependencies: ['LuckPerms', 'PlaceholderAPI'] })
    await expect(inspectModJar(unknownPath)).resolves.toMatchObject({ metadataKind: 'unknown', metadataState: 'unknown', modId: null })
  })

  it('uploads, disables, re-enables, quarantines and restores exact JAR bytes', async () => {
    const bytes = makeJar({ 'fabric.mod.json': JSON.stringify({ id: 'fixture_mod', name: 'Fixture Mod', version: '1.0.0', depends: { minecraft: '1.21.4' } }) })
    const uploaded = await service.upload(fabricId, userId, 'fixture-mod.jar', Readable.from([bytes]), () => false)
    expect(uploaded.items).toHaveLength(1)
    expect(uploaded.items[0]).toMatchObject({ fileName: 'fixture-mod.jar', state: 'enabled', modId: 'fixture_mod', artifactVersion: '1.0.0' })
    await expect(service.upload(fabricId, userId, 'fixture-mod.jar', Readable.from([bytes]), () => false)).rejects.toMatchObject({ code: 'MOD_DUPLICATE' })

    const disabled = await service.setEnabled(fabricId, userId, 'fixture-mod.jar', false)
    expect(disabled.items.map((item) => item.state)).toEqual(['disabled'])
    const disabledPath = join(fabricDirectory, '.mmsmanager', 'disabled-mods', 'fabric')
    const disabledName = (await readdir(disabledPath))[0]!
    expect(await readFile(join(disabledPath, disabledName))).toEqual(bytes)
    const enabled = await service.setEnabled(fabricId, userId, 'fixture-mod.jar', true)
    expect(enabled.items[0]?.state).toBe('enabled')
    expect(await readFile(join(fabricDirectory, 'mods', 'fixture-mod.jar'))).toEqual(bytes)

    const quarantined = await service.quarantine(fabricId, userId, 'fixture-mod.jar')
    expect(quarantined.items).toHaveLength(1)
    expect(quarantined.items[0]).toMatchObject({ state: 'quarantined', fileName: 'fixture-mod.jar' })
    const quarantineId = quarantined.items[0]!.id
    const quarantinePath = join(fabricDirectory, '.mmsmanager', 'quarantine', 'mods', `${quarantineId}--fixture-mod.jar`)
    expect(await readFile(quarantinePath)).toEqual(bytes)
    const restored = await service.restoreQuarantine(fabricId, userId, quarantineId)
    expect(restored.items).toMatchObject([{ state: 'enabled', fileName: 'fixture-mod.jar', modId: 'fixture_mod' }])
    expect(await readFile(join(fabricDirectory, 'mods', 'fixture-mod.jar'))).toEqual(bytes)
    expect((await opened.db.select().from(localServerEvents).where(eq(localServerEvents.serverId, fabricId)).all()).map((event) => event.action)).toEqual(['mod-uploaded', 'mod-uploaded', 'mod-disabled', 'mod-enabled', 'mod-quarantined', 'mod-restored'])
    expect((await opened.db.select().from(localServerEvents).where(eq(localServerEvents.serverId, fabricId)).all()).some((event) => event.detail.includes(bytes.toString('base64')))).toBe(false)
  })

  it('rejects malformed, traversal-bearing, duplicate and oversized metadata without leaving partial files', async () => {
    const malformedPath = join(temp, 'invalid.jar')
    const traversalPath = join(temp, 'traversal.jar')
    const hugeMetadataPath = join(temp, 'huge.jar')
    await writeFile(malformedPath, Buffer.from('not a jar'))
    await writeFile(traversalPath, makeJar({ '../fabric.mod.json': '{}' }))
    await writeFile(hugeMetadataPath, makeJar({ 'fabric.mod.json': JSON.stringify({ id: 'x', name: 'x', version: '1', extra: 'a'.repeat(65_536) }) }))
    await expect(inspectModJar(malformedPath)).rejects.toBeInstanceOf(ServerModsError)
    await expect(inspectModJar(traversalPath)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    await expect(inspectModJar(hugeMetadataPath)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    await expect(service.upload(fabricId, userId, '../escape.jar', Readable.from([Buffer.from('bad')]), () => false)).rejects.toMatchObject({ code: 'INVALID_FILENAME' })
    await expect(service.upload(fabricId, userId, 'invalid.jar', Readable.from([Buffer.from('bad')]), () => false)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })
    expect(await readdir(join(fabricDirectory, 'mods'))).toEqual([])
  })

  it('keeps imports read only, rejects unsupported loaders and refuses symlinked mod directories', async () => {
    await expect(service.setEnabled(importedId, userId, 'anything.jar', false)).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
    await expect(service.list(vanillaId)).resolves.toMatchObject({ supported: false, loader: 'unsupported', items: [] })
    await expect(service.setEnabled(vanillaId, userId, 'anything.jar', false)).rejects.toMatchObject({ code: 'MODS_UNSUPPORTED' })
    const external = join(temp, 'external-mods')
    await mkdir(external)
    await rm(join(fabricDirectory, 'mods'), { recursive: true, force: true })
    await symlink(external, join(fabricDirectory, 'mods'))
    await expect(service.list(fabricId)).rejects.toMatchObject({ code: 'UNSAFE_DIRECTORY' })
    const linked = await lstat(join(fabricDirectory, 'mods'))
    expect(linked.isSymbolicLink()).toBe(true)
  })
})
