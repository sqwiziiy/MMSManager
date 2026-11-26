import { createConnection } from 'node:net'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServers, localServerRuntime, localServerStatusSamples } from '../db/schema.js'
import type { DashboardPlayerSummary, ServerStatus } from '@mmsmanager/shared'
import { recordServerResourceSample } from './history.js'
import type { ServerRegistry } from './registry.js'

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

export type ServerStatusProbe = Pick<ServerStatus, 'state' | 'playersOnline' | 'playersMax' | 'versionName' | 'description' | 'latencyMs' | 'errorCode'>

export class ServerStatusError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function parseResponse(payload: Buffer, elapsedMs: number): ServerStatusProbe {
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

export function queryJavaStatus(port: number): Promise<ServerStatusProbe> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return Promise.resolve({ state: 'unavailable', playersOnline: null, playersMax: null, versionName: null, description: null, latencyMs: null, errorCode: 'port-unavailable' })
  return new Promise((resolve) => {
    const began = Date.now()
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    let buffer = Buffer.alloc(0)
    const finish = (result: ServerStatusProbe) => {
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
  private readonly pending = new Map<string, { signature: string; promise: Promise<ServerStatus> }>()
  private readonly cache = new Map<string, { at: number; status: ServerStatus }>()
  private pollIntervalMs = 5_000
  private summaryPending: Promise<DashboardPlayerSummary> | null = null
  private summaryCache: { at: number; summary: DashboardPlayerSummary } | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
    private readonly probeStatus: (port: number) => Promise<ServerStatusProbe> = queryJavaStatus,
    private readonly servers?: ServerRegistry,
  ) {}

  configurePollInterval(intervalMs: number): void {
    this.pollIntervalMs = Math.max(5_000, Math.min(30_000, Math.floor(intervalMs)))
  }

  invalidate(serverId?: string): void {
    this.summaryCache = null
    if (serverId) this.cache.delete(serverId)
    else this.cache.clear()
  }

  async get(serverId: string): Promise<ServerStatus> {
    await this.servers?.refreshPortConfigurations()
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) throw new ServerStatusError('SERVER_NOT_FOUND', 'Registered server not found.')
    const configuration = this.servers
      ? await this.servers.getPortConfiguration(serverId)
      : { port: server.port, status: server.port === null ? 'missing' as const : 'valid' as const, errorCode: server.port === null ? 'PORT_PROPERTY_MISSING' as const : null }
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    const activeRuntime = runtime && ['starting', 'running', 'stopping', 'external/unmanaged'].includes(runtime.status)
    const processPort = activeRuntime ? runtime.processPort ?? null : null
    const managedProcess = server.source === 'created' && server.managed
    const processPortUnknown = Boolean(managedProcess && runtime && ['running', 'external/unmanaged'].includes(runtime.status) && processPort === null)
    const restartRequired = Boolean(runtime?.restartRequired || processPortUnknown || (processPort !== null && processPort !== configuration.port))
    const cached = this.cache.get(serverId)
    if (cached && this.now() - cached.at < this.pollIntervalMs
      && cached.status.configuredPort === configuration.port
      && cached.status.processPort === processPort
      && cached.status.portStatus === configuration.status
      && cached.status.restartRequired === restartRequired) return cached.status
    const signature = `${configuration.port ?? ''}:${processPort ?? ''}:${configuration.status}:${restartRequired}`
    const pending = this.pending.get(serverId)
    if (pending?.signature === signature) return pending.promise
    if (pending) return pending.promise.then(() => this.get(serverId), () => this.get(serverId))
    const unavailableCode = configuration.errorCode === 'PORT_FILE_MISSING' ? 'port-file-missing'
      : configuration.errorCode === 'PORT_FILE_UNREADABLE' ? 'port-file-unreadable'
        : configuration.errorCode === 'PORT_PROPERTY_MISSING' ? 'port-property-missing'
          : configuration.errorCode === 'PORT_VALUE_INVALID' ? 'port-invalid' : 'port-unavailable'
    const work = this.probe(serverId, processPort ?? configuration.port, {
      configuredPort: configuration.port, processPort, portStatus: configuration.status,
      portErrorCode: configuration.errorCode, restartRequired, unavailableCode,
    })
    this.pending.set(serverId, { signature, promise: work })
    const clearPending = () => { if (this.pending.get(serverId)?.promise === work) this.pending.delete(serverId) }
    void work.then(clearPending, clearPending)
    return work
  }

  async getPlayerSummary(visibleServerIds?: string[]): Promise<DashboardPlayerSummary> {
    await this.servers?.refreshPortConfigurations()
    if (visibleServerIds !== undefined) return this.collectPlayerSummary(visibleServerIds)
    if (this.summaryCache && this.now() - this.summaryCache.at < this.pollIntervalMs) {
      return Promise.resolve(this.summaryCache.summary)
    }
    if (this.summaryPending) return this.summaryPending
    const work = this.collectPlayerSummary().then((summary) => {
      this.summaryCache = { at: this.now(), summary }
      return summary
    }).finally(() => { this.summaryPending = null })
    this.summaryPending = work
    return work
  }

  private async collectPlayerSummary(visibleServerIds?: string[]): Promise<DashboardPlayerSummary> {
    await this.servers?.refreshPortConfigurations()
    if (visibleServerIds !== undefined && visibleServerIds.length === 0) {
      return { playersOnline: 0, complete: true, registeredServerCount: 0, pollIntervalMs: this.pollIntervalMs, checkedAt: new Date(this.now()).toISOString() }
    }
    const servers = this.db.select({ id: localServers.id, source: localServers.source, managed: localServers.managed, port: localServers.port })
      .from(localServers).where(visibleServerIds === undefined ? undefined : inArray(localServers.id, visibleServerIds)).all()
    const checkedAt = new Date(this.now()).toISOString()
    if (servers.length === 0) return { playersOnline: 0, complete: true, registeredServerCount: 0, pollIntervalMs: this.pollIntervalMs, checkedAt }

    const runtimes = new Map(this.db.select({ serverId: localServerRuntime.serverId, status: localServerRuntime.status, processPort: localServerRuntime.processPort })
      .from(localServerRuntime).all().map((runtime) => [runtime.serverId, runtime]))
    const ports = new Map<number, string>()
    let unknown = false
    for (const server of servers) {
      const runtime = runtimes.get(server.id)
      if (server.source === 'created' && server.managed && runtime?.status === 'stopped') continue
      const active = runtime && ['starting', 'running', 'stopping', 'external/unmanaged'].includes(runtime.status) ? runtime.processPort : null
      const port = active ?? server.port
      if (port === null) { unknown = true; continue }
      if (!ports.has(port)) ports.set(port, server.id)
    }
    if (ports.size === 0) {
      return { playersOnline: unknown ? null : 0, complete: !unknown, registeredServerCount: servers.length, pollIntervalMs: this.pollIntervalMs, checkedAt }
    }

    const queue = [...ports.values()]
    let cursor = 0
    let observed = 0
    let playersOnline = 0
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (cursor < queue.length) {
        const serverId = queue[cursor++]!
        try {
          const status = await this.get(serverId)
          if (status.state !== 'reachable' || status.playersOnline === null) unknown = true
          else { observed += 1; playersOnline += status.playersOnline }
        } catch { unknown = true }
      }
    })
    await Promise.all(workers)
    return {
      playersOnline: observed > 0 ? playersOnline : null,
      complete: !unknown,
      registeredServerCount: servers.length,
      pollIntervalMs: this.pollIntervalMs,
      checkedAt: new Date(this.now()).toISOString(),
    }
  }

  private async probe(serverId: string, port: number | null, configuration: {
    configuredPort: number | null
    processPort: number | null
    portStatus: ServerStatus['portStatus']
    portErrorCode: ServerStatus['portErrorCode']
    restartRequired: boolean
    unavailableCode: string
  }): Promise<ServerStatus> {
    const result = port !== null ? await this.probeStatus(port) : {
      state: 'unavailable' as const, playersOnline: null, playersMax: null,
      versionName: null, description: null, latencyMs: null, errorCode: configuration.unavailableCode,
    }
    const checkedAt = new Date(this.now()).toISOString()
    const status: ServerStatus = {
      serverId, checkedAt, source: 'local-status-ping', authoritativePlayerList: false,
      configuredPort: configuration.configuredPort, processPort: configuration.processPort,
      portStatus: configuration.portStatus, portErrorCode: configuration.portErrorCode,
      restartRequired: configuration.restartRequired, ...result,
    }
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
