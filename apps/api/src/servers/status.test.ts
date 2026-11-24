import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { localServers, localServerRuntime, localServerStatusSamples } from '../db/schema.js'
import { queryJavaStatus, ServerStatusService, type ServerStatusProbe } from './status.js'

function varInt(value: number): Buffer {
  const bytes: number[] = []
  do { let part = value & 0x7f; value >>>= 7; if (value) part |= 0x80; bytes.push(part) } while (value)
  return Buffer.from(bytes)
}

function statusFrame(): Buffer {
  const json = Buffer.from(JSON.stringify({ version: { name: 'Paper 1.21.4', protocol: 769 }, players: { online: 3, max: 20, sample: [{ name: 'Unverified', id: randomUUID() }] }, description: { text: 'Fixture server' } }))
  const payload = Buffer.concat([Buffer.from([0]), varInt(json.length), json])
  return Buffer.concat([varInt(payload.length), payload])
}

async function fixtureServer(reply: Buffer | null): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.once('data', () => {
    if (reply) socket.end(reply)
    else socket.end()
  }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture port missing')
  return { server, port: address.port }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe('bounded local Minecraft status ping', () => {
  it('reads real framed counts, ignores unverified sample identities and persists one bounded-source sample', async () => {
    const fixture = await fixtureServer(statusFrame())
    const temp = await mkdtemp(join(tmpdir(), 'mmsmanager-status-'))
    const opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    try {
      const id = randomUUID()
      const now = new Date().toISOString()
      opened.db.insert(localServers).values({
        id, name: 'Local ping fixture', directory: join(temp, 'server'), source: 'imported',
        software: 'paper', version: '1.21.4', jarName: null, javaPath: null, javaMajor: null,
        minMemoryMb: 512, maxMemoryMb: 1024, port: fixture.port, eula: 'unknown', managed: false,
        worldFolders: '[]', createdBy: null, createdAt: now, updatedAt: now,
      }).run()
      const service = new ServerStatusService(opened.db)
      const result = await service.get(id)
      expect(result).toMatchObject({ state: 'reachable', playersOnline: 3, playersMax: 20, authoritativePlayerList: false, source: 'local-status-ping' })
      expect(JSON.stringify(result)).not.toContain('Unverified')
      expect(await service.get(id)).toEqual(result)
      expect(opened.db.select().from(localServerStatusSamples).where(eq(localServerStatusSamples.serverId, id)).all()).toHaveLength(1)
    } finally {
      opened.native.close()
      await closeServer(fixture.server)
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('reports closed and oversized responses as unavailable without trusting their contents', async () => {
    const closed = await fixtureServer(null)
    const oversized = await fixtureServer(Buffer.from([0xff, 0xff, 0x04]))
    try {
      expect(await queryJavaStatus(closed.port)).toMatchObject({ state: 'unreachable', errorCode: 'closed', playersOnline: null })
      expect(await queryJavaStatus(oversized.port)).toMatchObject({ state: 'unreachable', errorCode: 'oversized-response', playersOnline: null })
      expect(await queryJavaStatus(0)).toMatchObject({ state: 'unavailable', errorCode: 'port-unavailable' })
    } finally {
      await closeServer(closed.server)
      await closeServer(oversized.server)
    }
  })

  it('aggregates only registered ports, counts duplicate ports once, and distinguishes unknown from zero', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mmsmanager-player-summary-'))
    const opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    let now = Date.parse('2026-11-24T12:00:00.000Z')
    let probes = 0
    const probe = async (port: number): Promise<ServerStatusProbe> => {
      probes += 1
      return { state: 'reachable', playersOnline: port === 25565 ? 3 : 2, playersMax: 20, versionName: 'Fixture', description: null, latencyMs: 1, errorCode: null }
    }
    const service = new ServerStatusService(opened.db, () => now, probe)
    const addServer = (input: { port: number | null; source?: 'created' | 'imported'; managed?: boolean; runtime?: 'stopped' | 'running' }) => {
      const id = randomUUID()
      const at = new Date(now).toISOString()
      opened.db.insert(localServers).values({
        id, name: `Fixture ${id.slice(0, 4)}`, directory: join(temp, id), source: input.source ?? 'created', software: 'paper',
        version: '1.21.4', jarName: null, javaPath: null, javaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024,
        port: input.port, eula: 'accepted', managed: input.managed ?? true, worldFolders: '[]', createdBy: null, createdAt: at, updatedAt: at,
      }).run()
      if (input.runtime) opened.db.insert(localServerRuntime).values({
        serverId: id, status: input.runtime, processPid: null, processStartMarker: null, processBootId: null,
        startedAt: null, updatedAt: at, lastExitCode: null, errorMessage: null, restartRequired: false,
      }).run()
      return id
    }
    try {
      const empty = await service.getPlayerSummary()
      expect(empty).toMatchObject({ playersOnline: 0, complete: true, registeredServerCount: 0, pollIntervalMs: 5_000 })

      const stoppedId = addServer({ port: 25565, runtime: 'stopped' })
      now += 10_001
      const stopped = await service.getPlayerSummary()
      expect(stopped).toMatchObject({ playersOnline: 0, complete: true, registeredServerCount: 1 })
      expect(probes).toBe(0)

      opened.db.delete(localServers).where(eq(localServers.id, stoppedId)).run()
      const first = addServer({ port: 25565, runtime: 'running' })
      addServer({ port: 25565, source: 'imported', managed: false })
      addServer({ port: 25566, runtime: 'running' })
      service.configurePollInterval(10_000)
      now += 10_001
      const summary = await service.getPlayerSummary()
      expect(summary).toMatchObject({ playersOnline: 5, complete: true, registeredServerCount: 3, pollIntervalMs: 10_000 })
      expect(probes).toBe(2)
      expect(await service.get(first)).toMatchObject({ state: 'reachable' })

      opened.db.delete(localServers).run()
      addServer({ port: null, runtime: 'running' })
      now += 10_001
      const unknown = await service.getPlayerSummary()
      expect(unknown).toMatchObject({ playersOnline: null, complete: false, registeredServerCount: 1 })
    } finally {
      opened.native.close()
      await rm(temp, { recursive: true, force: true })
    }
  })
})
