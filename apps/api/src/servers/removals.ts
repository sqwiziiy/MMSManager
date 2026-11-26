import { lstat, mkdir, readdir, realpath, rename, rmdir, unlink, chmod } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerAutomationJobs, localServerBackupRestores, localServerEvents, localServerRemovalOperations, localServers, serverInstallOperations } from '../db/schema.js'
import type { ServerProcessManager } from './processes.js'
import type { ServerRegistry } from './registry.js'

type RemovalMode = 'unregister' | 'permanent'
type RemovalRow = typeof localServerRemovalOperations.$inferSelect

function isFsError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function errorCode(error: unknown): string { return error instanceof Error && 'code' in error ? String(error.code) : 'REMOVAL_FAILED' }
function isDirectChild(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) && !path.includes(sep)
}
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export class ServerRemovalError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class ServerRemovalService {
  readonly quarantineRoot: string

  constructor(
    private readonly db: AppDatabase,
    private readonly servers: ServerRegistry,
    private readonly processes: ServerProcessManager,
    private readonly now: () => number = Date.now,
  ) {
    this.quarantineRoot = join(servers.managedRoot, '.mmsmanager-quarantine')
  }

  async prepare(): Promise<void> {
    await mkdir(this.quarantineRoot, { recursive: true, mode: 0o700 })
    const [root, quarantine] = await Promise.all([lstat(this.servers.managedRoot), lstat(this.quarantineRoot)])
    if (!root.isDirectory() || root.isSymbolicLink() || !quarantine.isDirectory() || quarantine.isSymbolicLink() || quarantine.dev !== root.dev) {
      throw new ServerRemovalError('REMOVAL_QUARANTINE_UNSAFE', 'The private server quarantine must be a real directory on the managed server volume.')
    }
    await chmod(this.quarantineRoot, 0o700)
    const pending = this.db.select().from(localServerRemovalOperations).where(or(
      eq(localServerRemovalOperations.state, 'prepared'),
      eq(localServerRemovalOperations.state, 'quarantined'),
      eq(localServerRemovalOperations.state, 'purging'),
    )).orderBy(localServerRemovalOperations.createdAt).all()
    for (const operation of pending) await this.recover(operation)
  }

  list(limit = 100) {
    return this.db.select({
      id: localServerRemovalOperations.id,
      serverId: localServerRemovalOperations.serverId,
      serverName: localServerRemovalOperations.serverName,
      mode: localServerRemovalOperations.mode,
      state: localServerRemovalOperations.state,
      errorCode: localServerRemovalOperations.errorCode,
      errorMessage: localServerRemovalOperations.errorMessage,
      createdAt: localServerRemovalOperations.createdAt,
      updatedAt: localServerRemovalOperations.updatedAt,
    }).from(localServerRemovalOperations).orderBy(desc(localServerRemovalOperations.createdAt)).limit(limit).all()
  }

  async listUnregistered(limit = 100) {
    const rows = this.db.select({ id: localServers.id, name: localServers.name, version: localServers.version, directory: localServers.directory, removedAt: localServers.removedAt })
      .from(localServers).where(and(isNotNull(localServers.removedAt), sql`EXISTS (
        SELECT 1 FROM local_server_removal_operations AS removal
        WHERE removal.server_id = ${localServers.id} AND removal.mode = 'unregister' AND removal.state = 'unregistered'
      )`, sql`NOT EXISTS (
        SELECT 1 FROM local_server_removal_operations AS permanent
        WHERE permanent.server_id = ${localServers.id} AND permanent.mode = 'permanent'
      )`)).orderBy(desc(localServers.removedAt)).limit(limit).all()
    return await Promise.all(rows.map(async (server) => ({
      id: server.id, name: server.name, version: server.version, removedAt: server.removedAt!,
      folderAvailable: await lstat(server.directory).then((stat) => stat.isDirectory() && !stat.isSymbolicLink(), (error: unknown) => {
        if (isFsError(error) && error.code === 'ENOENT') return false
        return false
      }),
    })))
  }

  async restoreUnregistered(serverId: string, actorUserId: string): Promise<{ ok: true; serverId: string }> {
    return this.processes.withUnregisteredServerRestore(serverId, async (server) => {
      const permanentRemoval = this.db.select({ id: localServerRemovalOperations.id }).from(localServerRemovalOperations)
        .where(and(eq(localServerRemovalOperations.serverId, serverId), eq(localServerRemovalOperations.mode, 'permanent'))).limit(1).get()
      const priorRemoval = this.db.select({ id: localServerRemovalOperations.id }).from(localServerRemovalOperations)
        .where(and(eq(localServerRemovalOperations.serverId, serverId), eq(localServerRemovalOperations.mode, 'unregister'), eq(localServerRemovalOperations.state, 'unregistered')))
        .orderBy(desc(localServerRemovalOperations.createdAt)).limit(1).get()
      if (permanentRemoval || !priorRemoval) throw new ServerRemovalError('SERVER_NOT_UNREGISTERED', 'Only a retained server registration can be restored. Permanently removed servers cannot be restored here.')
      const directory = resolve(server.directory)
      const folder = await lstat(directory).catch((error: unknown) => {
        if (isFsError(error) && error.code === 'ENOENT') throw new ServerRemovalError('SERVER_RESTORE_FOLDER_MISSING', 'The original server folder is missing. Its registration was not changed.')
        throw error
      })
      if (!folder.isDirectory() || folder.isSymbolicLink()) throw new ServerRemovalError('SERVER_RESTORE_FOLDER_UNSAFE', 'The original server path is not a real directory. Its registration was not changed.')
      const canonical = await realpath(directory).catch(() => '')
      if (canonical !== directory) throw new ServerRemovalError('SERVER_RESTORE_FOLDER_UNSAFE', 'The original server folder resolves through a link or changed path.')
      if (server.source === 'created' && server.managed) {
        const root = await realpath(this.servers.managedRoot).catch(() => '')
        const rootStat = root ? await lstat(root).catch(() => null) : null
        if (!root || !isDirectChild(root, canonical) || !rootStat?.isDirectory() || rootStat.dev !== folder.dev) {
          throw new ServerRemovalError('SERVER_RESTORE_FOLDER_UNSAFE', 'The managed server folder is outside the configured server root or on a different filesystem.')
        }
      } else {
        const roots = await Promise.all(this.servers.importRoots.map((path) => realpath(path).catch(() => null)))
        if (!roots.some((root) => root !== null && isWithin(root, canonical))) {
          throw new ServerRemovalError('SERVER_RESTORE_FOLDER_UNSAFE', 'The original imported folder is outside the currently allowed import roots.')
        }
      }
      const activeServers = this.db.select({ id: localServers.id, directory: localServers.directory }).from(localServers).where(isNull(localServers.removedAt)).all()
      for (const activeServer of activeServers) {
        const activeDirectory = await realpath(activeServer.directory).catch(() => resolve(activeServer.directory))
        if (activeDirectory === canonical) throw new ServerRemovalError('SERVER_RESTORE_CONFLICT', 'Another registered server already uses the original folder.')
      }
      const latestFolder = await lstat(directory).catch(() => null)
      if (!latestFolder?.isDirectory() || latestFolder.isSymbolicLink() || latestFolder.dev !== folder.dev || latestFolder.ino !== folder.ino || await realpath(directory).catch(() => '') !== canonical) {
        throw new ServerRemovalError('SERVER_RESTORE_FOLDER_UNSAFE', 'The original server folder changed while its registration was being checked.')
      }
      const at = new Date(this.now()).toISOString()
      this.db.transaction((tx) => {
        const restored = tx.update(localServers).set({ removedAt: null, updatedAt: at })
          .where(and(eq(localServers.id, serverId), isNotNull(localServers.removedAt))).run()
        if (restored.changes !== 1) throw new ServerRemovalError('SERVER_NOT_UNREGISTERED', 'The server registration changed before it could be restored.')
        tx.insert(localServerEvents).values({
          serverId, actorUserId, action: 'server-unregistered-restored', outcome: 'success', occurredAt: at,
          detail: JSON.stringify({ removalId: priorRemoval.id, folderKept: true, serverStarted: false }),
        }).run()
      })
      await this.servers.refreshPortConfigurations(true)
      return { ok: true, serverId }
    })
  }

  async retry(operationId: string, confirmation: string, actorUserId: string) {
    const operation = this.getOperation(operationId)
    if (!operation || operation.mode !== 'permanent' || !['failed', 'recovery-required'].includes(operation.state)) {
      throw new ServerRemovalError('REMOVAL_NOT_RETRYABLE', 'This removal does not have a pending safe cleanup to retry.')
    }
    if (operation.serverName !== confirmation) throw new ServerRemovalError('SERVER_NAME_CONFIRMATION_MISMATCH', 'Type the exact server name to confirm this action.')
    const quarantinePath = join(this.quarantineRoot, operation.id)
    const quarantined = await lstat(quarantinePath).then((stat) => stat.isDirectory() && !stat.isSymbolicLink(), (error: unknown) => isFsError(error) && error.code === 'ENOENT' ? false : Promise.reject(error))
    if (quarantined) {
      await this.assertSafeManagedTarget(quarantinePath, true)
      await this.purgeQuarantine(operation.id)
      return this.publicOperation(this.getOperation(operation.id)!)
    }
    const original = await lstat(operation.directory).then((stat) => stat.isDirectory() && !stat.isSymbolicLink(), (error: unknown) => isFsError(error) && error.code === 'ENOENT' ? false : Promise.reject(error))
    if (original) {
      const server = this.db.select().from(localServers).where(eq(localServers.id, operation.serverId)).get()
      if (!server || server.removedAt) throw new ServerRemovalError('REMOVAL_RECOVERY_REQUIRED', 'The original server folder exists but its registry state needs manual review.')
      return this.remove(operation.serverId, 'permanent', confirmation, actorUserId)
    }
    const at = new Date(this.now()).toISOString()
    this.db.transaction((tx) => {
      tx.update(localServers).set({ removedAt: at, updatedAt: at }).where(eq(localServers.id, operation.serverId)).run()
      tx.update(localServerRemovalOperations).set({ state: 'purged', errorCode: null, errorMessage: null, updatedAt: at }).where(eq(localServerRemovalOperations.id, operationId)).run()
    })
    return this.publicOperation(this.getOperation(operationId)!)
  }

  async remove(serverId: string, mode: RemovalMode, confirmation: string, actorUserId: string) {
    return this.processes.withServerRemoval(serverId, mode, async (server) => {
      if (server.name !== confirmation) throw new ServerRemovalError('SERVER_NAME_CONFIRMATION_MISMATCH', 'Type the exact server name to confirm this action.')
      const unresolvedRestore = this.db.select({ id: localServerBackupRestores.id }).from(localServerBackupRestores)
        .where(and(eq(localServerBackupRestores.serverId, serverId), sql`${localServerBackupRestores.status} IN ('prepared', 'recovery-required')`)).get()
      if (unresolvedRestore) throw new ServerRemovalError('SERVER_RESTORE_RECOVERY_REQUIRED', 'Resolve the pending restore before removing this server.')
      const runningJob = this.db.select({ id: localServerAutomationJobs.id }).from(localServerAutomationJobs)
        .where(and(eq(localServerAutomationJobs.serverId, serverId), eq(localServerAutomationJobs.status, 'running'))).get()
      if (runningJob) throw new ServerRemovalError('SERVER_OPERATION_BUSY', 'Wait for the scheduled backup operation to finish before removing this server.')
      const activeInstall = this.db.select({ id: serverInstallOperations.id }).from(serverInstallOperations)
        .where(and(eq(serverInstallOperations.serverId, serverId), sql`${serverInstallOperations.status} IN ('pending', 'downloading', 'validating')`)).get()
      if (activeInstall) throw new ServerRemovalError('SERVER_OPERATION_BUSY', 'Wait for the installation operation to finish before removing this server.')

      const at = new Date(this.now()).toISOString()
      const operationId = randomUUID()
      if (mode === 'unregister') {
        this.db.transaction((tx) => {
          tx.insert(localServerRemovalOperations).values({
            id: operationId, serverId, mode, state: 'unregistered', actorUserId, serverName: server.name,
            directory: server.directory, source: server.source, errorCode: null, errorMessage: null, createdAt: at, updatedAt: at,
          }).run()
          tx.update(localServers).set({ removedAt: at, updatedAt: at }).where(eq(localServers.id, serverId)).run()
          tx.insert(localServerEvents).values({
            serverId, actorUserId, action: 'server-unregistered', outcome: 'success', occurredAt: at,
            detail: JSON.stringify({ removalId: operationId, mode, filesKept: true, source: server.source }),
          }).run()
        })
        return this.publicOperation(this.getOperation(operationId)!)
      }

      await this.assertSafeManagedTarget(server.directory)
      const quarantinePath = join(this.quarantineRoot, operationId)
      const quarantineExists = await lstat(quarantinePath).then(() => true, (error: unknown) => {
        if (isFsError(error) && error.code === 'ENOENT') return false
        throw error
      })
      if (quarantineExists) throw new ServerRemovalError('REMOVAL_QUARANTINE_COLLISION', 'A private quarantine entry already uses this removal identifier.')
      this.db.transaction((tx) => {
        tx.insert(localServerRemovalOperations).values({
          id: operationId, serverId, mode, state: 'prepared', actorUserId, serverName: server.name,
          directory: server.directory, source: server.source, errorCode: null, errorMessage: null, createdAt: at, updatedAt: at,
        }).run()
        tx.insert(localServerEvents).values({
          serverId, actorUserId, action: 'server-removal-prepared', outcome: 'success', occurredAt: at,
          detail: JSON.stringify({ removalId: operationId, mode }),
        }).run()
      })
      try {
        await rename(server.directory, quarantinePath)
        await this.assertSafeManagedTarget(quarantinePath, true)
        const quarantinedAt = new Date(this.now()).toISOString()
        this.db.transaction((tx) => {
          tx.update(localServers).set({ removedAt: quarantinedAt, updatedAt: quarantinedAt }).where(eq(localServers.id, serverId)).run()
          tx.update(localServerRemovalOperations).set({ state: 'purging', updatedAt: quarantinedAt }).where(eq(localServerRemovalOperations.id, operationId)).run()
        })
        await this.purgeQuarantine(operationId)
      } catch (error) {
        const quarantineExists = await lstat(quarantinePath).then(() => true, (issue: unknown) => isFsError(issue) && issue.code === 'ENOENT' ? false : Promise.reject(issue))
        const failedAt = new Date(this.now()).toISOString()
        const code = errorCode(error)
        const message = error instanceof Error ? error.message.slice(0, 500) : 'Permanent deletion did not complete.'
        this.db.transaction((tx) => {
          if (quarantineExists) tx.update(localServers).set({ removedAt: failedAt, updatedAt: failedAt }).where(eq(localServers.id, serverId)).run()
          tx.update(localServerRemovalOperations).set({ state: quarantineExists ? 'recovery-required' : 'failed', errorCode: code, errorMessage: message, updatedAt: failedAt })
            .where(eq(localServerRemovalOperations.id, operationId)).run()
        })
        this.db.insert(localServerEvents).values({
          serverId, actorUserId, action: 'server-removal-failed', outcome: 'failure', occurredAt: failedAt,
          detail: JSON.stringify({ removalId: operationId, mode, code }),
        }).run()
        throw error
      }
      return this.publicOperation(this.getOperation(operationId)!)
    })
  }

  private getOperation(id: string): RemovalRow | undefined {
    return this.db.select().from(localServerRemovalOperations).where(eq(localServerRemovalOperations.id, id)).get()
  }

  private publicOperation(row: RemovalRow) {
    return {
      id: row.id, serverId: row.serverId, serverName: row.serverName, mode: row.mode, state: row.state,
      errorCode: row.errorCode, errorMessage: row.errorMessage, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }
  }

  private async assertSafeManagedTarget(directory: string, quarantined = false): Promise<void> {
    const root = await realpath(quarantined ? this.quarantineRoot : this.servers.managedRoot)
    const candidate = resolve(directory)
    if (!isAbsolute(candidate) || !isDirectChild(root, candidate)) throw new ServerRemovalError('SERVER_DELETE_PATH_UNSAFE', 'The server folder is not a direct child of the configured managed root.')
    const stat = await lstat(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ServerRemovalError('SERVER_DELETE_PATH_UNSAFE', 'The server folder is missing or is not a real directory.')
    const canonical = await realpath(candidate)
    if (canonical !== candidate || !isDirectChild(root, canonical)) throw new ServerRemovalError('SERVER_DELETE_PATH_UNSAFE', 'The server folder identity changed or escaped the managed root.')
    const rootStat = await lstat(root)
    if (rootStat.dev !== stat.dev) throw new ServerRemovalError('SERVER_DELETE_PATH_UNSAFE', 'The server folder is on a different filesystem from its managed root.')
    let visited = 0
    const inspect = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        visited += 1
        if (visited > 2_000_000) throw new ServerRemovalError('SERVER_DELETE_LIMIT', 'This server folder has too many entries for a safe permanent deletion.')
        const absolute = join(current, entry.name)
        const child = await lstat(absolute)
        if (child.dev !== rootStat.dev || child.isSymbolicLink()) throw new ServerRemovalError('SERVER_DELETE_UNSAFE_ENTRY', 'The server folder contains a symbolic link or nested filesystem. Unregister it or review the folder manually.')
        if (child.isDirectory()) await inspect(absolute)
        else if (!child.isFile() || child.nlink !== 1) throw new ServerRemovalError('SERVER_DELETE_UNSAFE_ENTRY', 'The server folder contains a special file or hard link. Unregister it or review the folder manually.')
      }
    }
    await inspect(canonical)
  }

  private async purgeQuarantine(operationId: string): Promise<void> {
    const operation = this.getOperation(operationId)
    if (!operation || operation.mode !== 'permanent') throw new ServerRemovalError('REMOVAL_JOURNAL_INVALID', 'The permanent removal journal entry could not be verified.')
    const target = join(this.quarantineRoot, operationId)
    if (!isDirectChild(this.quarantineRoot, target)) throw new ServerRemovalError('REMOVAL_QUARANTINE_UNSAFE', 'The quarantined folder is not isolated.')
    const targetStat = await lstat(target).catch((error: unknown) => isFsError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
    const at = new Date(this.now()).toISOString()
    if (!targetStat) {
      this.db.update(localServerRemovalOperations).set({ state: 'purged', errorCode: null, errorMessage: null, updatedAt: at }).where(eq(localServerRemovalOperations.id, operationId)).run()
      this.db.insert(localServerEvents).values({ serverId: operation.serverId, actorUserId: operation.actorUserId, action: 'server-permanent-deletion-completed', outcome: 'success', occurredAt: at, detail: JSON.stringify({ removalId: operationId, archivesKept: true, historyKept: true }) }).run()
      return
    }
    await this.assertSafeManagedTarget(target, true)
    this.db.update(localServerRemovalOperations).set({ state: 'purging', errorCode: null, errorMessage: null, updatedAt: at }).where(eq(localServerRemovalOperations.id, operationId)).run()
    const rootStat = await lstat(this.quarantineRoot)
    const remove = async (directory: string): Promise<void> => {
      await chmod(directory, 0o700)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const childPath = join(directory, entry.name)
        const child = await lstat(childPath).catch((error: unknown) => isFsError(error) && error.code === 'ENOENT' ? null : Promise.reject(error))
        if (!child) continue
        if (child.dev !== rootStat.dev || child.isSymbolicLink()) throw new ServerRemovalError('SERVER_DELETE_UNSAFE_ENTRY', 'A symbolic link or nested filesystem appeared during permanent deletion.')
        if (child.isDirectory()) await remove(childPath)
        else if (child.isFile() && child.nlink === 1) await unlink(childPath)
        else throw new ServerRemovalError('SERVER_DELETE_UNSAFE_ENTRY', 'A special file or hard link appeared during permanent deletion.')
      }
      await rmdir(directory)
    }
    await remove(target)
    const completedAt = new Date(this.now()).toISOString()
    this.db.transaction((tx) => {
      tx.update(localServerRemovalOperations).set({ state: 'purged', errorCode: null, errorMessage: null, updatedAt: completedAt }).where(eq(localServerRemovalOperations.id, operationId)).run()
      tx.insert(localServerEvents).values({ serverId: operation.serverId, actorUserId: operation.actorUserId, action: 'server-permanent-deletion-completed', outcome: 'success', occurredAt: completedAt, detail: JSON.stringify({ removalId: operationId, archivesKept: true, historyKept: true }) }).run()
    })
  }

  private async recover(operation: RemovalRow): Promise<void> {
    const originalExists = await lstat(operation.directory).then(() => true, (error: unknown) => isFsError(error) && error.code === 'ENOENT' ? false : Promise.reject(error))
    const quarantinePath = join(this.quarantineRoot, operation.id)
    const quarantinedExists = await lstat(quarantinePath).then(() => true, (error: unknown) => isFsError(error) && error.code === 'ENOENT' ? false : Promise.reject(error))
    if (operation.state === 'prepared') {
      if (originalExists && !quarantinedExists) {
        const at = new Date(this.now()).toISOString()
        this.db.update(localServerRemovalOperations).set({ state: 'failed', errorCode: 'REMOVAL_INTERRUPTED_BEFORE_QUARANTINE', errorMessage: 'The server folder remains in place. Review the folder and repeat the deletion if still intended.', updatedAt: at }).where(eq(localServerRemovalOperations.id, operation.id)).run()
        return
      }
      if (originalExists && quarantinedExists) {
        this.markRecoveryRequired(operation, 'REMOVAL_RECOVERY_COLLISION', 'Both the original and quarantined folders exist. Neither folder was changed during recovery.')
        return
      }
      if (!originalExists && quarantinedExists) {
        const at = new Date(this.now()).toISOString()
        this.db.transaction((tx) => {
          tx.update(localServers).set({ removedAt: at, updatedAt: at }).where(eq(localServers.id, operation.serverId)).run()
          tx.update(localServerRemovalOperations).set({ state: 'purging', updatedAt: at }).where(eq(localServerRemovalOperations.id, operation.id)).run()
        })
      }
    }
    try { await this.purgeQuarantine(operation.id) }
    catch (error) { this.markRecoveryRequired(operation, errorCode(error), error instanceof Error ? error.message : 'The quarantined folder needs manual review.') }
  }

  private markRecoveryRequired(operation: RemovalRow, code: string, message: string): void {
    const at = new Date(this.now()).toISOString()
    this.db.update(localServerRemovalOperations).set({ state: 'recovery-required', errorCode: code, errorMessage: message.slice(0, 500), updatedAt: at }).where(eq(localServerRemovalOperations.id, operation.id)).run()
    this.db.insert(localServerEvents).values({ serverId: operation.serverId, actorUserId: operation.actorUserId, action: 'server-removal-recovery-required', outcome: 'failure', occurredAt: at, detail: JSON.stringify({ removalId: operation.id, code }) }).run()
  }
}
