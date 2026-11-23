import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, open, lstat, readFile, realpath, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join, resolve } from 'node:path'
import { asc, desc, eq, gt, lt, and } from 'drizzle-orm'
import type { FileHandle } from 'node:fs/promises'
import type { AppDatabase } from '../db/client.js'
import { localServerConsoleEntries, localServerEvents, localServerRuntime, localServers } from '../db/schema.js'
import type { ServerRuntime, ServerConsoleEntry } from '@mmsmanager/shared'
import type { ServerRegistry } from './registry.js'
import { isLoopbackPortAvailable } from './install.js'

const MAX_LOG_SEGMENT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_RAW_LOG_BYTES = 256 * 1024 * 1024
const MAX_LINE_BYTES = 8192
const MAX_CONSOLE_ENTRIES = 5000

type OutputStream = 'stdout' | 'stderr'
type LogSegment = { handle: FileHandle; index: number; size: number }
type ManagedProcess = {
  child: ChildProcessWithoutNullStreams
  launchId: string
  stopRequested: boolean
  spawnFailed: boolean
  rawLogCapNotified: boolean
  closePromise: Promise<void>
  spawnRecorded: Promise<void>
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  stdoutPending: string
  stderrPending: string
  segments: Record<OutputStream, LogSegment | null>
  writeQueues: Record<OutputStream, Promise<void>>
}

export class ServerProcessError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function isFsError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function severityFor(line: string, stream: OutputStream): 'info' | 'warn' | 'error' | 'debug' {
  if (/\b(error|exception|fatal|failed)\b/i.test(line)) return 'error'
  if (/\b(warn|warning)\b/i.test(line)) return 'warn'
  if (/\b(debug|trace)\b/i.test(line)) return 'debug'
  return stream === 'stderr' ? 'warn' : 'info'
}

async function readBootId(): Promise<string> {
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
}

async function readProcessStartMarker(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const fields = stat.slice(close + 1).trim().split(/\s+/)
    return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null
  } catch (error) {
    if (isFsError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

async function readProcessRssBytes(pid: number): Promise<number | null> {
  try {
    const statm = (await readFile(`/proc/${pid}/statm`, 'utf8')).trim().split(/\s+/)
    const residentPages = Number(statm[1])
    if (!Number.isSafeInteger(residentPages) || residentPages < 0) return null
    return residentPages * 4096
  } catch (error) {
    if (isFsError(error) && error.code === 'ENOENT') return null
    return null
  }
}

export class ServerProcessManager {
  private readonly children = new Map<string, ManagedProcess>()
  private readonly starting = new Set<string>()
  private readonly logsDirectory: string
  private readonly commandTimes = new Map<string, number[]>()
  private bootId = ''
  private rawLogQueue: Promise<void> = Promise.resolve()
  private totalRawLogBytes = 0

  constructor(
    private readonly db: AppDatabase,
    private readonly servers: ServerRegistry,
    private readonly now: () => number = Date.now,
  ) {
    this.logsDirectory = join(servers.dataDirectory, 'server-logs')
  }

  async prepare(): Promise<void> {
    await mkdir(this.logsDirectory, { recursive: true, mode: 0o700 })
    const directoryStat = await lstat(this.logsDirectory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('The private server log directory must be a real directory.')
    await chmod(this.logsDirectory, 0o700)
    for (const entry of await readdir(this.logsDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const stat = await lstat(join(this.logsDirectory, entry.name))
      if (stat.isFile() && !stat.isSymbolicLink()) this.totalRawLogBytes += stat.size
    }
    this.totalRawLogBytes = Math.min(this.totalRawLogBytes, MAX_TOTAL_RAW_LOG_BYTES)
    this.bootId = await readBootId()
    const rows = this.db.select().from(localServerRuntime).all()
    for (const row of rows) {
      if (row.status === 'stopped' || row.status === 'crashed' || row.status === 'error' || row.status === 'external/unmanaged') continue
      const marker = row.processPid ? await readProcessStartMarker(row.processPid) : null
      if (!row.processPid || !row.processStartMarker || !row.processBootId) {
        await this.updateRuntime(row.serverId, { status: 'external/unmanaged', errorMessage: 'The previous process identity is incomplete after the API restart. MMSManager did not adopt or control it.' })
        await this.event(row.serverId, null, 'server-process-externalized', 'failure', 'The previous process identity could not be verified after the API restart.')
        continue
      }
      if (marker && marker === row.processStartMarker && row.processBootId === this.bootId) {
        await this.updateRuntime(row.serverId, {
          status: 'external/unmanaged', errorMessage: 'The API restarted while this process was running. MMSManager did not adopt or control it.',
        })
        await this.event(row.serverId, null, 'server-process-externalized', 'success', 'The previous panel process is running without an active MMSManager process handle.')
      } else {
        await this.updateRuntime(row.serverId, {
          status: 'crashed', processPid: null, processStartMarker: null, processBootId: null,
          lastExitCode: row.lastExitCode, errorMessage: 'The previously managed process is no longer present after the API restart.',
        })
        await this.event(row.serverId, null, 'server-process-recovery', 'failure', 'The previous panel process was not found after the API restart.')
      }
    }
  }

  listPublicStatuses(): Map<string, ServerRuntime['status']> {
    const result = new Map<string, ServerRuntime['status']>()
    for (const server of this.db.select().from(localServers).all()) {
      const row = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, server.id)).get()
      result.set(server.id, server.source === 'imported' || !server.managed ? 'external/unmanaged' : row?.status ?? 'stopped')
    }
    return result
  }

  async get(serverId: string): Promise<ServerRuntime> {
    const server = this.serverRow(serverId)
    const row = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    const status: ServerRuntime['status'] = server.source === 'imported' || !server.managed
      ? 'external/unmanaged'
      : row?.status ?? 'stopped'
    const startedAt = row?.startedAt ?? null
    const uptimeSeconds = startedAt && ['starting', 'running', 'stopping', 'external/unmanaged'].includes(status)
      ? Math.max(0, (this.now() - Date.parse(startedAt)) / 1000)
      : null
    let memoryRssBytes: number | null = null
    if (row?.processPid && row.processStartMarker && row.processBootId === this.bootId) {
      const marker = await readProcessStartMarker(row.processPid).catch(() => null)
      if (marker === row.processStartMarker) memoryRssBytes = await readProcessRssBytes(row.processPid)
    }
    return {
      serverId,
      status,
      startedAt,
      uptimeSeconds,
      memoryRssBytes,
      cpuPercent: null,
      ready: status === 'running',
      playersOnline: null,
      eula: server.eula,
      restartRequired: row?.restartRequired ?? false,
      lastExitCode: row?.lastExitCode ?? null,
      errorMessage: row?.errorMessage ?? null,
    }
  }

  async console(serverId: string, after: number, limit: number): Promise<{ entries: ServerConsoleEntry[]; nextAfter: number | null }> {
    this.serverRow(serverId)
    const rows = this.db.select().from(localServerConsoleEntries)
      .where(and(eq(localServerConsoleEntries.serverId, serverId), gt(localServerConsoleEntries.id, after)))
      .orderBy(asc(localServerConsoleEntries.id)).limit(limit + 1).all()
    const more = rows.length > limit
    const entries = rows.slice(0, limit).map((row) => ({ id: row.id, occurredAt: row.occurredAt, source: row.source, severity: row.severity, message: row.message }))
    return { entries, nextAfter: more ? entries.at(-1)?.id ?? null : null }
  }

  async start(serverId: string, actorUserId: string): Promise<ServerRuntime> {
    if (this.starting.has(serverId)) throw new ServerProcessError('SERVER_ALREADY_STARTING', 'A start request is already being processed for this server.')
    this.starting.add(serverId)
    try {
      return await this.startReserved(serverId, actorUserId)
    } finally {
      this.starting.delete(serverId)
    }
  }

  private async startReserved(serverId: string, actorUserId: string): Promise<ServerRuntime> {
    const server = this.serverRow(serverId)
    this.requirePanelManaged(server)
    if (server.eula !== 'accepted') throw new ServerProcessError('EULA_NOT_ACCEPTED', 'Accept the Minecraft EULA in the installation flow before starting this server.')
    if (this.children.has(serverId)) throw new ServerProcessError('SERVER_ALREADY_RUNNING', 'MMSManager already owns a process for this server.')
    const existing = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    if (existing && !['stopped', 'crashed', 'error'].includes(existing.status)) {
      throw new ServerProcessError('SERVER_STATE_CONFLICT', existing.status === 'external/unmanaged'
        ? 'This process is unmanaged after an API restart. Confirm it has stopped before starting another process.'
        : `The server is currently ${existing.status}.`)
    }
    if (!server.javaPath || !server.jarName) throw new ServerProcessError('SERVER_CONFIGURATION_MISSING', 'Choose a verified Java runtime and server JAR before starting.')
    const directory = resolve(server.directory)
    const root = await realpath(this.servers.managedRoot)
    if (dirname(directory) !== root || await realpath(directory).catch(() => '') !== directory) {
      throw new ServerProcessError('SERVER_DIRECTORY_REJECTED', 'This server is not a safe direct child of the managed root.')
    }
    const jarPath = join(directory, server.jarName)
    const jarStat = await lstat(jarPath).catch(() => null)
    if (!jarStat?.isFile() || jarStat.isSymbolicLink()) throw new ServerProcessError('SERVER_JAR_MISSING', 'The managed server JAR is missing or unsafe.')
    const javaStat = await lstat(server.javaPath).catch(() => null)
    if ((!javaStat?.isFile() && !javaStat?.isSymbolicLink()) || javaStat?.isDirectory()) throw new ServerProcessError('JAVA_NOT_EXECUTABLE', 'The selected Java executable is missing or unsafe.')
    await access(server.javaPath, constants.X_OK).catch(() => { throw new ServerProcessError('JAVA_NOT_EXECUTABLE', 'The selected Java executable is not executable.') })
    if (server.port && !await isLoopbackPortAvailable(server.port)) throw new ServerProcessError('PORT_IN_USE', `Local port ${server.port} is already in use.`)

    const launchId = randomUUID()
    const at = new Date(this.now()).toISOString()
    await this.writeRuntime(serverId, {
      status: 'starting', processPid: null, processStartMarker: null, processBootId: null,
      startedAt: at, updatedAt: at, lastExitCode: null, errorMessage: null,
    })
    await this.addEntry(serverId, 'system', 'info', 'MMSManager is launching this panel-owned server process.')
    await this.event(serverId, actorUserId, 'server-start-requested', 'success', 'A panel-owned server process start was requested.')

    const args = [`-Xms${server.minMemoryMb}M`, `-Xmx${server.maxMemoryMb}M`, '-jar', server.jarName, 'nogui']
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(server.javaPath, args, {
        cwd: directory,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: this.servers.dataDirectory },
      })
    } catch {
      await this.failStart(serverId, actorUserId, 'JAVA_SPAWN_FAILED', 'Java could not be started with the selected executable.')
      throw new ServerProcessError('JAVA_SPAWN_FAILED', 'Java could not be started with the selected executable.')
    }
    const managed: ManagedProcess = {
      child, launchId, stopRequested: false, spawnFailed: false, rawLogCapNotified: false,
      closePromise: Promise.resolve(), spawnRecorded: Promise.resolve(), stdoutDecoder: new StringDecoder('utf8'), stderrDecoder: new StringDecoder('utf8'),
      stdoutPending: '', stderrPending: '', segments: { stdout: null, stderr: null },
      writeQueues: { stdout: Promise.resolve(), stderr: Promise.resolve() },
    }
    this.children.set(serverId, managed)
    managed.closePromise = new Promise<void>((resolveClose) => {
      child.once('spawn', () => { managed.spawnRecorded = this.recordSpawn(serverId, child.pid ?? null) })
      child.stdout.on('data', (chunk: Buffer) => this.onOutput(serverId, managed, 'stdout', chunk))
      child.stderr.on('data', (chunk: Buffer) => this.onOutput(serverId, managed, 'stderr', chunk))
      child.once('error', () => {
        managed.spawnFailed = true
        void this.failStart(serverId, actorUserId, 'JAVA_SPAWN_FAILED', 'The selected Java process failed to start.')
      })
      child.once('close', (code) => {
        void this.finish(serverId, actorUserId, managed, code).finally(resolveClose)
      })
    })
    if (child.pid) managed.spawnRecorded = this.recordSpawn(serverId, child.pid)
    const waiting = setTimeout(() => {
      const row = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
      if (row?.status === 'starting') {
        void this.updateRuntime(serverId, { errorMessage: 'The process has not reported Minecraft readiness yet. It remains panel-owned; Stop is still available.' })
        void this.addEntry(serverId, 'system', 'warn', 'Readiness is taking longer than expected; the process remains owned by MMSManager.')
      }
    }, 60_000)
    waiting.unref()
    await managed.spawnRecorded
    return this.get(serverId)
  }

  async stop(serverId: string, actorUserId: string): Promise<ServerRuntime> {
    const server = this.serverRow(serverId)
    this.requirePanelManaged(server)
    const managed = this.children.get(serverId)
    if (!managed) {
      const row = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
      if (row?.status === 'stopped') return this.get(serverId)
      throw new ServerProcessError(row?.status === 'external/unmanaged' ? 'PROCESS_UNMANAGED' : 'PROCESS_NOT_OWNED', 'MMSManager can stop only a process that it launched and still owns.')
    }
    if (managed.stopRequested) return this.get(serverId)
    managed.stopRequested = true
    await this.updateRuntime(serverId, { status: 'stopping', errorMessage: null })
    await this.addEntry(serverId, 'system', 'info', 'MMSManager sent the graceful stop command to its owned process.')
    await this.event(serverId, actorUserId, 'server-stop-requested', 'success', 'A graceful stop was sent to the panel-owned process.')
    managed.child.stdin.write('stop\n', (error) => {
      if (error) void this.updateRuntime(serverId, { status: 'stopping', errorMessage: 'The stop request could not be written. No process was force-killed.' })
    })
    return this.get(serverId)
  }

  async sendCommand(serverId: string, actorUserId: string, command: string): Promise<void> {
    const server = this.serverRow(serverId)
    this.requirePanelManaged(server)
    const managed = this.children.get(serverId)
    if (!managed || this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()?.status !== 'running') {
      throw new ServerProcessError('PROCESS_NOT_RUNNING', 'Console commands are available only while this server is ready and panel-owned.')
    }
    const at = this.now()
    const recent = (this.commandTimes.get(serverId) ?? []).filter((time) => at - time < 1000)
    if (recent.length >= 5) throw new ServerProcessError('COMMAND_RATE_LIMITED', 'Wait briefly before sending another console command.')
    recent.push(at)
    this.commandTimes.set(serverId, recent)
    const commandHash = createHash('sha256').update(command).digest('hex')
    await new Promise<void>((resolveWrite, rejectWrite) => {
      managed.child.stdin.write(`${command}\n`, (error) => error ? rejectWrite(error) : resolveWrite())
    }).catch(() => { throw new ServerProcessError('COMMAND_WRITE_FAILED', 'The console command could not be written to the owned process.') })
    await this.addEntry(serverId, 'command', 'info', `Command submitted (${command.length} characters; content not stored).`)
    await this.event(serverId, actorUserId, 'server-command-submitted', 'success', JSON.stringify({ length: command.length, sha256: commandHash }))
  }

  async confirmStopped(serverId: string, actorUserId: string): Promise<ServerRuntime> {
    const server = this.serverRow(serverId)
    this.requirePanelManaged(server)
    const row = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    if (!row || row.status !== 'external/unmanaged') throw new ServerProcessError('PROCESS_NOT_UNMANAGED', 'This server does not need unmanaged-process recovery.')
    if (!row.processPid || !row.processBootId || !row.processStartMarker) throw new ServerProcessError('PROCESS_IDENTITY_UNKNOWN', 'The old process identity cannot be verified. Leave this server unmanaged to avoid a duplicate launch.')
    if (row.processBootId === this.bootId) {
      let marker: string | null
      try {
        marker = await readProcessStartMarker(row.processPid)
      } catch {
        throw new ServerProcessError('PROCESS_IDENTITY_UNAVAILABLE', 'The previous process identity could not be checked. Leave this server unmanaged and try again later.')
      }
      if (marker && marker === row.processStartMarker) throw new ServerProcessError('PROCESS_STILL_RUNNING', 'The previous panel process is still present. Stop it outside MMSManager, then retry this check.')
      if (marker === null) {
        // The original PID is absent, so the old process is no longer running.
      } else if (marker !== row.processStartMarker) {
        // The numeric PID now belongs to a different process; never signal it.
      }
    }
    await this.updateRuntime(serverId, {
      status: 'stopped', processPid: null, processStartMarker: null, processBootId: null,
      startedAt: null, lastExitCode: null, errorMessage: null,
    })
    await this.addEntry(serverId, 'system', 'info', 'Administrator confirmed the previous process is no longer running; its identity check passed.')
    await this.event(serverId, actorUserId, 'server-unmanaged-process-cleared', 'success', 'A prior process was confirmed stopped without signaling its PID.')
    return this.get(serverId)
  }

  async shutdown(): Promise<void> {
    const ids = [...this.children.keys()]
    await Promise.all(ids.map(async (serverId) => {
      const managed = this.children.get(serverId)
      if (!managed || managed.stopRequested) return
      managed.stopRequested = true
      await this.updateRuntime(serverId, { status: 'stopping', errorMessage: null })
      await this.addEntry(serverId, 'system', 'info', 'MMSManager is shutting down and requested a graceful server stop.')
      await this.event(serverId, null, 'server-stop-requested', 'success', 'A graceful stop was requested during local API shutdown.')
      managed.child.stdin.write('stop\n', () => undefined)
    }))
    await Promise.all(ids.map((serverId) => this.children.get(serverId)?.closePromise ?? Promise.resolve()))
  }

  private async recordSpawn(serverId: string, pid: number | null): Promise<void> {
    if (!pid) return
    const marker = await readProcessStartMarker(pid).catch(() => null)
    await this.updateRuntime(serverId, { processPid: pid, processStartMarker: marker, processBootId: this.bootId })
  }

  private onOutput(serverId: string, managed: ManagedProcess, stream: OutputStream, chunk: Buffer): void {
    const queuedWrite = this.rawLogQueue.then(() => this.appendRaw(serverId, managed, stream, chunk))
    this.rawLogQueue = queuedWrite.catch(() => undefined)
    managed.writeQueues[stream] = this.rawLogQueue
    const decoder = stream === 'stdout' ? managed.stdoutDecoder : managed.stderrDecoder
    const text = decoder.write(chunk)
    const pendingKey = stream === 'stdout' ? 'stdoutPending' : 'stderrPending'
    let pending = managed[pendingKey] + text
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) this.receivedLine(serverId, managed, stream, line.replace(/\r$/, ''))
    if (pending.length > MAX_LINE_BYTES) {
      this.receivedLine(serverId, managed, stream, `${pending.slice(0, MAX_LINE_BYTES)} [display truncated; raw log preserved]`)
      pending = ''
    }
    managed[pendingKey] = pending
  }

  private receivedLine(serverId: string, managed: ManagedProcess, stream: OutputStream, line: string): void {
    const message = line.length > MAX_LINE_BYTES ? `${line.slice(0, MAX_LINE_BYTES)} [display truncated; raw log preserved]` : line
    void this.addEntry(serverId, stream, severityFor(message, stream), message)
    if (stream === 'stdout' && !managed.stopRequested && /Done \([^)]*\)! For help/.test(line)) {
      void this.updateRuntime(serverId, { status: 'running', errorMessage: null, restartRequired: false })
        .then(() => this.addEntry(serverId, 'system', 'info', 'Minecraft readiness was confirmed from the server output.'))
        .then(() => this.event(serverId, null, 'server-ready', 'success', 'The panel-owned server reported Minecraft readiness.'))
    }
  }

  private async appendRaw(serverId: string, managed: ManagedProcess, stream: OutputStream, bytes: Buffer): Promise<void> {
    const available = Math.max(0, MAX_TOTAL_RAW_LOG_BYTES - this.totalRawLogBytes)
    const acceptedLength = Math.min(bytes.byteLength, available)
    if (acceptedLength < bytes.byteLength && !managed.rawLogCapNotified) {
      managed.rawLogCapNotified = true
      await this.addEntry(serverId, 'system', 'warn', 'The 256 MiB raw log cap has been reached. Recent console lines remain available; no existing log files were removed.')
      await this.event(serverId, null, 'server-raw-log-cap-reached', 'success', 'Raw output logging paused at the global 256 MiB cap; retained console entries remain available.')
    }
    let offset = 0
    while (offset < acceptedLength) {
      let segment = managed.segments[stream]
      if (!segment || segment.size >= MAX_LOG_SEGMENT_BYTES) {
        await segment?.handle.sync()
        await segment?.handle.close()
        const index = segment ? segment.index + 1 : 0
        const path = join(this.logsDirectory, `${managed.launchId}-${stream}-${String(index).padStart(3, '0')}.log`)
        segment = { handle: await open(path, 'wx', 0o600), index, size: 0 }
        managed.segments[stream] = segment
      }
      const length = Math.min(acceptedLength - offset, MAX_LOG_SEGMENT_BYTES - segment.size)
      const part = bytes.subarray(offset, offset + length)
      await segment.handle.write(part, 0, part.length, segment.size)
      segment.size += part.length
      this.totalRawLogBytes += part.length
      offset += length
    }
  }

  private async finish(serverId: string, actorUserId: string, managed: ManagedProcess, code: number | null): Promise<void> {
    await managed.spawnRecorded
    for (const stream of ['stdout', 'stderr'] as const) {
      const decoder = stream === 'stdout' ? managed.stdoutDecoder : managed.stderrDecoder
      const pendingKey = stream === 'stdout' ? 'stdoutPending' : 'stderrPending'
      const finalText = managed[pendingKey] + decoder.end()
      if (finalText) this.receivedLine(serverId, managed, stream, finalText.replace(/\r$/, ''))
      await managed.writeQueues[stream]
      const segment = managed.segments[stream]
      await segment?.handle.sync()
      await segment?.handle.close()
    }
    if (this.children.get(serverId) === managed) this.children.delete(serverId)
    const status: 'stopped' | 'crashed' | 'error' = managed.spawnFailed ? 'error' : managed.stopRequested || code === 0 ? 'stopped' : 'crashed'
    await this.updateRuntime(serverId, {
      status, processPid: null, processStartMarker: null, processBootId: null,
      lastExitCode: code, errorMessage: status === 'crashed' ? `The server process exited unexpectedly with code ${code ?? 'unknown'}.` : null,
    })
    const detail = JSON.stringify({ exitCode: code, stopRequested: managed.stopRequested })
    await this.event(serverId, actorUserId, status === 'crashed' ? 'server-crashed' : 'server-stopped', status === 'crashed' ? 'failure' : 'success', detail)
    await this.addEntry(serverId, 'system', status === 'crashed' ? 'error' : 'info', status === 'crashed' ? `The server process exited unexpectedly (${code ?? 'unknown'}).` : 'The server process stopped.')
  }

  private async failStart(serverId: string, actorUserId: string, code: string, message: string): Promise<void> {
    await this.updateRuntime(serverId, { status: 'error', processPid: null, processStartMarker: null, processBootId: null, errorMessage: message })
    await this.addEntry(serverId, 'system', 'error', message)
    await this.event(serverId, actorUserId, code, 'failure', message)
  }

  private async writeRuntime(serverId: string, values: Omit<typeof localServerRuntime.$inferInsert, 'serverId'>): Promise<void> {
    this.db.insert(localServerRuntime).values({ ...values, serverId }).onConflictDoUpdate({
      target: localServerRuntime.serverId,
      set: { ...values, serverId },
    }).run()
  }

  private async updateRuntime(serverId: string, fields: Partial<typeof localServerRuntime.$inferInsert>): Promise<void> {
    const at = new Date(this.now()).toISOString()
    const existing = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    if (!existing) {
      await this.writeRuntime(serverId, {
        status: fields.status ?? 'stopped', processPid: fields.processPid ?? null,
        processStartMarker: fields.processStartMarker ?? null, processBootId: fields.processBootId ?? null,
        startedAt: fields.startedAt ?? null, updatedAt: at, lastExitCode: fields.lastExitCode ?? null,
        errorMessage: fields.errorMessage ?? null, restartRequired: fields.restartRequired ?? false,
      })
      return
    }
    this.db.update(localServerRuntime).set({ ...fields, updatedAt: at }).where(eq(localServerRuntime.serverId, serverId)).run()
  }

  private async addEntry(serverId: string, source: 'stdout' | 'stderr' | 'system' | 'command', severity: 'info' | 'warn' | 'error' | 'debug', message: string): Promise<void> {
    const result = this.db.insert(localServerConsoleEntries).values({
      serverId, occurredAt: new Date(this.now()).toISOString(), source, severity, message: message.slice(0, MAX_LINE_BYTES),
    }).run()
    const latest = this.db.select({ id: localServerConsoleEntries.id }).from(localServerConsoleEntries)
      .where(eq(localServerConsoleEntries.serverId, serverId)).orderBy(desc(localServerConsoleEntries.id)).limit(1).offset(MAX_CONSOLE_ENTRIES - 1).get()
    if (latest) this.db.delete(localServerConsoleEntries).where(and(eq(localServerConsoleEntries.serverId, serverId), lt(localServerConsoleEntries.id, latest.id))).run()
    void result
  }

  private async event(serverId: string | null, actorUserId: string | null, action: string, outcome: 'success' | 'failure', detail: string): Promise<void> {
    this.db.insert(localServerEvents).values({ serverId, actorUserId, action, outcome, occurredAt: new Date(this.now()).toISOString(), detail: detail.slice(0, 2048) }).run()
  }

  private serverRow(serverId: string) {
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) throw new ServerProcessError('SERVER_NOT_FOUND', 'The registered server was not found.')
    return server
  }

  private requirePanelManaged(server: typeof localServers.$inferSelect): void {
    if (server.source !== 'created' || !server.managed) throw new ServerProcessError('SERVER_NOT_PANEL_MANAGED', 'Imported folders are read only. Only servers created by MMSManager can be controlled.')
  }
}
