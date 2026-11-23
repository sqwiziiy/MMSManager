import { createConnection } from 'node:net'
import { and, desc, eq, lt } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServers, localServerStatusSamples } from '../db/schema.js'
import type { ServerStatus } from '@mmsmanager/shared'
import { recordServerResourceSample } from './history.js'

const MAX_FRAME_BYTES = 65_536
const TIMEOUT_MS = 1_500
const MAX_SAMPLES_PER_SERVER = 200

function varInt(value: number): Buffer {
  const bytes: number[] = []
  do {
    let part = value & 0x7f
    value >>>= 7
    if (value) part |= 0x80
    bytes.push(part)
  } while (value)
  return Buffer.from(bytes)
}

function readVarInt(bytes: Buffer, start: number): { value: number; next: number } | null {
  let value = 0
  for (let index = 0; index < 5; index += 1) {
    const part = bytes[start + index]
    if (part === undefined) return null
    value |= (part & 0x7f) << (index * 7)
    if ((part & 0x80) === 0) return { value: value >>> 0, next: start + index + 1 }
  }
  throw new Error('Invalid status frame length')
}

function frame(payload: Buffer): Buffer {
  return Buffer.concat([varInt(payload.length), payload])
}

type Probe = Pick<ServerStatus, 'state' | 'playersOnline' | 'playersMax' | 'versionName' | 'description' | 'latencyMs' | 'errorCode'>

export class ServerStatusError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function parseResponse(payload: Buffer, elapsedMs: number): Probe {
  const packet = readVarInt(payload, 0)
  if (!packet || packet.value !== 0) throw new Error('Unexpected status packet')
  const size = readVarInt(payload, packet.next)
  if (!size || size.value > MAX_FRAME_BYTES || size.next + size.value !== payload.length) throw new Error('Invalid status payload')
  const data: unknown = JSON.parse(payload.subarray(size.next).toString('utf8'))
  if (typeof data !== 'object' || data === null) throw new Error('Invalid status JSON')
  const record = data as Record<string, unknown>
  const players = record['players'] as Record<string, unknown> | undefined
  const version = record['version'] as Record<string, unknown> | undefined
  const online = Number(players?.['online'])
  const maximum = Number(players?.['max'])
  if (!Number.isSafeInteger(online) || !Number.isSafeInteger(maximum) || online < 0 || maximum < 0 || online > 1_000_000 || maximum > 1_000_000) {
    throw new Error('Invalid player counts')
  }
  const rawDescription = record['description']
  const description = typeof rawDescription === 'string' ? rawDescription
    : rawDescription && typeof rawDescription === 'object' && typeof (rawDescription as Record<string, unknown>)['text'] === 'string'
      ? String((rawDescription as Record<string, unknown>)['text']) : null
  return {
    state: 'reachable', playersOnline: online, playersMax: maximum,
    versionName: typeof version?.['name'] === 'string' ? version['name'].slice(0, 120) : null,
    description: description?.slice(0, 256) ?? null, latencyMs: elapsedMs, errorCode: null,
  }
}

export function queryJavaStatus(port: number): Promise<Probe> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return Promise.resolve({ state: 'unavailable', playersOnline: null, playersMax: null, versionName: null, description: null, latencyMs: null, errorCode: 'port-unavailable' })
  return new Promise((resolve) => {
    const began = Date.now()
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    let buffer = Buffer.alloc(0)
    const finish = (result: Probe) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    const failed = (code: string) => finish({ state: 'unreachable', playersOnline: null, playersMax: null, versionName: null, description: null, latencyMs: null, errorCode: code })
    socket.setTimeout(TIMEOUT_MS, () => failed('timeout'))
    socket.on('error', () => failed('network'))
    socket.on('end', () => failed('closed'))
    socket.on('connect', () => {
      const portBytes = Buffer.alloc(2)
      portBytes.writeUInt16BE(port)
      const host = Buffer.from('localhost', 'utf8')
      const handshake = Buffer.concat([varInt(0), varInt(47), varInt(host.length), host, portBytes, varInt(1)])
      socket.write(Buffer.concat([frame(handshake), frame(Buffer.from([0]))]))
    })
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      if (buffer.length + chunk.length > MAX_FRAME_BYTES + 5) return failed('oversized-response')
      buffer = Buffer.concat([buffer, chunk])
      try {
        const length = readVarInt(buffer, 0)
        if (!length) return
        if (length.value > MAX_FRAME_BYTES) return failed('oversized-response')
        if (buffer.length < length.next + length.value) return
        finish(parseResponse(buffer.subarray(length.next, length.next + length.value), Date.now() - began))
      } catch { failed('invalid-response') }
    })
  })
}

export class ServerStatusService {
  private readonly pending = new Map<string, Promise<ServerStatus>>()
  private readonly cache = new Map<string, { at: number; status: ServerStatus }>()

  constructor(private readonly db: AppDatabase, private readonly now: () => number = Date.now) {}

  get(serverId: string): Promise<ServerStatus> {
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) return Promise.reject(new ServerStatusError('SERVER_NOT_FOUND', 'Registered server not found.'))
    const cached = this.cache.get(serverId)
    if (cached && this.now() - cached.at < 5_000) return Promise.resolve(cached.status)
    const pending = this.pending.get(serverId)
    if (pending) return pending
    const work = this.probe(serverId, server.port)
    this.pending.set(serverId, work)
    void work.then(() => this.pending.delete(serverId), () => this.pending.delete(serverId))
    return work
  }

  private async probe(serverId: string, port: number | null): Promise<ServerStatus> {
    const result = port ? await queryJavaStatus(port) : {
      state: 'unavailable' as const, playersOnline: null, playersMax: null,
      versionName: null, description: null, latencyMs: null, errorCode: 'port-unavailable',
    }
    const checkedAt = new Date(this.now()).toISOString()
    const status: ServerStatus = { serverId, checkedAt, source: 'local-status-ping', authoritativePlayerList: false, ...result }
    if (status.state !== 'unavailable') {
      this.db.insert(localServerStatusSamples).values({
        serverId, checkedAt, state: status.state, playersOnline: status.playersOnline,
        playersMax: status.playersMax, versionName: status.versionName, description: status.description,
        latencyMs: status.latencyMs, errorCode: status.errorCode, source: status.source,
      }).run()
      recordServerResourceSample(this.db, serverId, checkedAt, { playersOnline: status.playersOnline, playersMax: status.playersMax })
      const oldest = this.db.select({ id: localServerStatusSamples.id }).from(localServerStatusSamples)
        .where(eq(localServerStatusSamples.serverId, serverId)).orderBy(desc(localServerStatusSamples.id))
        .limit(1).offset(MAX_SAMPLES_PER_SERVER - 1).get()
      if (oldest) this.db.delete(localServerStatusSamples).where(and(eq(localServerStatusSamples.serverId, serverId), lt(localServerStatusSamples.id, oldest.id))).run()
    }
    this.cache.set(serverId, { at: this.now(), status })
    return status
  }
}
