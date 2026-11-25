import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { jvmOptionsSchema } from '@mmsmanager/shared'
import type { JvmOptions, ServerRuntimeSettings, ServerRuntimeSettingsUpdate } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { localServerEvents, localServerRuntime, localServers } from '../db/schema.js'
import type { JavaRuntimeRegistry } from './java.js'
import type { ServerProcessManager } from './processes.js'
import type { ServerRegistry } from './registry.js'
import { classifyJavaMinimum, manualJavaOverrideFingerprint, selectAutomaticJavaRuntime } from './java-selection.js'

export class ServerRuntimeSettingsError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

export function jvmArguments(settings: Pick<ServerRuntimeSettingsUpdate, 'minMemoryMb' | 'maxMemoryMb' | 'jvmOptions'>, jarName: string): string[] {
  const args = [`-Xms${settings.minMemoryMb}M`, `-Xmx${settings.maxMemoryMb}M`]
  if (settings.jvmOptions.collector === 'g1') args.push('-XX:+UseG1GC')
  if (settings.jvmOptions.collector === 'zgc') args.push('-XX:+UseZGC')
  if (settings.jvmOptions.maxGCPauseMs !== null) args.push(`-XX:MaxGCPauseMillis=${settings.jvmOptions.maxGCPauseMs}`)
  if (settings.jvmOptions.parallelGcThreads !== null) args.push(`-XX:ParallelGCThreads=${settings.jvmOptions.parallelGcThreads}`)
  if (settings.jvmOptions.alwaysPreTouch) args.push('-XX:+AlwaysPreTouch')
  if (settings.jvmOptions.disableExplicitGc) args.push('-XX:+DisableExplicitGC')
  args.push('-jar', jarName, 'nogui')
  return args
}

export function generatedStartScript(javaPath: string, settings: Pick<ServerRuntimeSettingsUpdate, 'minMemoryMb' | 'maxMemoryMb' | 'jvmOptions'>, jarName: string): string {
  const args = jvmArguments(settings, jarName).map(shellQuote).join(' ')
  return `#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec ${shellQuote(javaPath)} ${args}\n`
}

function readOptions(raw: string): JvmOptions {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new ServerRuntimeSettingsError('RUNTIME_OPTIONS_CORRUPT', 'Saved JVM options could not be read safely.') }
  const result = jvmOptionsSchema.safeParse(parsed)
  if (!result.success) throw new ServerRuntimeSettingsError('RUNTIME_OPTIONS_CORRUPT', 'Saved JVM options are outside the supported typed format.')
  return result.data
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }

export async function updateGeneratedStartScript(
  managedRoot: string,
  directory: string,
  expectedSha256: string | null,
  javaPath: string,
  input: Pick<ServerRuntimeSettingsUpdate, 'minMemoryMb' | 'maxMemoryMb' | 'jvmOptions'>,
  jarName: string,
): Promise<{ sha256: string | null; state: ServerRuntimeSettings['startScript'] }> {
  if (expectedSha256 === null) return { sha256: null, state: 'untracked' }
  const root = await realpath(managedRoot)
  const canonicalDirectory = await realpath(directory).catch(() => '')
  if (!canonicalDirectory || canonicalDirectory !== resolve(directory) || dirname(canonicalDirectory) !== root) {
    throw new ServerRuntimeSettingsError('RUNTIME_PATH_UNSAFE', 'The managed server folder could not be rechecked safely.')
  }
  const path = join(canonicalDirectory, 'start.sh')
  let stat
  try { stat = await lstat(path) } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { sha256: expectedSha256, state: 'missing' }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024) return { sha256: expectedSha256, state: 'customized' }
  const original = await readFile(path)
  if (createHash('sha256').update(original).digest('hex') !== expectedSha256) return { sha256: expectedSha256, state: 'customized' }

  const contents = generatedStartScript(javaPath, input, jarName)
  const nextHash = createHash('sha256').update(contents).digest('hex')
  const tempPath = join(canonicalDirectory, `.start-${randomUUID()}.part`)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o700)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    const current = await lstat(path)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== stat.dev || current.ino !== stat.ino) {
      return { sha256: expectedSha256, state: 'customized' }
    }
    if (await realpath(canonicalDirectory) !== canonicalDirectory) throw new ServerRuntimeSettingsError('RUNTIME_PATH_UNSAFE', 'The managed server folder changed during the runtime update.')
    await rename(tempPath, path)
    await chmod(path, 0o700)
    return { sha256: nextHash, state: 'synchronized' }
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(tempPath).catch(() => undefined)
  }
}

export class ServerRuntimeSettingsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly servers: ServerRegistry,
    private readonly processes: ServerProcessManager,
    private readonly javaRuntimes: JavaRuntimeRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  async get(serverId: string): Promise<ServerRuntimeSettings> {
    const server = this.serverRow(serverId)
    this.requireManaged(server)
    const runtime = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    const options = readOptions(server.jvmOptionsJson)
    let javaPath = server.javaPath
    let javaMajor = server.javaMajor
    let javaSelectionReason: ServerRuntimeSettings['javaSelectionReason'] = 'manual-selection'
    let javaCompatibilityOverrideConfirmed = false
    if (server.javaSelectionMode === 'auto') {
      try {
        const result = selectAutomaticJavaRuntime(server.requiredJavaMajor, await this.javaRuntimes.scan())
        javaPath = result.runtime?.path ?? null
        javaMajor = result.runtime?.major ?? null
        javaSelectionReason = result.reason
      } catch {
        javaPath = null
        javaMajor = null
        javaSelectionReason = 'automatic-scan-unavailable'
      }
    } else if (server.javaPath) {
      try {
        const checked = await this.javaRuntimes.probe(server.javaPath)
        javaMajor = checked.major
        if (server.javaCompatibilityOverrideHash !== null && classifyJavaMinimum(server.requiredJavaMajor, checked.major) !== 'meets-minimum') {
          javaCompatibilityOverrideConfirmed = server.javaCompatibilityOverrideHash === manualJavaOverrideFingerprint({
            serverId: server.id, software: server.software, serverVersion: server.version,
            declaredMinimumMajor: server.requiredJavaMajor, runtime: checked,
          })
        }
      } catch {
        javaMajor = null
      }
    }
    const compatibility = classifyJavaMinimum(server.requiredJavaMajor, javaMajor)
    return {
      serverId,
      javaPath,
      javaMajor,
      javaSelectionMode: server.javaSelectionMode,
      javaSelectionReason,
      javaCompatibilityOverrideConfirmed,
      requiredJavaMajor: server.requiredJavaMajor,
      minMemoryMb: server.minMemoryMb,
      maxMemoryMb: server.maxMemoryMb,
      jvmOptions: options,
      compatibility,
      runtimeStatus: runtime?.status ?? 'stopped',
      restartRequired: runtime?.restartRequired ?? false,
      startScript: await this.startScriptState(server.directory, server.startScriptSha256),
    }
  }

  async update(serverId: string, actorUserId: string, input: ServerRuntimeSettingsUpdate): Promise<ServerRuntimeSettings> {
    return this.processes.withServerFileMutation(serverId, async (running) => {
      const server = this.serverRow(serverId)
      this.requireManaged(server)
      let selectedRuntime = null as Awaited<ReturnType<JavaRuntimeRegistry['probe']>> | null
      let selectionReason: ServerRuntimeSettings['javaSelectionReason'] = 'manual-selection'
      let overrideHash: string | null = null
      if (input.javaSelectionMode === 'auto') {
        try {
          const result = selectAutomaticJavaRuntime(server.requiredJavaMajor, await this.javaRuntimes.scan())
          selectedRuntime = result.runtime
          selectionReason = result.reason
        } catch { selectionReason = 'automatic-scan-unavailable' }
      } else {
        if (!input.javaPath) throw new ServerRuntimeSettingsError('JAVA_RUNTIME_REQUIRED', 'Select a checked installed Java runtime for Manual mode.')
        selectedRuntime = await this.javaRuntimes.probe(input.javaPath)
        const compatibility = classifyJavaMinimum(server.requiredJavaMajor, selectedRuntime.major)
        if (compatibility !== 'meets-minimum') {
          if (!input.confirmCompatibilityOverride) {
            throw new ServerRuntimeSettingsError('JAVA_OVERRIDE_CONFIRMATION_REQUIRED', compatibility === 'unknown'
              ? 'The declared Java minimum is unknown. Confirm the manual runtime choice explicitly before saving.'
              : `This Java version is below the declared minimum ${server.requiredJavaMajor}. Confirm the manual override explicitly before saving.`)
          }
          overrideHash = manualJavaOverrideFingerprint({
            serverId, software: server.software, serverVersion: server.version,
            declaredMinimumMajor: server.requiredJavaMajor, runtime: selectedRuntime,
          })
        }
      }
      if (input.jvmOptions.collector === 'zgc' && (selectedRuntime?.major ?? 0) < 17) {
        throw new ServerRuntimeSettingsError('JVM_OPTION_INCOMPATIBLE', 'ZGC requires Java 17 or newer.')
      }

      const oldOptions = readOptions(server.jvmOptionsJson)
      const selectedPath = selectedRuntime?.path ?? null
      const selectedMajor = selectedRuntime?.major ?? null
      const changed = server.javaSelectionMode !== input.javaSelectionMode || server.javaPath !== selectedPath || server.javaMajor !== selectedMajor
        || server.javaCompatibilityOverrideHash !== overrideHash
        || server.minMemoryMb !== input.minMemoryMb || server.maxMemoryMb !== input.maxMemoryMb
        || JSON.stringify(oldOptions) !== JSON.stringify(input.jvmOptions)
      const processState = this.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
      const script = selectedRuntime
        ? await updateGeneratedStartScript(this.servers.managedRoot, server.directory, server.startScriptSha256, selectedRuntime.path, input, server.jarName ?? 'server.jar')
        : { sha256: server.startScriptSha256, state: await this.startScriptState(server.directory, server.startScriptSha256) }
      const at = new Date(this.now()).toISOString()
      this.db.transaction((tx) => {
        tx.update(localServers).set({
          javaPath: selectedPath, javaMajor: selectedMajor,
          javaSelectionMode: input.javaSelectionMode, javaCompatibilityOverrideHash: overrideHash,
          minMemoryMb: input.minMemoryMb, maxMemoryMb: input.maxMemoryMb,
          jvmOptionsJson: JSON.stringify(input.jvmOptions), startScriptSha256: script.sha256,
          updatedAt: at,
        }).where(eq(localServers.id, serverId)).run()
        if (processState) {
          tx.update(localServerRuntime).set({ restartRequired: running ? Boolean(processState.restartRequired || changed) : false, updatedAt: at }).where(eq(localServerRuntime.serverId, serverId)).run()
        }
        tx.insert(localServerEvents).values({
          serverId, actorUserId, action: 'server-runtime-settings-updated', outcome: 'success', occurredAt: at,
          detail: JSON.stringify({ javaSelectionMode: input.javaSelectionMode, javaMajor: selectedMajor, selectionReason, minMemoryMb: input.minMemoryMb, maxMemoryMb: input.maxMemoryMb, options: input.jvmOptions, overrideConfirmed: overrideHash !== null, changed, restartRequired: running && changed, startScript: script.state }),
        }).run()
      })
      return this.get(serverId)
    })
  }

  private async startScriptState(directory: string, expectedSha256: string | null): Promise<ServerRuntimeSettings['startScript']> {
    if (expectedSha256 === null) return 'untracked'
    const root = await realpath(this.servers.managedRoot)
    const canonicalDirectory = await realpath(directory).catch(() => '')
    if (!canonicalDirectory || canonicalDirectory !== resolve(directory) || dirname(canonicalDirectory) !== root) {
      throw new ServerRuntimeSettingsError('RUNTIME_PATH_UNSAFE', 'The managed server folder could not be rechecked safely.')
    }
    const path = join(canonicalDirectory, 'start.sh')
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024) return 'customized'
      const contents = await readFile(path)
      return createHash('sha256').update(contents).digest('hex') === expectedSha256 ? 'synchronized' : 'customized'
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return 'missing'
      throw error
    }
  }

  private serverRow(serverId: string) {
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) throw new ServerRuntimeSettingsError('SERVER_NOT_FOUND', 'The registered server was not found.')
    return server
  }

  private requireManaged(server: typeof localServers.$inferSelect): void {
    if (server.source !== 'created' || !server.managed) throw new ServerRuntimeSettingsError('SERVER_NOT_PANEL_MANAGED', 'Imported folders are read only. Runtime changes are available only for panel-created servers.')
  }
}
