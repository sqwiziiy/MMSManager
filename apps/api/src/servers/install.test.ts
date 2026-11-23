import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { users } from '../db/schema.js'
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
    expect(script).toContain('-Xms1024M -Xmx2048M -jar server.jar nogui')
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
