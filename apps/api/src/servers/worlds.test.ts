import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { localServers } from '../db/schema.js'
import { openDatabase } from '../db/client.js'
import { ServerRegistry } from './registry.js'
import { ServerWorldService } from './worlds.js'

describe('managed world inventory', () => {
  let temp: string
  let root: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let registry: ServerRegistry
  let service: ServerWorldService
  let managedId: string
  let managedDirectory: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-worlds-'))
    root = join(temp, 'servers')
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    registry = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: root })
    await registry.prepare()
    service = new ServerWorldService(opened.db, registry)
    managedId = randomUUID()
    managedDirectory = join(root, 'managed-fixture')
    await mkdir(managedDirectory)
    const at = new Date().toISOString()
    await opened.db.insert(localServers).values({
      id: managedId, name: 'World Fixture', directory: managedDirectory, source: 'created', software: 'vanilla',
      version: '1.21.4', jarName: 'server.jar', javaPath: null, javaMajor: 21, minMemoryMb: 512,
      maxMemoryMb: 2048, port: 25565, eula: 'accepted', managed: true,
      worldFolders: JSON.stringify(['custom_world']), createdBy: null, createdAt: at, updatedAt: at,
    }).run()
  })

  afterEach(async () => {
    opened.native.close()
    await rm(temp, { recursive: true, force: true })
  })

  it('uses server.properties and reports bounded sizes and timestamps for known dimensions', async () => {
    await writeFile(join(managedDirectory, 'server.properties'), '# world setting\nlevel-name=main\nserver-port=25565\n')
    await mkdir(join(managedDirectory, 'main', 'region'), { recursive: true })
    await mkdir(join(managedDirectory, 'main_nether'))
    await mkdir(join(managedDirectory, 'main_the_end'))
    await mkdir(join(managedDirectory, 'custom_world'))
    await writeFile(join(managedDirectory, 'main', 'region', 'r.0.0.mca'), 'region-fixture')
    const before = await import('node:fs/promises').then(({ stat }) => stat(join(managedDirectory, 'main', 'region', 'r.0.0.mca')))

    const result = await service.get(managedId)
    expect(result).toMatchObject({ status: 'available', levelName: 'main', levelNameSource: 'server.properties' })
    expect(result.entries).toHaveLength(4)
    expect(result.entries.find((entry) => entry.path === 'main')).toMatchObject({ state: 'available', sizeBytes: 14, sizeComplete: true, dimension: 'overworld', backupAvailable: false })
    expect(result.entries.find((entry) => entry.path === 'main_nether')).toMatchObject({ dimension: 'nether', sizeBytes: 0, state: 'available' })
    expect(result.entries.find((entry) => entry.path === 'main_the_end')).toMatchObject({ dimension: 'end' })
    expect(result.entries.find((entry) => entry.path === 'custom_world')).toMatchObject({ dimension: 'custom' })
    expect(Date.parse(result.entries.find((entry) => entry.path === 'main')!.modifiedAt!)).toBeGreaterThanOrEqual(before.mtimeMs - 1000)
  })

  it('uses the Minecraft default only when server.properties omits level-name', async () => {
    await writeFile(join(managedDirectory, 'server.properties'), 'server-port=25565\n')
    const result = await service.get(managedId)
    expect(result).toMatchObject({ status: 'available', levelName: 'world', levelNameSource: 'minecraft-default' })
    expect(result.entries.map((entry) => entry.path)).toEqual(['world', 'world_nether', 'world_the_end', 'custom_world'])
  })

  it('rejects traversal and symlink escapes without reading outside the server root', async () => {
    const outside = join(temp, 'outside-world')
    await mkdir(outside)
    await writeFile(join(outside, 'private.dat'), 'outside bytes must not be scanned')
    await writeFile(join(managedDirectory, 'server.properties'), 'level-name=../outside-world\n')
    const traversal = await service.get(managedId)
    expect(traversal).toMatchObject({ status: 'unavailable', entries: [] })

    await writeFile(join(managedDirectory, 'server.properties'), 'level-name=linked\n')
    await symlink(outside, join(managedDirectory, 'linked'))
    const linked = await service.get(managedId)
    expect(linked.entries[0]).toMatchObject({ path: 'linked', state: 'unsafe', sizeBytes: null, sizeComplete: false })
    expect(linked.entries[0]?.reason).toMatch(/safe directory/)
  })

  it('skips symlinks inside a world and marks its reported size as incomplete', async () => {
    const outside = join(temp, 'outside-file')
    await writeFile(outside, 'do not count')
    await writeFile(join(managedDirectory, 'server.properties'), 'level-name=world\n')
    const world = join(managedDirectory, 'world')
    await mkdir(world)
    await writeFile(join(world, 'safe.dat'), 'safe')
    await symlink(outside, join(world, 'escape.dat'))
    const result = await service.get(managedId)
    expect(result.entries[0]).toMatchObject({ state: 'incomplete', sizeBytes: 4, sizeComplete: false })
    expect(result.entries[0]?.reason).toMatch(/Links/)
  })

  it('does not inspect registered imported folders', async () => {
    const importedId = randomUUID()
    const imported = join(temp, 'legacy-server')
    await mkdir(imported)
    await writeFile(join(imported, 'server.properties'), 'level-name=world\n')
    await opened.db.insert(localServers).values({
      id: importedId, name: 'Imported Fixture', directory: imported, source: 'imported', software: 'unknown',
      version: null, jarName: null, javaPath: null, javaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024,
      port: null, eula: 'unknown', managed: false, worldFolders: '[]', createdBy: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run()
    expect(await service.get(importedId)).toMatchObject({ status: 'unavailable', entries: [], reason: expect.stringContaining('read only') })
  })
})
