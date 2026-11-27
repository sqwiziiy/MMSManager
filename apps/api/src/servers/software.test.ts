import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { localServerBackups, localServerEvents, localServerRuntime, localServers, users } from '../db/schema.js'
import { JavaRuntimeRegistry } from './java.js'
import { ServerProcessManager } from './processes.js'
import { ServerRegistry } from './registry.js'
import { ServerBackupService } from './backups.js'
import { ServerInstallService } from './install.js'
import { ServerSoftwareError, ServerSoftwareService } from './software.js'

describe('managed server software changes', () => {
  let temp: string
  let root: string
  let serverDirectory: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let servers: ServerRegistry
  let processes: ServerProcessManager
  let backups: ServerBackupService
  let installs: ServerInstallService
  let software: ServerSoftwareService
  let java: JavaRuntimeRegistry
  let actorId: string
  let serverId: string
  const jarBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5])
  const sha1 = createHash('sha1').update(jarBytes).digest('hex')

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-software-'))
    root = join(temp, 'servers')
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    servers = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: root })
    await servers.prepare()
    processes = new ServerProcessManager(opened.db, servers)
    await processes.prepare()
    backups = new ServerBackupService(opened.db, servers, processes)
    await backups.prepare()
    java = new JavaRuntimeRegistry(async () => [])
    const fakeJava = join(temp, 'fake-java')
    await writeFile(fakeJava, '#!/bin/sh\necho \'openjdk version "21.0.4" 2024-07-16\' >&2\n')
    await chmod(fakeJava, 0o700)
    await java.probe(fakeJava)
    const fetch = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') return Response.json({ versions: [{ id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/version.json' }] })
      if (url === 'https://piston-meta.mojang.com/version.json') return Response.json({ id: '1.21.4', javaVersion: { majorVersion: 21 }, downloads: { server: { url: 'https://piston-data.mojang.com/server.jar', size: jarBytes.byteLength, sha1 } } })
      if (url === 'https://piston-data.mojang.com/server.jar') return new Response(jarBytes, { headers: { 'content-type': 'application/java-archive', 'content-length': String(jarBytes.byteLength) } })
      throw new Error(`Unexpected software replacement fixture URL: ${url}`)
    }
    installs = new ServerInstallService(opened.db, servers, java, { fetch })
    software = new ServerSoftwareService(opened.db, servers, processes, backups, installs)
    actorId = randomUUID()
    serverId = randomUUID()
    const at = new Date().toISOString()
    await opened.db.insert(users).values({ id: actorId, username: 'software-admin', usernameKey: 'software-admin', displayName: 'Software Admin', role: 'administrator', passwordHash: 'fixture-only', createdAt: at, updatedAt: at, passwordChangedAt: at }).run()
    serverDirectory = join(root, 'managed-software-fixture')
    await mkdir(join(serverDirectory, 'mods'), { recursive: true })
    await mkdir(join(serverDirectory, 'world'), { recursive: true })
    await writeFile(join(serverDirectory, 'server.jar'), 'previous server core')
    await writeFile(join(serverDirectory, 'start.sh'), '#!/bin/sh\n# previous core launcher\n')
    await writeFile(join(serverDirectory, 'server.properties'), 'server-port=25601\nlevel-name=world\n')
    await writeFile(join(serverDirectory, 'world', 'level.dat'), 'world data stays')
    await writeFile(join(serverDirectory, 'mods', 'example.jar'), 'mod stays')
    await opened.db.insert(localServers).values({
      id: serverId, name: 'Software Fixture', directory: serverDirectory, source: 'created', software: 'paper', loader: null,
      version: '1.21.4', jarName: 'server.jar', javaPath: java.list()[0]!.path, javaMajor: 21, requiredJavaMajor: 21,
      minMemoryMb: 512, maxMemoryMb: 2048, jvmOptionsJson: '{"collector":"default","maxGCPauseMs":null,"parallelGcThreads":null,"alwaysPreTouch":false,"disableExplicitGc":false}',
      startScriptSha256: null, port: 25601, eula: 'accepted', managed: true, worldFolders: '["world"]', createdBy: actorId, createdAt: at, updatedAt: at,
    }).run()
    await opened.db.insert(localServerRuntime).values({ serverId, status: 'stopped', processPid: null, processStartMarker: null, processBootId: null, startedAt: null, updatedAt: at, lastExitCode: null, errorMessage: null, restartRequired: false }).run()
  })

  afterEach(async () => {
    opened.native.close()
    await rm(temp, { recursive: true, force: true })
  })

  it('creates a verified pre-change backup, replaces only the server core and restores the previous core on rollback', async () => {
    const originalWorld = await readFile(join(serverDirectory, 'world', 'level.dat'))
    const originalMod = await readFile(join(serverDirectory, 'mods', 'example.jar'))
    const result = await software.replace(serverId, { software: 'vanilla', version: '1.21.4', confirmation: 'Software Fixture', compatibilityAcknowledged: true }, actorId)
    expect(result).toMatchObject({ serverId, software: 'vanilla', version: '1.21.4' })
    expect(await opened.db.select().from(localServerBackups).where(eq(localServerBackups.id, result.backupId)).get()).toMatchObject({ serverId, kind: 'manual', origin: 'manual' })
    expect(await readFile(join(serverDirectory, 'server.jar'))).toEqual(jarBytes)
    expect(await readFile(join(serverDirectory, 'world', 'level.dat'))).toEqual(originalWorld)
    expect(await readFile(join(serverDirectory, 'mods', 'example.jar'))).toEqual(originalMod)
    expect(await opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get()).toMatchObject({ software: 'vanilla', loader: null, version: '1.21.4', jarName: 'server.jar', managed: true })
    expect((await software.inspect(serverId)).rollbackAvailable).toBe(true)
    const replacementEvent = (await opened.db.select().from(localServerEvents).where(eq(localServerEvents.serverId, serverId)).all()).find((event) => event.action === 'server-software-replaced')
    expect(replacementEvent?.action).toBe('server-software-replaced')
    await opened.db.insert(localServerEvents).values({
      serverId, actorUserId: actorId, action: 'server-software-recovery-required', outcome: 'failure',
      occurredAt: new Date(Date.now() - 1).toISOString(), detail: replacementEvent!.detail,
    }).run()
    expect((await software.inspect(serverId)).rollbackAvailable).toBe(true)
    const rollbackId = (JSON.parse(replacementEvent!.detail) as { rollbackId: string }).rollbackId
    const rollbackDirectory = join(serverDirectory, '.mmsmanager', 'software-rollback', rollbackId)
    const forwardDirectory = join(rollbackDirectory, 'forward-core')
    await mkdir(forwardDirectory)
    await rename(join(serverDirectory, 'server.jar'), join(forwardDirectory, 'server.jar'))
    await rename(join(rollbackDirectory, 'server.jar'), join(serverDirectory, 'server.jar'))
    expect(await software.rollback(serverId, 'Software Fixture', actorId)).toMatchObject({ serverId, rolledBackTo: 'paper', version: '1.21.4' })
    expect(await readFile(join(serverDirectory, 'server.jar'), 'utf8')).toBe('previous server core')
    expect(await readFile(join(serverDirectory, 'start.sh'), 'utf8')).toContain('previous core launcher')
    expect(await readFile(join(serverDirectory, 'world', 'level.dat'))).toEqual(originalWorld)
    expect(await readFile(join(serverDirectory, 'mods', 'example.jar'))).toEqual(originalMod)
    expect(await opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get()).toMatchObject({ software: 'paper', loader: null, version: '1.21.4', jarName: 'server.jar' })
    expect((await software.inspect(serverId)).rollbackAvailable).toBe(false)
    expect((await opened.db.select().from(localServerEvents).where(eq(localServerEvents.serverId, serverId)).all()).map((event) => event.action)).toEqual(expect.arrayContaining(['server-software-replaced', 'server-software-rolled-back']))
  })

  it('does not replace any core files if the official artifact fails validation', async () => {
    const previousJar = await readFile(join(serverDirectory, 'server.jar'))
    const badArtifact = Buffer.from('not an archive')
    const badSha1 = createHash('sha1').update(badArtifact).digest('hex')
    const invalidFetch = async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') return Response.json({ versions: [{ id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/version.json' }] })
      if (url === 'https://piston-meta.mojang.com/version.json') return Response.json({ id: '1.21.4', javaVersion: { majorVersion: 21 }, downloads: { server: { url: 'https://piston-data.mojang.com/server.jar', size: badArtifact.byteLength, sha1: badSha1 } } })
      if (url === 'https://piston-data.mojang.com/server.jar') return new Response(badArtifact, { headers: { 'content-type': 'application/java-archive', 'content-length': String(badArtifact.byteLength) } })
      throw new Error(`Unexpected invalid artifact fixture URL: ${url}`)
    }
    installs = new ServerInstallService(opened.db, servers, java, { fetch: invalidFetch })
    software = new ServerSoftwareService(opened.db, servers, processes, backups, installs)
    await expect(software.replace(serverId, { software: 'vanilla', version: '1.21.4', confirmation: 'Software Fixture', compatibilityAcknowledged: true }, actorId)).rejects.toMatchObject({ code: 'ARTIFACT_TYPE_REJECTED' })
    expect(await readFile(join(serverDirectory, 'server.jar'))).toEqual(previousJar)
    expect(await readFile(join(serverDirectory, 'world', 'level.dat'), 'utf8')).toBe('world data stays')
    expect(await opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get()).toMatchObject({ software: 'paper', jarName: 'server.jar' })
    expect((await opened.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, serverId)).all())).toHaveLength(1)
    expect((await software.inspect(serverId)).rollbackAvailable).toBe(false)
  })

  it('restores the previous core if a later replacement step fails after staging', async () => {
    await opened.db.update(localServers).set({ jvmOptionsJson: 'invalid-json' }).where(eq(localServers.id, serverId)).run()
    const previousJar = await readFile(join(serverDirectory, 'server.jar'))
    const previousStart = await readFile(join(serverDirectory, 'start.sh'))

    await expect(software.replace(serverId, {
      software: 'vanilla', version: '1.21.4', confirmation: 'Software Fixture', compatibilityAcknowledged: true,
    }, actorId)).rejects.toMatchObject({ code: 'SOFTWARE_CHANGE_FAILED' })

    expect(await readFile(join(serverDirectory, 'server.jar'))).toEqual(previousJar)
    expect(await readFile(join(serverDirectory, 'start.sh'))).toEqual(previousStart)
    expect(await readFile(join(serverDirectory, 'world', 'level.dat'), 'utf8')).toBe('world data stays')
    expect(await readFile(join(serverDirectory, 'mods', 'example.jar'), 'utf8')).toBe('mod stays')
    expect(await opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get()).toMatchObject({
      software: 'paper', version: '1.21.4', jarName: 'server.jar',
    })
    expect((await opened.db.select().from(localServerBackups).where(eq(localServerBackups.serverId, serverId)).all())).toHaveLength(1)
    expect((await software.inspect(serverId)).rollbackAvailable).toBe(false)
  })

  it('requires the exact server confirmation and admin-managed stopped folder', async () => {
    await expect(software.replace(serverId, { software: 'vanilla', version: '1.21.4', confirmation: 'wrong', compatibilityAcknowledged: true }, actorId)).rejects.toBeInstanceOf(ServerSoftwareError)
    await expect(software.rollback(serverId, 'Software Fixture', actorId)).rejects.toMatchObject({ code: 'SOFTWARE_ROLLBACK_UNAVAILABLE' })
    expect(await readFile(join(serverDirectory, 'server.jar'), 'utf8')).toBe('previous server core')
  })
})
