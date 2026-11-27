import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import { and, desc, eq, isNull, or } from 'drizzle-orm'
import type { ServerSoftwareChangeRequest, ServerSoftwareCorrectionRequest, ServerSoftwareDetection } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { localServerEvents, localServers, serverInstallOperations } from '../db/schema.js'
import type { ServerBackupService } from './backups.js'
import type { ServerProcessManager } from './processes.js'
import type { ServerRegistry } from './registry.js'
import { ServerInstallError, ServerInstallService } from './install.js'
import { detectNativeLoader, nativeLoaderMinecraftVersion, resolveNativeLaunch } from './native-loader.js'
import type { ServerLaunchConfiguration } from './native-loader.js'
import { generatedStartScript } from './runtime.js'
import { jvmOptionsSchema } from '@mmsmanager/shared'

const CORE_PATHS = ['server.jar', 'libraries', 'versions', 'start.sh'] as const
const PRIVATE_DIRECTORY = '.mmsmanager'
const SOFTWARE_ROLLBACK_DIRECTORY = 'software-rollback'
type ServerRow = typeof localServers.$inferSelect
type DetectedSoftware = { software: 'vanilla' | 'fabric' | 'paper' | 'forge' | 'neoforge'; version: string | null; loaderVersion: string | null; launch: ServerLaunchConfiguration }
type CoreIdentity = { name: string; dev: number; ino: number; directory: boolean }

export class ServerSoftwareError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
async function optionalLstat(path: string) {
  try { return await lstat(path) }
  catch (error) { if (isNodeError(error) && error.code === 'ENOENT') return null; throw error }
}
function isDirectChild(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolutePath(path) && !path.includes(sep)
}
function isAbsolutePath(path: string): boolean { return path.startsWith(sep) }
function isSoftware(value: string): value is 'vanilla' | 'fabric' | 'paper' | 'forge' | 'neoforge' {
  return value === 'vanilla' || value === 'fabric' || value === 'paper' || value === 'forge' || value === 'neoforge'
}
function registeredSoftware(row: ServerRow): string { return row.loader ?? row.software }

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => yauzl.open(path, { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
    if (error) reject(error)
    else if (!zip) reject(new Error('The server JAR could not be opened.'))
    else resolveZip(zip)
  }))
}

async function jarMainClass(path: string): Promise<string | null> {
  let zip: ZipFile | null = null
  try {
    zip = await openZip(path)
    return await new Promise<string | null>((resolveMain, reject) => {
      const close = () => { zip?.close(); zip = null }
      zip!.once('error', (error) => { close(); reject(error) })
      const readNext = () => zip!.readEntry()
      zip!.on('entry', (entry: Entry) => {
        if (entry.fileName.replaceAll('\\', '/').toLowerCase() !== 'meta-inf/manifest.mf') { readNext(); return }
        zip!.openReadStream(entry, (error, stream) => {
          if (error || !stream) { close(); reject(error ?? new Error('The server JAR manifest could not be read.')); return }
          const chunks: Buffer[] = []
          let size = 0
          stream.on('data', (chunk: Buffer) => {
            size += chunk.byteLength
            if (size > 64 * 1024) { stream.destroy(new Error('The server JAR manifest exceeds the safe read limit.')); return }
            chunks.push(chunk)
          })
          stream.once('error', (issue) => { close(); reject(issue) })
          stream.once('end', () => {
            const manifest = Buffer.concat(chunks).toString('utf8').replace(/\r\n /g, '').replace(/\n /g, '')
            const mainClass = /^Main-Class:\s*(.+)$/im.exec(manifest)?.[1]?.trim() ?? null
            close(); resolveMain(mainClass)
          })
        })
      })
      readNext()
    })
  } catch { return null }
  finally { zip?.close() }
}

export class ServerSoftwareService {
  constructor(
    private readonly db: AppDatabase,
    private readonly servers: ServerRegistry,
    private readonly processes: ServerProcessManager,
    private readonly backups: ServerBackupService,
    private readonly installs: ServerInstallService,
    private readonly now: () => number = Date.now,
  ) {}

  async inspect(serverId: string): Promise<ServerSoftwareDetection> {
    const row = this.serverRow(serverId)
    const detected = await this.detect(row)
    return {
      serverId,
      registeredSoftware: isSoftware(registeredSoftware(row)) ? registeredSoftware(row) as ServerSoftwareDetection['registeredSoftware'] : 'unknown',
      registeredVersion: row.version,
      detectedSoftware: detected?.software ?? null,
      detectedVersion: detected?.version ?? null,
      loaderVersion: detected?.loaderVersion ?? null,
      launchStrategy: detected?.launch.kind ?? null,
      jarName: detected?.launch.kind === 'jar' ? detected.launch.jarName : null,
      registrationMatches: Boolean(detected && detected.software === registeredSoftware(row) && detected.version === row.version
        && (detected.launch.kind !== 'jar' || row.jarName === detected.launch.jarName)),
      rollbackAvailable: ['server-software-replaced', 'server-software-recovery-required'].includes(this.latestSoftwareOperation(serverId)?.action ?? ''),
    }
  }

  async correctRegistration(serverId: string, input: ServerSoftwareCorrectionRequest, actorUserId: string) {
    return this.processes.withStoppedServerOperation(serverId, async () => {
      const row = this.serverRow(serverId)
      this.requireAdminManaged(row)
      if (row.name !== input.confirmation) throw new ServerSoftwareError('SERVER_NAME_CONFIRMATION_MISMATCH', 'Type the exact server name to confirm this action.')
      const detected = await this.detect(row)
      if (!detected || detected.software !== input.software || detected.version !== input.version || detected.loaderVersion !== input.loaderVersion) {
        throw new ServerSoftwareError('SOFTWARE_FILES_CHANGED', 'The detected software files changed. Run detection again before correcting the registration.')
      }
      const at = new Date(this.now()).toISOString()
      const requiredJavaMajor = await this.installs.requiredJavaForVersion(input.version)
      this.db.transaction((tx) => {
        tx.update(localServers).set({
          software: input.software === 'forge' || input.software === 'neoforge' ? 'unknown' : input.software,
          loader: input.software === 'forge' || input.software === 'neoforge' ? input.software : null,
          version: input.version, requiredJavaMajor, jarName: detected.launch.kind === 'jar' ? detected.launch.jarName : null, updatedAt: at,
        }).where(and(eq(localServers.id, serverId), isNull(localServers.removedAt))).run()
        tx.insert(localServerEvents).values({ serverId, actorUserId, action: 'server-software-registration-corrected', outcome: 'success', occurredAt: at,
          detail: JSON.stringify({ software: input.software, version: input.version, loaderVersion: input.loaderVersion, launchStrategy: detected.launch.kind }) }).run()
      })
      return { serverId, software: input.software, version: input.version }
    })
  }

  async replace(serverId: string, input: ServerSoftwareChangeRequest, actorUserId: string) {
    let row = this.serverRow(serverId)
    this.requireAdminManaged(row)
    if (row.name !== input.confirmation) throw new ServerSoftwareError('SERVER_NAME_CONFIRMATION_MISMATCH', 'Type the exact server name to confirm this action.')
    if (!input.compatibilityAcknowledged) throw new ServerSoftwareError('SOFTWARE_WARNING_REQUIRED', 'Confirm that mods, plugins and worlds may not be compatible with the selected server software.')
    if (!row.javaPath || !row.javaMajor) throw new ServerSoftwareError('JAVA_NOT_VERIFIED', 'Choose and verify a Java runtime before changing server software.')

    // The full archive is created and verified before the live core is changed.
    const backup = await this.backups.create(serverId, actorUserId)
    const verifiedBackup = await this.backups.preview(serverId, backup.id)
    if (!verifiedBackup.integrityValid) throw new ServerSoftwareError('SOFTWARE_BACKUP_VERIFY_FAILED', 'The pre-change backup did not pass integrity verification. No server files were changed.')
    const stageId = randomUUID()
    return this.processes.withStoppedServerOperation(serverId, async () => {
      row = this.serverRow(serverId)
      this.requireAdminManaged(row)
      if (row.name !== input.confirmation) throw new ServerSoftwareError('SERVER_NAME_CONFIRMATION_MISMATCH', 'The server name changed before replacement. Review the confirmation and retry.')
      const directory = await this.safeManagedDirectory(row)
      const stage = join(directory, `.mmsmanager-software-stage-${stageId}`)
      const rollback = await this.createRollbackDirectory(directory, stageId)
      await mkdir(stage, { mode: 0o700 })
      const movedOld: string[] = []
      const movedNew: string[] = []
      let startScriptInstalled = false
      let stagedJarName: string | null = null
      let stagedOperationId: string | null = null
      const oldCoreManifest: CoreIdentity[] = []
      try {
        const result = await this.installs.stageSoftwareChange(input, row, stage, actorUserId)
        stagedJarName = result.jarName
        stagedOperationId = result.operationId
        for (const installerHelper of ['run.sh', 'run.bat', 'user_jvm_args.txt']) {
          const helper = await optionalLstat(join(stage, installerHelper))
          if (!helper) continue
          if (!helper.isFile() || helper.isSymbolicLink()) throw new ServerSoftwareError('SOFTWARE_STAGE_UNSAFE', 'The official installer produced an unsafe helper file.')
          await rm(join(stage, installerHelper), { force: false })
        }
        await this.verifyStage(stage, input.software, result.jarName)
        const currentCorePaths = [...new Set([...CORE_PATHS, ...(row.jarName && !row.jarName.includes('/') && !row.jarName.includes('\\') ? [row.jarName] : []), ...(result.jarName && !result.jarName.includes('/') && !result.jarName.includes('\\') ? [result.jarName] : [])])]
        for (const name of currentCorePaths) {
          const source = join(directory, name)
          const stat = await optionalLstat(source)
          if (!stat) continue
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new ServerSoftwareError('SOFTWARE_CORE_UNSAFE', `The existing ${name} server file cannot be safely replaced.`)
          oldCoreManifest.push({ name, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() })
          await rename(source, join(rollback, name))
          movedOld.push(name)
        }
        const stagedCorePaths = [...new Set(['server.jar', 'libraries', 'versions', ...(result.jarName ? [result.jarName] : [])])]
        for (const name of stagedCorePaths) {
          const source = join(stage, name)
          const stat = await optionalLstat(source)
          if (!stat) continue
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new ServerSoftwareError('SOFTWARE_STAGE_UNSAFE', 'The staged server core contains an unsafe file.')
          await rename(source, join(directory, name))
          movedNew.push(name)
        }
        const launch = result.launch.kind === 'argfile' || input.software === 'forge' || input.software === 'neoforge'
          ? await resolveNativeLaunch(directory, input.software as 'forge' | 'neoforge', result.jarName)
          : result.launch
        const parsedOptions = jvmOptionsSchema.safeParse(JSON.parse(row.jvmOptionsJson))
        if (!parsedOptions.success) throw new ServerSoftwareError('SOFTWARE_SETTINGS_INVALID', 'The saved JVM options are invalid. Correct the runtime settings before replacing this server software.')
        const startScript = generatedStartScript(row.javaPath!, {
          minMemoryMb: row.minMemoryMb, maxMemoryMb: row.maxMemoryMb,
          jvmOptions: parsedOptions.data,
        }, result.jarName ?? 'server.jar', launch)
        const tempScript = join(stage, 'start.sh')
        const handle = await open(tempScript, 'wx', 0o700)
        try { await handle.writeFile(startScript); await handle.sync() } finally { await handle.close() }
        await rename(tempScript, join(directory, 'start.sh'))
        startScriptInstalled = true

        await rm(stage, { recursive: true, force: false })
        const at = new Date(this.now()).toISOString()
        const newSoftware = input.software === 'forge' || input.software === 'neoforge' ? 'unknown' : input.software
        const serverBackupId = backup.id
        this.db.transaction((tx) => {
          const changed = tx.update(localServers).set({ software: newSoftware, loader: input.software === 'forge' || input.software === 'neoforge' ? input.software : null,
            version: input.version, jarName: result.jarName, requiredJavaMajor: result.requiredJavaMajor, startScriptSha256: createHash('sha256').update(startScript).digest('hex'), updatedAt: at })
            .where(and(eq(localServers.id, serverId), isNull(localServers.removedAt))).run()
          if (changed.changes !== 1) throw new ServerSoftwareError('SERVER_NOT_FOUND', 'The registered server changed before the software replacement could be recorded.')
          tx.insert(localServerEvents).values({ serverId, actorUserId, action: 'server-software-replaced', outcome: 'success', occurredAt: at,
            detail: JSON.stringify({ rollbackId: stageId, backupId: serverBackupId, operationId: result.operationId,
              old: { software: row.software, loader: row.loader, version: row.version, jarName: row.jarName, requiredJavaMajor: row.requiredJavaMajor, startScriptSha256: row.startScriptSha256 },
              next: { software: input.software, version: input.version, jarName: result.jarName }, oldCoreManifest, modsAndWorldsKept: true }) }).run()
        })
        return { serverId, software: input.software, version: input.version, backupId: serverBackupId, operationId: result.operationId }
      } catch (error) {
        let recoveryFailed = false
        try {
          if (startScriptInstalled) await rm(join(directory, 'start.sh'), { force: true })
          for (const name of movedNew.reverse()) await rm(join(directory, name), { recursive: true, force: true })
          for (const name of movedOld.reverse()) await rename(join(rollback, name), join(directory, name))
        } catch { recoveryFailed = true }
        await rm(stage, { recursive: true, force: true }).catch(() => undefined)
        this.db.update(serverInstallOperations).set({ partialDirectory: null }).where(eq(serverInstallOperations.partialDirectory, stage)).run()
        if (!recoveryFailed) await rm(rollback, { recursive: true, force: true }).catch(() => undefined)
        if (recoveryFailed) {
          const at = new Date(this.now()).toISOString()
          this.db.insert(localServerEvents).values({ serverId, actorUserId, action: 'server-software-recovery-required', outcome: 'failure', occurredAt: at,
            detail: JSON.stringify({ rollbackId: stageId, backupId: backup.id, operationId: stagedOperationId,
              old: { software: row.software, loader: row.loader, version: row.version, jarName: row.jarName, requiredJavaMajor: row.requiredJavaMajor, startScriptSha256: row.startScriptSha256 },
              next: { software: input.software, version: input.version, jarName: stagedJarName }, oldCoreManifest }) }).run()
          throw new ServerSoftwareError('SOFTWARE_RECOVERY_REQUIRED', 'Software installation failed and the previous core needs recovery. Its verified pre-change backup remains available; do not start this server until recovery is reviewed.')
        }
        if (error instanceof ServerSoftwareError || error instanceof ServerInstallError) throw error
        throw new ServerSoftwareError('SOFTWARE_CHANGE_FAILED', error instanceof Error ? error.message : 'The server software could not be changed. The previous core was restored.')
      }
    })
  }

  async rollback(serverId: string, confirmation: string, actorUserId: string) {
    return this.processes.withStoppedServerOperation(serverId, async () => {
      const row = this.serverRow(serverId)
      this.requireAdminManaged(row)
      if (row.name !== confirmation) throw new ServerSoftwareError('SERVER_NAME_CONFIRMATION_MISMATCH', 'Type the exact server name to confirm this action.')
      const latest = this.latestSoftwareOperation(serverId)
      if (!latest || !['server-software-replaced', 'server-software-recovery-required'].includes(latest.action)) throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'There is no unapplied previous server core available for rollback.')
      const data = this.parseReplacementDetail(latest.detail)
      const directory = await this.safeManagedDirectory(row)
      const privateRoot = await this.requirePrivateDirectory(directory)
      const rollback = join(privateRoot, SOFTWARE_ROLLBACK_DIRECTORY, data.rollbackId)
      const rollbackStat = await lstat(rollback).catch(() => null)
      if (!rollbackStat?.isDirectory() || rollbackStat.isSymbolicLink() || await realpath(rollback).catch(() => '') !== rollback) throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'The saved previous core is missing or unsafe; no files were changed.')
      const forward = join(rollback, 'forward-core')
      await mkdir(forward, { recursive: true, mode: 0o700 })
      const forwardStat = await lstat(forward)
      if (!forwardStat.isDirectory() || forwardStat.isSymbolicLink() || await realpath(forward).catch(() => '') !== forward) throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'The forward-core recovery folder is unsafe; no files were changed.')
      const movedCurrent: Array<{ name: string; storedName: string }> = []
      const restoredOld: string[] = []
      try {
        const currentCorePaths = [...new Set([...CORE_PATHS, ...(row.jarName && !row.jarName.includes('/') && !row.jarName.includes('\\') ? [row.jarName] : []), ...(data.nextJarName && !data.nextJarName.includes('/') && !data.nextJarName.includes('\\') ? [data.nextJarName] : [])])]
        const previousCorePaths = [...new Set([...CORE_PATHS, ...(data.old.jarName && !data.old.jarName.includes('/') && !data.old.jarName.includes('\\') ? [data.old.jarName] : [])])]
        const oldIdentityByName = new Map(data.oldCoreManifest.map((entry) => [entry.name, entry]))
        for (const name of currentCorePaths) {
          const current = join(directory, name)
          const stat = await optionalLstat(current)
          if (!stat) continue
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new ServerSoftwareError('SOFTWARE_CORE_UNSAFE', `The current ${name} file cannot be safely replaced.`)
          const oldIdentity = oldIdentityByName.get(name)
          if (oldIdentity && stat.dev === oldIdentity.dev && stat.ino === oldIdentity.ino && stat.isDirectory() === oldIdentity.directory) continue
          const forwardPath = join(forward, name)
          const existingForward = await optionalLstat(forwardPath)
          const storedName = existingForward ? `${name}.${randomUUID()}` : name
          await rename(current, join(forward, storedName)); movedCurrent.push({ name, storedName })
        }
        for (const name of previousCorePaths) {
          const current = join(directory, name)
          const currentStat = await optionalLstat(current)
          const oldIdentity = oldIdentityByName.get(name)
          if (oldIdentity && currentStat && currentStat.dev === oldIdentity.dev && currentStat.ino === oldIdentity.ino && currentStat.isDirectory() === oldIdentity.directory) continue
          const previous = join(rollback, name)
          const stat = await optionalLstat(previous)
          if (!stat) {
            if (oldIdentity) throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', `The original ${name} core file is missing from the rollback area.`)
            continue
          }
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new ServerSoftwareError('SOFTWARE_CORE_UNSAFE', `The saved ${name} core file cannot be safely restored.`)
          await rename(previous, join(directory, name)); restoredOld.push(name)
        }
        const old = data.old
        const at = new Date(this.now()).toISOString()
        this.db.transaction((tx) => {
          tx.update(localServers).set({ software: old.software, loader: old.loader, version: old.version, jarName: old.jarName,
            requiredJavaMajor: old.requiredJavaMajor, startScriptSha256: old.startScriptSha256, updatedAt: at }).where(eq(localServers.id, serverId)).run()
          tx.insert(localServerEvents).values({ serverId, actorUserId, action: 'server-software-rolled-back', outcome: 'success', occurredAt: at,
            detail: JSON.stringify({ replacedEventId: latest.id, rollbackId: data.rollbackId }) }).run()
        })
        return { serverId, rolledBackTo: old.loader ?? old.software, version: old.version }
      } catch (error) {
        try {
          for (const name of restoredOld.reverse()) await rename(join(directory, name), join(rollback, name))
          for (const item of movedCurrent.reverse()) await rename(join(forward, item.storedName), join(directory, item.name))
          await rm(forward, { recursive: true, force: true })
        } catch {
          const at = new Date(this.now()).toISOString()
          this.db.insert(localServerEvents).values({ serverId, actorUserId, action: 'server-software-recovery-required', outcome: 'failure', occurredAt: at, detail: latest.detail }).run()
          throw new ServerSoftwareError('SOFTWARE_RECOVERY_REQUIRED', 'Rollback did not finish cleanly. The current and previous core files were retained for recovery.')
        }
        throw error
      }
    })
  }

  private async detect(row: ServerRow): Promise<DetectedSoftware | null> {
    const native = await detectNativeLoader(row.directory).catch(() => null)
    if (native) {
      const version = nativeLoaderMinecraftVersion(native.software, native.loaderVersion)
      if (version) return { software: native.software, version, loaderVersion: native.loaderVersion, launch: native.launch }
    }
    const rootFiles = await readdir(row.directory, { withFileTypes: true }).catch(() => [])
    const candidates = [...new Set([
      row.jarName, 'server.jar', 'fabric-server-launch.jar', 'paper.jar',
      ...rootFiles.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).map((entry) => entry.name),
    ].filter((value): value is string => Boolean(value)))].slice(0, 128)
    for (const candidate of candidates) {
      if (candidate !== candidate.split(/[\\/]/).at(-1)) continue
      const path = join(row.directory, candidate)
      const stat = await optionalLstat(path)
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 512 * 1024 * 1024) continue
      const mainClass = await jarMainClass(path)
      const software = mainClass?.startsWith('net.fabricmc.') ? 'fabric'
        : mainClass?.startsWith('io.papermc.paperclip.') ? 'paper'
          : mainClass === 'net.minecraft.server.Main' ? 'vanilla'
            : candidate.startsWith('paper') ? 'paper'
              : candidate.startsWith('fabric') ? 'fabric' : null
      if (software) return { software, version: row.version, loaderVersion: null, launch: { kind: 'jar' as const, jarName: candidate } }
    }
    return null
  }

  private async verifyStage(stage: string, software: ServerSoftwareChangeRequest['software'], jarName: string | null) {
    const entries = await readdir(stage)
    const allowed = new Set(['server.jar', 'libraries', 'versions', ...(jarName ? [jarName] : [])])
    if (entries.some((name) => !allowed.has(name))) throw new ServerSoftwareError('SOFTWARE_STAGE_UNSAFE', 'The staged installation contains unexpected files and was not published.')
    if (software === 'forge' || software === 'neoforge') {
      try { await resolveNativeLaunch(stage, software, jarName) }
      catch { throw new ServerSoftwareError('SOFTWARE_STAGE_INVALID', 'The staged Forge or NeoForge launch files could not be verified.') }
    } else {
      const stat = await optionalLstat(join(stage, 'server.jar'))
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new ServerSoftwareError('SOFTWARE_STAGE_INVALID', 'The downloaded server JAR is missing or invalid.')
    }
  }

  private async safeManagedDirectory(row: ServerRow): Promise<string> {
    const root = await realpath(this.servers.managedRoot).catch(() => '')
    const directory = await realpath(row.directory).catch(() => '')
    const [rootStat, directoryStat] = await Promise.all([root ? lstat(root).catch(() => null) : null, directory ? lstat(directory).catch(() => null) : null])
    if (!root || !directory || directory !== resolve(row.directory) || !rootStat?.isDirectory() || !directoryStat?.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.dev !== rootStat.dev || !isDirectChild(root, directory)) {
      throw new ServerSoftwareError('SOFTWARE_PATH_UNSAFE', 'The managed server folder changed or is outside the configured server root.')
    }
    return directory
  }

  private async requirePrivateDirectory(directory: string): Promise<string> {
    const path = join(directory, PRIVATE_DIRECTORY)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path).catch(() => '') !== path) throw new ServerSoftwareError('SOFTWARE_PATH_UNSAFE', 'The private MMSManager folder is not safe for software rollback data.')
    return path
  }

  private async createRollbackDirectory(directory: string, id: string): Promise<string> {
    const privateRoot = await this.requirePrivateDirectory(directory)
    const root = join(privateRoot, SOFTWARE_ROLLBACK_DIRECTORY)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root).catch(() => '') !== root) throw new ServerSoftwareError('SOFTWARE_PATH_UNSAFE', 'The server software rollback area is unsafe.')
    const rollback = join(root, id)
    await mkdir(rollback, { mode: 0o700 })
    return rollback
  }

  private latestSoftwareOperation(serverId: string) {
    return this.db.select().from(localServerEvents).where(and(eq(localServerEvents.serverId, serverId), or(
      eq(localServerEvents.action, 'server-software-replaced'), eq(localServerEvents.action, 'server-software-rolled-back'),
      eq(localServerEvents.action, 'server-software-recovery-required'),
    ))).orderBy(desc(localServerEvents.occurredAt), desc(localServerEvents.id)).limit(1).get() ?? null
  }

  private parseReplacementDetail(detail: string): { rollbackId: string; nextJarName: string | null; oldCoreManifest: CoreIdentity[]; old: { software: 'vanilla' | 'fabric' | 'paper' | 'unknown'; loader: 'forge' | 'neoforge' | null; version: string | null; jarName: string | null; requiredJavaMajor: number | null; startScriptSha256: string | null } } {
    let parsed: unknown
    try { parsed = JSON.parse(detail) } catch { throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'The saved software change history could not be read safely.') }
    if (typeof parsed !== 'object' || parsed === null || !('rollbackId' in parsed) || typeof parsed.rollbackId !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.rollbackId)
      || !('old' in parsed) || typeof parsed.old !== 'object' || parsed.old === null) throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'The saved software change history is incomplete.')
    const old = parsed.old as Record<string, unknown>
    if (!['vanilla', 'fabric', 'paper', 'unknown'].includes(String(old['software'])) || !(old['loader'] === null || old['loader'] === 'forge' || old['loader'] === 'neoforge')
      || !(old['version'] === null || typeof old['version'] === 'string') || !(old['jarName'] === null || typeof old['jarName'] === 'string')
      || !(old['requiredJavaMajor'] === null || typeof old['requiredJavaMajor'] === 'number') || !(old['startScriptSha256'] === null || typeof old['startScriptSha256'] === 'string')) {
      throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'The saved previous software details are invalid.')
    }
    let nextJarName: string | null = null
    if ('next' in parsed && typeof parsed.next === 'object' && parsed.next !== null && 'jarName' in parsed.next) {
      const next = parsed.next as Record<string, unknown>
      if (!(next['jarName'] === null || typeof next['jarName'] === 'string')) throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'The saved replacement core details are invalid.')
      nextJarName = next['jarName'] as string | null
    }
    const oldCoreManifest: CoreIdentity[] = []
    if ('oldCoreManifest' in parsed) {
      if (!Array.isArray(parsed.oldCoreManifest)) throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'The saved previous core inventory is invalid.')
      for (const value of parsed.oldCoreManifest) {
        if (typeof value !== 'object' || value === null || !('name' in value) || typeof value.name !== 'string'
          || value.name !== value.name.split(/[\\/]/).at(-1) || value.name === '.' || value.name === '..'
          || !('dev' in value) || typeof value.dev !== 'number' || !Number.isSafeInteger(value.dev) || value.dev < 0
          || !('ino' in value) || typeof value.ino !== 'number' || !Number.isSafeInteger(value.ino) || value.ino < 0
          || !('directory' in value) || typeof value.directory !== 'boolean') {
          throw new ServerSoftwareError('SOFTWARE_ROLLBACK_UNAVAILABLE', 'The saved previous core inventory is invalid.')
        }
        oldCoreManifest.push({ name: value.name, dev: value.dev, ino: value.ino, directory: value.directory })
      }
    }
    return { rollbackId: parsed.rollbackId, nextJarName, oldCoreManifest, old: old as { software: 'vanilla' | 'fabric' | 'paper' | 'unknown'; loader: 'forge' | 'neoforge' | null; version: string | null; jarName: string | null; requiredJavaMajor: number | null; startScriptSha256: string | null } }
  }

  private requireAdminManaged(row: ServerRow): void {
    if (row.removedAt) throw new ServerSoftwareError('SERVER_NOT_FOUND', 'The registered server was not found.')
    if (row.source !== 'created' || !row.managed) throw new ServerSoftwareError('SERVER_NOT_MANAGED', 'Server software can be replaced only on folders created and managed by MMSManager.')
  }

  private serverRow(serverId: string): ServerRow {
    const row = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!row) throw new ServerSoftwareError('SERVER_NOT_FOUND', 'The registered server was not found.')
    return row
  }
}
