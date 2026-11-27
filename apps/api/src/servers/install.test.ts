import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { localServerEvents, users } from '../db/schema.js'
import { openDatabase } from '../db/client.js'
import { JavaRuntimeRegistry } from './java.js'
import { ServerInstallService } from './install.js'
import { ServerRegistry } from './registry.js'

describe('official local server installation', () => {
  let temp: string
  let root: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let servers: ServerRegistry
  let java: JavaRuntimeRegistry
  let userId: string
  const jarBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04, 0x05])
  const sha1 = createHash('sha1').update(jarBytes).digest('hex')

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-install-'))
    root = join(temp, 'servers')
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    servers = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: root })
    await servers.prepare()
    java = new JavaRuntimeRegistry(async () => [])
    const fakeJava = join(temp, 'fake-java')
    await (await import('node:fs/promises')).writeFile(fakeJava, '#!/bin/sh\necho \'openjdk version "21.0.4" 2024-07-16\' >&2\n')
    await chmod(fakeJava, 0o700)
    await java.probe(fakeJava)
    userId = randomUUID()
    const now = new Date().toISOString()
    await opened.db.insert(users).values({ id: userId, username: 'install-test', usernameKey: 'install-test', displayName: 'Install Test', role: 'administrator', passwordHash: 'test-only-hash', createdAt: now, updatedAt: now, passwordChangedAt: now })
  })

  afterEach(async () => {
    opened.native.close()
    await rm(temp, { recursive: true, force: true })
  })

  async function availablePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const listener = createServer()
      listener.once('error', reject)
      listener.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = listener.address()
        if (!address || typeof address === 'string') return reject(new Error('No test port'))
        listener.close((error) => error ? reject(error) : resolvePort(address.port))
      })
    })
  }

  function fetchFixture(actualBytes = jarBytes, manifestUrl = 'https://piston-meta.mojang.com/version.json') {
    return async (input: string | URL): Promise<Response> => {
      const url = String(input)
      if (url === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') {
        return Response.json({ versions: [{ id: '1.21.4', type: 'release', url: manifestUrl }] })
      }
      if (url === manifestUrl) return Response.json({
        id: '1.21.4', javaVersion: { majorVersion: 21 },
        downloads: { server: { url: 'https://piston-data.mojang.com/server.jar', sha1, size: jarBytes.byteLength } },
      })
      if (url === 'https://piston-data.mojang.com/server.jar') {
        return new Response(actualBytes, { status: 200, headers: { 'content-type': 'application/java-archive', 'content-length': String(actualBytes.byteLength) } })
      }
      throw new Error(`Unexpected fixture URL: ${url}`)
    }
  }

  async function waitFor(service: ServerInstallService, id: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const operation = service.get(id)
      if (operation?.status === 'completed' || operation?.status === 'failed') return operation
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    throw new Error('Installation fixture timed out')
  }

  const forgeInstallerBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('official-fixture-forge-installer')])
  const forgeInstallerSha256 = createHash('sha256').update(forgeInstallerBytes).digest('hex')
  function nativeLoaderFetchFixture(input: { checksum?: string; checksumType?: 'sha1'; artifact?: Buffer } = {}) {
    const artifact = input.artifact ?? forgeInstallerBytes
    const checksum = input.checksum ?? createHash(input.checksumType ?? 'sha256').update(artifact).digest('hex')
    return async (request: string | URL): Promise<Response> => {
      const url = String(request)
      if (url === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') return Response.json({ versions: [
        { id: '1.20.1', type: 'release', url: 'https://piston-meta.mojang.com/mc/version-1.20.1.json' },
        { id: '1.21.1', type: 'release', url: 'https://piston-meta.mojang.com/mc/version-1.21.1.json' },
      ] })
      if (url === 'https://piston-meta.mojang.com/mc/version-1.20.1.json') return Response.json({ id: '1.20.1', javaVersion: { majorVersion: 17 } })
      if (url === 'https://piston-meta.mojang.com/mc/version-1.21.1.json') return Response.json({ id: '1.21.1', javaVersion: { majorVersion: 21 } })
      if (url === 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json') return Response.json({ promos: { '1.20.1-recommended': '47.2.0', '1.20.1-latest': '47.3.0' } })
      if (url === 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml') return new Response('<metadata><versioning><versions><version>1.20.1-47.2.0</version><version>1.20.1-47.3.0</version></versions></versioning></metadata>')
      if (url === 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml') return new Response('<metadata><versioning><versions><version>21.1.184</version></versions></versioning></metadata>')
      if (url === 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml') return new Response('<metadata><versioning><versions><version>1.20.1-47.1.106</version></versions></versioning></metadata>')
      const installer = 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar'
      if (url === `${installer}.sha256`) return input.checksumType === 'sha1' ? new Response(null, { status: 404 }) : new Response(`${checksum}  forge-1.20.1-47.2.0-installer.jar\n`)
      if (url === `${installer}.sha1`) return input.checksumType === 'sha1' ? new Response(`${checksum}  forge-1.20.1-47.2.0-installer.jar\n`) : new Response(null, { status: 404 })
      if (url === installer) return new Response(artifact, { headers: { 'content-type': 'application/java-archive', 'content-length': String(artifact.byteLength) } })
      throw new Error(`Unexpected fixture URL: ${url}`)
    }
  }

  it('loads live-format Forge and NeoForge catalog fixtures and installs a checksummed Forge argfile layout', async () => {
    let installerRuns = 0
    const service = new ServerInstallService(opened.db, servers, java, {
      fetch: nativeLoaderFetchFixture(),
      runLoaderInstaller: async ({ workDirectory, onOutput }) => {
        installerRuns += 1
        onOutput('Forge fixture installer started.\n')
        const argsFile = join(workDirectory, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.2.0', 'unix_args.txt')
        await mkdir(join(argsFile, '..'), { recursive: true })
        await writeFile(argsFile, '-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap --launchTarget forgeserver\n')
        onOutput('Forge fixture installer completed successfully.\n')
      },
    })
    const forgeCatalog = await service.catalog('forge', '1.20.1')
    expect(forgeCatalog).toMatchObject({ versions: ['1.20.1'], loaders: ['47.2.0'], experimentalLoaders: ['47.3.0'], requiredJavaMajor: 17 })
    const neoCatalog = await service.catalog('neoforge', '1.21.1')
    expect(neoCatalog).toMatchObject({ versions: ['1.20.1', '1.21.1'], loaders: ['21.1.184'], requiredJavaMajor: 21 })

    const operation = await service.create({
      name: 'Forge Native Fixture', directoryName: 'forge-native-fixture', software: 'forge', version: '1.20.1', loaderVersion: '47.2.0',
      javaPath: java.list()[0]!.path, minMemoryMb: 1024, maxMemoryMb: 3072, port: await availablePort(), eulaAccepted: true,
    }, userId)
    const completed = await waitFor(service, operation.id)
    if (completed.status !== 'completed') throw new Error(`Forge fixture failed: ${JSON.stringify(completed)}`)
    expect(completed).toMatchObject({ status: 'completed', software: 'forge', version: '1.20.1', loaderVersion: '47.2.0', checksumType: 'sha256', installerLog: expect.stringContaining('completed successfully') })
    expect(installerRuns).toBe(1)
    const directory = join(root, 'forge-native-fixture')
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['libraries', 'server.properties', 'eula.txt', 'start.sh']))
    expect((await readdir(directory)).filter((name) => name.endsWith('.jar'))).toEqual([])
    expect(await readFile(join(directory, 'start.sh'), 'utf8')).toContain('@libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt')
    expect(await readFile(join(directory, 'eula.txt'), 'utf8')).toContain('eula=true')
    const registered = (await servers.list()).find((server) => server.name === 'Forge Native Fixture')
    expect(registered).toMatchObject({ software: 'forge', version: '1.20.1', managed: true, eula: 'accepted' })
    expect(completed.artifactSha256).toBe(forgeInstallerSha256)
  })

  it('uses and labels the official SHA-1 checksum only when SHA-256 is unavailable', async () => {
    const service = new ServerInstallService(opened.db, servers, java, {
      fetch: nativeLoaderFetchFixture({ checksumType: 'sha1' }),
      runLoaderInstaller: async ({ workDirectory }) => {
        const argsFile = join(workDirectory, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.2.0', 'unix_args.txt')
        await mkdir(join(argsFile, '..'), { recursive: true })
        await writeFile(argsFile, '-m cpw.mods.bootstraplauncher/cpw.mods.bootstraplauncher.Bootstrap --launchTarget forgeserver\n')
      },
    })
    const operation = await service.create({
      name: 'Forge SHA1 Fixture', directoryName: 'forge-sha1-fixture', software: 'forge', version: '1.20.1', loaderVersion: '47.2.0',
      javaPath: java.list()[0]!.path, minMemoryMb: 1024, maxMemoryMb: 2048, port: await availablePort(), eulaAccepted: true,
    }, userId)
    expect(await waitFor(service, operation.id)).toMatchObject({ status: 'completed', checksumType: 'sha1', software: 'forge', loaderVersion: '47.2.0' })
  })

  it('blocks mismatched provider checksums before running the installer and preserves a failed installer log', async () => {
    const mismatched = new ServerInstallService(opened.db, servers, java, {
      fetch: nativeLoaderFetchFixture({ checksum: '0'.repeat(64) }),
      runLoaderInstaller: async () => { throw new Error('An unverified installer must never run.') },
    })
    const rejected = await mismatched.create({
      name: 'Checksum Fixture', directoryName: 'checksum-fixture', software: 'forge', version: '1.20.1', loaderVersion: '47.2.0',
      javaPath: java.list()[0]!.path, minMemoryMb: 1024, maxMemoryMb: 2048, port: await availablePort(), eulaAccepted: true,
    }, userId)
    expect(await waitFor(mismatched, rejected.id)).toMatchObject({ status: 'failed', error: { code: 'CHECKSUM_MISMATCH' } })
    expect(await readdir(join(root, 'checksum-fixture', `.mmsmanager-install-${rejected.id}`))).toContain('loader-installer.jar.part')

    const failedInstaller = new ServerInstallService(opened.db, servers, java, {
      fetch: nativeLoaderFetchFixture(),
      runLoaderInstaller: async ({ onOutput }) => {
        onOutput('Preparing server files.\n')
        throw Object.assign(new Error('Installer fixture stopped with a diagnostic.'), { code: 'INSTALLER_FAILED' })
      },
    })
    const failed = await failedInstaller.create({
      name: 'Failed Installer Fixture', directoryName: 'failed-installer-fixture', software: 'forge', version: '1.20.1', loaderVersion: '47.2.0',
      javaPath: java.list()[0]!.path, minMemoryMb: 1024, maxMemoryMb: 2048, port: await availablePort(), eulaAccepted: true,
    }, userId)
    expect(await waitFor(failedInstaller, failed.id)).toMatchObject({ status: 'failed', error: { code: 'INSTALLER_FAILED', message: expect.stringContaining('diagnostic') }, installerLog: expect.stringContaining('Preparing server files') })
    expect((await servers.list()).some((server) => server.name === 'Failed Installer Fixture')).toBe(false)
  })

  it('installs only an official fixture, writes safe defaults, and records EULA only when checked', async () => {
    const service = new ServerInstallService(opened.db, servers, java, { fetch: fetchFixture() })
    await service.prepare()
    const port = await availablePort()
    const runtime = java.list()[0]!
    const operation = await service.create({
      name: 'Fixture Vanilla', directoryName: 'fixture-vanilla', software: 'vanilla', version: '1.21.4',
      javaPath: runtime.path, minMemoryMb: 1024, maxMemoryMb: 2048, port, eulaAccepted: false,
    }, userId)
    const completed = await waitFor(service, operation.id)
    expect(completed).toMatchObject({ status: 'completed', progress: 100, software: 'vanilla', artifactSha256: createHash('sha256').update(jarBytes).digest('hex') })
    const directory = join(root, 'fixture-vanilla')
    expect((await readdir(directory)).sort()).toEqual(['eula.txt', 'server.jar', 'server.properties', 'start.sh'])
    expect(await readFile(join(directory, 'eula.txt'), 'utf8')).toContain('eula=false')
    expect(await readFile(join(directory, 'server.properties'), 'utf8')).toContain('server-ip=127.0.0.1')
    const script = await readFile(join(directory, 'start.sh'), 'utf8')
    expect(script).toContain("exec '")
    expect(script).toContain("'-Xms1024M' '-Xmx2048M' '-jar' 'server.jar' 'nogui'")
    expect((await stat(join(directory, 'start.sh'))).mode & 0o777).toBe(0o700)
    expect((await servers.list())[0]).toMatchObject({ source: 'created', managed: true, eula: 'not-accepted', javaMajor: 21, port })
    expect((await service.list())[0]?.artifactSha256).toBe(completed.artifactSha256)

    const acceptedOperation = await service.create({
      name: 'Explicit EULA Fixture', directoryName: 'explicit-eula', software: 'vanilla', version: '1.21.4',
      javaPath: runtime.path, minMemoryMb: 1024, maxMemoryMb: 2048, port: await availablePort(), eulaAccepted: true,
    }, userId)
    const accepted = await waitFor(service, acceptedOperation.id)
    expect(accepted.status).toBe('completed')
    expect(await readFile(join(root, 'explicit-eula', 'eula.txt'), 'utf8')).toContain('eula=true')
    expect((await servers.list()).find((server) => server.name === 'Explicit EULA Fixture')?.eula).toBe('accepted')
  })

  it('rejects checksum mismatches and preserves the panel-created partial directory', async () => {
    const service = new ServerInstallService(opened.db, servers, java, { fetch: fetchFixture(Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9, 9])) })
    await service.prepare()
    const operation = await service.create({
      name: 'Bad Archive', directoryName: 'bad-archive', software: 'vanilla', version: '1.21.4',
      javaPath: java.list()[0]!.path, minMemoryMb: 1024, maxMemoryMb: 2048,
      port: await availablePort(), eulaAccepted: true,
    }, userId)
    const failed = await waitFor(service, operation.id)
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'CHECKSUM_MISMATCH' }, partialDirectory: join(root, 'bad-archive') })
    expect(await readdir(join(root, 'bad-archive'))).toContain('server.jar.part')
    expect(await servers.list()).toHaveLength(0)
  })

  it('cancels an in-flight fixture download and preserves partial bytes without recording an install failure', async () => {
    let artifactRequested!: () => void
    const requested = new Promise<void>((resolve) => { artifactRequested = resolve })
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') return Response.json({ versions: [{ id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/version.json' }] })
      if (url === 'https://piston-meta.mojang.com/version.json') return Response.json({ id: '1.21.4', javaVersion: { majorVersion: 21 }, downloads: { server: { url: 'https://piston-data.mojang.com/server.jar', sha1, size: jarBytes.byteLength } } })
      if (url === 'https://piston-data.mojang.com/server.jar') {
        artifactRequested()
        const signal = init?.signal
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(jarBytes.subarray(0, 4))
            const abort = () => controller.error(new DOMException('Fixture fetch aborted', 'AbortError'))
            if (signal?.aborted) abort()
            else signal?.addEventListener('abort', abort, { once: true })
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'application/java-archive', 'content-length': String(jarBytes.byteLength) } })
      }
      throw new Error(`Unexpected fixture URL: ${url}`)
    }
    const service = new ServerInstallService(opened.db, servers, java, { fetch })
    await service.prepare()
    const operation = await service.create({
      name: 'Cancelled fixture', directoryName: 'cancelled-fixture', software: 'vanilla', version: '1.21.4',
      javaPath: java.list()[0]!.path, minMemoryMb: 1024, maxMemoryMb: 2048, port: await availablePort(), eulaAccepted: true,
    }, userId)
    await requested
    const partialPath = join(root, 'cancelled-fixture', 'server.jar.part')
    let partialBytes = Buffer.alloc(0)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { partialBytes = await readFile(partialPath) } catch { /* Wait until the fixture stream writes its first chunk. */ }
      if (partialBytes.byteLength === 4) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(partialBytes).toEqual(jarBytes.subarray(0, 4))

    service.cancel(operation.id)
    const cancelled = await waitFor(service, operation.id)
    expect(cancelled).toMatchObject({ status: 'failed', error: { code: 'INSTALL_CANCELLED' }, partialDirectory: join(root, 'cancelled-fixture') })
    expect(await readFile(partialPath)).toEqual(jarBytes.subarray(0, 4))
    expect(await servers.list()).toHaveLength(0)
    expect(opened.db.select().from(localServerEvents).all()).toMatchObject([{ action: 'server-install-cancelled', outcome: 'success' }])
  })

  it('blocks untrusted provider metadata before it can fetch an external host', async () => {
    const requested: string[] = []
    const service = new ServerInstallService(opened.db, servers, java, {
      fetch: async (input) => {
        const url = String(input)
        requested.push(url)
        if (url === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') return Response.json({ versions: [{ id: '1.21.4', type: 'release', url: 'https://evil.example/version.json' }] })
        return Response.json({})
      },
    })
    await expect(service.catalog('vanilla', '1.21.4')).rejects.toMatchObject({ code: 'PROVIDER_URL_REJECTED' })
    expect(requested).toEqual([
      'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
      'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    ])
  })

  it('rejects a busy loopback port before creating a managed folder', async () => {
    const listener = createServer()
    const port = await new Promise<number>((resolvePort, reject) => {
      listener.once('error', reject)
      listener.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = listener.address()
        if (!address || typeof address === 'string') return reject(new Error('No test port'))
        resolvePort(address.port)
      })
    })
    try {
      const service = new ServerInstallService(opened.db, servers, java, { fetch: fetchFixture() })
      await service.prepare()
      const operation = await service.create({
        name: 'Port Collision', directoryName: 'port-collision', software: 'vanilla', version: '1.21.4',
        javaPath: java.list()[0]!.path, minMemoryMb: 1024, maxMemoryMb: 2048, port, eulaAccepted: false,
      }, userId)
      expect(await waitFor(service, operation.id)).toMatchObject({ status: 'failed', error: { code: 'PORT_IN_USE' } })
      await expect(readdir(join(root, 'port-collision'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await new Promise<void>((resolveClose) => listener.close(() => resolveClose()))
    }
  })
})
