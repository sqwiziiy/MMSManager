import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { localServerBackups, localServerEvents, localServerRuntime, localServers, serverAccessGrants, users } from '../db/schema.js'
import { inspectJavaRuntime, JavaRuntimeError, JavaRuntimeRegistry } from './java.js'
import { ServerRegistry } from './registry.js'

describe('local server inventory', () => {
  let directory: string
  let serverRoot: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let registry: ServerRegistry
  let userId: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-inventory-'))
    serverRoot = join(directory, 'servers')
    opened = await openDatabase({ path: join(directory, 'mmsmanager.sqlite') })
    registry = new ServerRegistry(opened.db, directory, {
      MMSMANAGER_SERVER_ROOT: serverRoot,
      MMSMANAGER_IMPORT_ROOTS: serverRoot,
    }, () => Date.parse('2026-11-23T12:00:00.000Z'))
    await registry.prepare()
    userId = randomUUID()
    const now = '2026-11-23T12:00:00.000Z'
    await opened.db.insert(users).values({
      id: userId,
      username: 'inventory-test',
      usernameKey: 'inventory-test',
      displayName: 'Inventory Test',
      role: 'administrator',
      passwordHash: 'test-only-not-a-login-hash',
      createdAt: now,
      updatedAt: now,
      passwordChangedAt: now,
    })
  })

  afterEach(async () => {
    opened.native.close()
    await rm(directory, { recursive: true, force: true })
  })

  async function makeServer(name = 'Legacy World') {
    const serverDirectory = join(serverRoot, name)
    await mkdir(join(serverDirectory, 'world'), { recursive: true })
    await mkdir(join(serverDirectory, 'mods'))
    await writeFile(join(serverDirectory, 'server-1.21.4.jar'), 'disposable fake archive')
    await writeFile(join(serverDirectory, 'server.properties'), '# server setting\nserver-port=25569\nonline-mode=true\n')
    await writeFile(join(serverDirectory, 'eula.txt'), 'eula=true\n')
    return serverDirectory
  }

  it('inspects and registers a real local directory without changing its contents', async () => {
    const serverDirectory = await makeServer()
    const beforeNames = (await readdir(serverDirectory)).sort()
    const beforeProperties = await readFile(join(serverDirectory, 'server.properties'), 'utf8')
    const beforeEula = await readFile(join(serverDirectory, 'eula.txt'), 'utf8')
    const beforeJar = await readFile(join(serverDirectory, 'server-1.21.4.jar'))
    const preview = await registry.inspect(serverDirectory)
    expect(preview).toMatchObject({
      path: serverDirectory,
      directoryName: 'Legacy World',
      software: 'vanilla',
      version: '1.21.4',
      jarName: 'server-1.21.4.jar',
      port: 25569,
      eula: 'accepted',
      worldFolders: ['world'],
      alreadyRegistered: false,
    })

    const server = await registry.registerImport({
      path: serverDirectory,
      name: 'Legacy World',
      minMemoryMb: 1024,
      maxMemoryMb: 4096,
    }, userId)
    expect(server).toMatchObject({ source: 'imported', managed: false, software: 'vanilla', eula: 'accepted' })
    expect((await registry.inspect(serverDirectory)).alreadyRegistered).toBe(true)
    expect((await readdir(serverDirectory)).sort()).toEqual(beforeNames)
    expect(await readFile(join(serverDirectory, 'server.properties'), 'utf8')).toBe(beforeProperties)
    expect(await readFile(join(serverDirectory, 'eula.txt'), 'utf8')).toBe(beforeEula)
    expect(await readFile(join(serverDirectory, 'server-1.21.4.jar'))).toEqual(beforeJar)
    expect((await lstat(join(serverDirectory, 'world'))).isDirectory()).toBe(true)
  })

  it('loads the configured port from server.properties at startup instead of trusting a stale SQLite cache', async () => {
    const serverDirectory = await makeServer('Port startup fixture')
    const registered = await registry.registerImport({ path: serverDirectory, name: 'Port startup fixture', minMemoryMb: 1024, maxMemoryMb: 2048 }, userId)
    await opened.db.update(localServers).set({ port: 25000 }).where(eq(localServers.id, registered.id)).run()

    const restartedRegistry = new ServerRegistry(opened.db, directory, {
      MMSMANAGER_SERVER_ROOT: serverRoot,
      MMSMANAGER_IMPORT_ROOTS: serverRoot,
    })
    await restartedRegistry.prepare()
    expect(await restartedRegistry.getPortConfiguration(registered.id)).toMatchObject({ port: 25569, status: 'valid' })
    expect(opened.db.select().from(localServers).where(eq(localServers.id, registered.id)).get()?.port).toBe(25569)
    expect((await restartedRegistry.listPublic()).find((server) => server.id === registered.id)).toMatchObject({ port: 25569, portStatus: 'valid' })
  })

  it('refreshes external changes and clears stale SQLite values when the port becomes invalid or missing', async () => {
    const serverDirectory = await makeServer('Port refresh fixture')
    const registered = await registry.registerImport({ path: serverDirectory, name: 'Port refresh fixture', minMemoryMb: 1024, maxMemoryMb: 2048 }, userId)

    await writeFile(join(serverDirectory, 'server.properties'), '# server-port=25565\nserver-port : 25581\nserver-port=25582\n')
    await registry.refreshPortConfigurations(true)
    expect(await registry.getPortConfiguration(registered.id)).toMatchObject({ port: 25582, status: 'valid' })
    expect(opened.db.select().from(localServers).where(eq(localServers.id, registered.id)).get()?.port).toBe(25582)

    await writeFile(join(serverDirectory, 'server.properties'), 'server-port=invalid\n')
    await registry.refreshPortConfigurations(true)
    expect(await registry.getPortConfiguration(registered.id)).toMatchObject({ port: null, status: 'invalid', errorCode: 'PORT_VALUE_INVALID' })
    expect(opened.db.select().from(localServers).where(eq(localServers.id, registered.id)).get()?.port).toBeNull()

    await rm(join(serverDirectory, 'server.properties'))
    await registry.refreshPortConfigurations(true)
    expect(await registry.getPortConfiguration(registered.id)).toMatchObject({ port: null, status: 'missing', errorCode: 'PORT_FILE_MISSING' })
  })

  it('edits only display metadata and preserves the imported directory and files', async () => {
    const serverDirectory = await makeServer('Metadata Fixture')
    const beforeProperties = await readFile(join(serverDirectory, 'server.properties'), 'utf8')
    const server = await registry.registerImport({ path: serverDirectory, name: 'Before edit', minMemoryMb: 1024, maxMemoryMb: 2048 }, userId)
    const updated = await registry.updateMetadata(server.id, 'After edit', userId)
    expect(updated.name).toBe('After edit')
    expect(opened.db.select().from(localServers).where(eq(localServers.id, server.id)).get()?.directory).toBe(serverDirectory)
    expect(await readFile(join(serverDirectory, 'server.properties'), 'utf8')).toBe(beforeProperties)
    expect(opened.db.select().from(localServerEvents).where(eq(localServerEvents.action, 'server-metadata-updated')).get()).toMatchObject({ serverId: server.id, actorUserId: userId })
  })

  it('corrects a stopped managed loader in place and preserves its identity, data, backup and access grant', async () => {
    const serverDirectory = await makeServer('Storm Survival V2')
    const worldFile = join(serverDirectory, 'world', 'level.dat')
    await writeFile(worldFile, 'preserved world data')
    const server = await registry.registerImport({ path: serverDirectory, name: 'Storm Survival V2', minMemoryMb: 1024, maxMemoryMb: 4096 }, userId)
    await opened.db.update(localServers).set({
      source: 'created', managed: true, software: 'fabric', loader: null, version: '1.21.1',
      jarName: 'server-1.21.4.jar',
    }).where(eq(localServers.id, server.id)).run()
    await opened.db.insert(serverAccessGrants).values({ serverId: server.id, userId, viewServer: true, createdAt: '2026-11-23T12:00:00.000Z', updatedAt: '2026-11-23T12:00:00.000Z' }).run()
    await opened.db.insert(localServerBackups).values({
      id: randomUUID(), serverId: server.id, actorUserId: userId, kind: 'manual', origin: 'manual',
      directoryName: 'backup-preserved', createdAt: '2026-11-23T12:00:00.000Z', archiveSizeBytes: 1, manifestSizeBytes: 1,
      worldPathsJson: '["world"]', archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64),
      entryCount: 1, fileCount: 1, totalFileBytes: 1, excludedCount: 0,
    }).run()
    const neoArgs = 'libraries/net/neoforged/fancymod/1.0/fancymod.jar\n-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap --launchTarget neoforgeserver\n'
    const argsFile = 'libraries/net/neoforged/neoforge/21.1.184/unix_args.txt'
    await mkdir(join(serverDirectory, argsFile, '..'), { recursive: true })
    await writeFile(join(serverDirectory, argsFile), neoArgs)
    const original = opened.db.select().from(localServers).where(eq(localServers.id, server.id)).get()!
    const originalGrant = opened.db.select().from(serverAccessGrants).where(eq(serverAccessGrants.serverId, server.id)).get()
    const originalBackup = opened.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, server.id)).get()
    const preview = await registry.inspectManagedNativeLoader(server.id)
    expect(preview).toMatchObject({ currentSoftware: 'fabric', detection: { software: 'neoforge', loaderVersion: '21.1.184', launch: { kind: 'argfile', argsFile } } })

    await registry.correctManagedNativeLoader({
      serverId: server.id, actorUserId: userId, software: 'neoforge', version: '1.21.1',
      loaderVersion: preview.detection.loaderVersion, launch: preview.detection.launch,
    })
    const corrected = opened.db.select().from(localServers).where(eq(localServers.id, server.id)).get()!
    expect(corrected).toMatchObject({ id: original.id, directory: original.directory, source: 'created', managed: true, software: 'unknown', loader: 'neoforge', version: '1.21.1' })
    expect(corrected.jarName).toBeNull()
    expect(opened.db.select().from(serverAccessGrants).where(eq(serverAccessGrants.serverId, server.id)).get()).toEqual(originalGrant)
    expect(opened.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, server.id)).get()).toEqual(originalBackup)
    expect(await readFile(worldFile, 'utf8')).toBe('preserved world data')
    expect(await readFile(join(serverDirectory, 'server.properties'), 'utf8')).toContain('server-port=25569')
    expect(opened.db.select().from(localServerEvents).where(eq(localServerEvents.action, 'server-software-corrected')).get()).toMatchObject({ serverId: server.id, actorUserId: userId, outcome: 'success' })
  })

  it('requires a detected safe loader and a stopped managed server before correction', async () => {
    const serverDirectory = await makeServer('Correction stopped guard')
    const server = await registry.registerImport({ path: serverDirectory, name: 'Correction stopped guard', minMemoryMb: 1024, maxMemoryMb: 2048 }, userId)
    await opened.db.update(localServers).set({ source: 'created', managed: true }).where(eq(localServers.id, server.id)).run()
    await expect(registry.inspectManagedNativeLoader(server.id)).rejects.toMatchObject({ code: 'loader-not-detected' })
    const argsFile = 'libraries/net/neoforged/neoforge/21.1.184/unix_args.txt'
    await mkdir(join(serverDirectory, argsFile, '..'), { recursive: true })
    await writeFile(join(serverDirectory, argsFile), '-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap')
    await opened.db.insert(localServerRuntime).values({ serverId: server.id, status: 'starting', updatedAt: '2026-11-23T12:00:00.000Z' }).run()
    await expect(registry.inspectManagedNativeLoader(server.id)).rejects.toMatchObject({ code: 'server-running' })
  })

  it('rejects paths outside configured roots, directories that are symlinks, and duplicate registration', async () => {
    const serverDirectory = await makeServer()
    const outside = join(directory, 'outside')
    await mkdir(outside)
    const alias = join(serverRoot, 'linked-server')
    await symlink(outside, alias, 'dir')
    await expect(registry.inspect(outside)).rejects.toMatchObject({ code: 'outside-allowlist' })
    await expect(registry.inspect(alias)).rejects.toMatchObject({ code: 'not-directory' })
    const input = { path: serverDirectory, name: 'Legacy World', minMemoryMb: 1024, maxMemoryMb: 4096 }
    await registry.registerImport(input, userId)
    await expect(registry.registerImport(input, userId)).rejects.toMatchObject({ code: 'duplicate' })
  })

  it('does not follow symlinks for server metadata and bounds property reads', async () => {
    const serverDirectory = await makeServer()
    const externalProperties = join(directory, 'external.properties')
    await writeFile(externalProperties, 'server-port=25580\n')
    await rm(join(serverDirectory, 'server.properties'))
    await symlink(externalProperties, join(serverDirectory, 'server.properties'))
    await expect(registry.inspect(serverDirectory)).rejects.toMatchObject({ code: 'unsafe-file' })

    await rm(join(serverDirectory, 'server.properties'))
    await writeFile(join(serverDirectory, 'server.properties'), 'x'.repeat(65_537))
    await expect(registry.inspect(serverDirectory)).rejects.toMatchObject({ code: 'unsafe-file' })
  })

  it('probes only the supplied executable without a shell and reports its Java major version', async () => {
    const fakeJava = join(directory, 'fake-java')
    await writeFile(fakeJava, '#!/bin/sh\nprintf \'openjdk version "21.0.4" 2024-07-16\\n\' >&2\n')
    await chmod(fakeJava, 0o700)
    await expect(inspectJavaRuntime(fakeJava)).resolves.toMatchObject({
      path: fakeJava,
      version: '21.0.4',
      major: 21,
      vendor: 'OpenJDK',
      source: 'custom',
    })

    const notJava = join(directory, 'not-java')
    await writeFile(notJava, '#!/bin/sh\nprintf \'not a runtime\\n\'\n')
    await chmod(notJava, 0o700)
    await expect(inspectJavaRuntime(notJava)).rejects.toBeInstanceOf(JavaRuntimeError)
  })

  it('keeps discovered Java results in memory only after an explicit scan', async () => {
    const javaRegistry = new JavaRuntimeRegistry(async () => [{
      path: '/test/java-21/bin/java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered',
    }])
    expect(javaRegistry.list()).toEqual([])
    await expect(javaRegistry.scan()).resolves.toMatchObject([{ major: 21, version: '21.0.4' }])
    expect(javaRegistry.list()).toHaveLength(1)
  })

  it('keeps the default app-owned server root private', async () => {
    const defaultRoot = join(directory, 'app-owned', 'servers')
    await mkdir(defaultRoot, { recursive: true, mode: 0o755 })
    await chmod(defaultRoot, 0o755)
    const defaultRegistry = new ServerRegistry(opened.db, join(directory, 'app-owned'), {})
    await defaultRegistry.prepare()
    expect((await lstat(defaultRoot)).mode & 0o777).toBe(0o700)
  })
})
