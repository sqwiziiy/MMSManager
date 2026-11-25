import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { users, localServers, localServerRuntime, localServerConsoleEntries, localServerEvents, localServerStructuredEvents, localServerSessions, localServerResourceSamples, localServerBackupRestores, localServerBackups, localServerRemovalOperations } from '../db/schema.js'
import { openDatabase } from '../db/client.js'
import { ServerRegistry } from './registry.js'
import { ServerProcessManager } from './processes.js'
import { ServerModsService } from './mods.js'

describe('panel-owned local server processes', () => {
  let temp: string
  let root: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let registry: ServerRegistry
  let manager: ServerProcessManager
  let userId: string
  let managedId: string
  let stubbornId: string
  let importedId: string
  let javaPath: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-process-'))
    root = join(temp, 'servers')
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    registry = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: root })
    await registry.prepare()
    userId = randomUUID()
    const now = new Date().toISOString()
    await opened.db.insert(users).values({ id: userId, username: 'process-test', usernameKey: 'process-test', displayName: 'Process Test', role: 'administrator', passwordHash: 'test-only-hash', createdAt: now, updatedAt: now, passwordChangedAt: now })
    javaPath = join(temp, 'fake-java')
    await writeFile(javaPath, `#!/bin/sh
if [ "$1" = "-version" ]; then printf 'openjdk version "21.0.4" 2024-07-16\\n' >&2; exit 0; fi
printf '[Server thread/INFO]: Starting fixture\\n'
( sleep 0.05; printf '[Server thread/INFO]: Done (0.1s)! For help, type "help"\\n'; printf '[Server thread/INFO]: MiraWoods joined the game\\n' ) &
while IFS= read -r line; do
  if [ "$line" = "stop" ]; then
    printf '[Server thread/INFO]: Stopping server.\\n'
    if [ "$4" = "ignore-stop.jar" ]; then exec /usr/bin/sleep 60; fi
    exit 0
  fi
  if [ "$line" = "list" ]; then printf '[Server thread/INFO]: There are 2 of a max of 20 players online: MiraWoods, Alex_123\\n'; continue; fi
  if [ "$line" = "kick MiraWoods" ]; then printf '[Server thread/INFO]: Kicked MiraWoods from the game\\n'; continue; fi
  if [ "$line" = "whitelist list" ]; then printf '[Server thread/INFO]: There are no whitelisted players.\\n'; continue; fi
  printf '[Server thread/INFO]: %s\\n' "$line"
done
`)
    await chmod(javaPath, 0o700)
    managedId = randomUUID()
    importedId = randomUUID()
    stubbornId = randomUUID()
    const managedDirectory = join(root, 'managed-fixture')
    const importedDirectory = join(root, 'imported-fixture')
    const stubbornDirectory = join(root, 'stubborn-fixture')
    await mkdir(managedDirectory)
    await mkdir(importedDirectory)
    await mkdir(stubbornDirectory)
    await writeFile(join(managedDirectory, 'server.jar'), Buffer.from([0x50, 0x4b, 3, 4]))
    await writeFile(join(importedDirectory, 'server.jar'), Buffer.from([0x50, 0x4b, 3, 4]))
    await writeFile(join(stubbornDirectory, 'ignore-stop.jar'), Buffer.from([0x50, 0x4b, 3, 4]))
    const port = await availablePort()
    const stubbornPort = await availablePort()
    await opened.db.insert(localServers).values([
      { id: managedId, name: 'Managed Fixture', directory: managedDirectory, source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath, javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now },
      { id: importedId, name: 'Imported Fixture', directory: importedDirectory, source: 'imported', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath, javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: null, eula: 'accepted', managed: false, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now },
      { id: stubbornId, name: 'Stubborn Fixture', directory: stubbornDirectory, source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'ignore-stop.jar', javaPath, javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: stubbornPort, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now },
    ]).run()
    manager = new ServerProcessManager(opened.db, registry, Date.now, { stopTimeoutMs: 1000, readinessTimeoutMs: 1500, shutdownTimeoutMs: 1000 })
    await manager.prepare()
  })

  afterEach(async () => {
    try {
      await manager?.shutdown()
    } finally {
      opened?.native.close()
      await rm(temp, { recursive: true, force: true })
    }
  })

  async function availablePort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const listener = createServer()
      listener.once('error', reject)
      listener.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = listener.address()
        if (!address || typeof address === 'string') return reject(new Error('No fixture port'))
        listener.close((error) => error ? reject(error) : resolvePort(address.port))
      })
    })
  }

  async function waitForStatus(target: 'running' | 'stopped' | 'crashed', attempts = 200) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const runtime = await manager.get(managedId)
      if (runtime.status === target) return runtime
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    throw new Error(`Timed out waiting for ${target}`)
  }

  async function waitForServerStatus(serverId: string, target: 'running' | 'stopped', attempts = 200) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const runtime = await manager.get(serverId)
      if (runtime.status === target) return runtime
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    throw new Error(`Timed out waiting for ${serverId} to become ${target}`)
  }

  it('starts only a panel-created server, waits for readiness, forwards commands and stops gracefully', async () => {
    await expect(manager.start(importedId, userId)).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
    const legacyAt = new Date(Date.now() - 86_400_000).toISOString()
    await opened.db.insert(localServerConsoleEntries).values({ serverId: managedId, sessionId: null, occurredAt: legacyAt, source: 'system', severity: 'info', message: 'Legacy fixture output' })
    await opened.db.insert(localServerRuntime).values({ serverId: managedId, status: 'stopped', updatedAt: new Date().toISOString(), restartRequired: true }).run()
    const starting = await manager.start(managedId, userId)
    expect(starting).toMatchObject({ status: 'starting', restartRequired: true })
    const ready = await waitForStatus('running')
    expect(ready).toMatchObject({ ready: true, playersOnline: null, memoryRssBytes: expect.any(Number) })
    const listedSessions = await manager.consoleSessions(managedId)
    const firstConsoleSession = listedSessions.find((session) => session.live)!
    expect(firstConsoleSession, JSON.stringify(listedSessions)).toMatchObject({ id: expect.any(String), outcome: 'running', live: true, entryCount: expect.any(Number) })
    expect(listedSessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'legacy', outcome: 'legacy', live: false })]))
    expect((await manager.console(managedId, 0, 200, 'legacy')).entries.map((entry) => entry.message)).toEqual(['Legacy fixture output'])
    const firstSessionEntries = opened.db.select().from(localServerConsoleEntries).where(eq(localServerConsoleEntries.serverId, managedId)).all()
    const linkedEntries = firstSessionEntries.filter((entry) => entry.sessionId === firstConsoleSession.id)
    expect(linkedEntries.length).toBeGreaterThan(0)
    expect(firstSessionEntries.some((entry) => entry.sessionId === null)).toBe(true)
    expect(await manager.console(managedId, 0, 200, firstConsoleSession.id)).toMatchObject({ sessionId: firstConsoleSession.id, entries: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('Starting fixture') })]) })
    const newestPage = await manager.console(managedId, 0, 1, firstConsoleSession.id)
    expect(newestPage.olderThan).toBeTruthy()
    const previousPage = await manager.console(managedId, 0, 1, firstConsoleSession.id, newestPage.olderThan!)
    expect(previousPage.entries[0]!.id).toBeLessThan(newestPage.entries[0]!.id)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    expect((await manager.get(managedId)).cpuPercent).toEqual(expect.any(Number))
    expect(await manager.players(importedId)).toMatchObject({ state: 'unavailable', names: [] })
    await expect(manager.players(managedId)).resolves.toMatchObject({ state: 'authoritative', source: 'owned-console-list', names: ['MiraWoods', 'Alex_123'] })
    await expect(manager.playerAction(managedId, userId, 'kick', 'MiraWoods')).resolves.toMatchObject({ state: 'confirmed', action: 'kick', username: 'MiraWoods', confirmedAt: expect.any(String) })
    await expect(manager.playerAction(managedId, userId, 'whitelist-list', null)).resolves.toMatchObject({ state: 'confirmed', action: 'whitelist-list', username: null })
    await expect(manager.playerAction(managedId, userId, 'ban', 'Alex_123')).resolves.toMatchObject({ state: 'unverified', action: 'ban', username: 'Alex_123', confirmedAt: null })
    await expect(manager.playerAction(managedId, userId, 'kick', 'MiraWoods;stop')).rejects.toMatchObject({ code: 'INVALID_PLAYER_NAME' })
    await expect(manager.playerAction(importedId, userId, 'ban', 'MiraWoods')).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
    const confirmedActions = opened.db.select().from(localServerEvents).where(eq(localServerEvents.action, 'player-kick')).all()
    expect(confirmedActions).toHaveLength(1)
    expect(confirmedActions[0]).toMatchObject({ serverId: managedId, actorUserId: userId, outcome: 'success' })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { entries } = await manager.console(managedId, 0, 200)
      if (entries.some((entry) => entry.message.includes('Kicked MiraWoods from the game')) && entries.some((entry) => entry.message.includes('There are no whitelisted players'))) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    const actionConsole = await manager.console(managedId, 0, 200)
    expect(actionConsole.entries.some((entry) => entry.source === 'stdout' && entry.message.includes('Kicked MiraWoods from the game'))).toBe(true)
    expect(actionConsole.entries.some((entry) => entry.source === 'stdout' && entry.message.includes('There are no whitelisted players'))).toBe(true)
    expect(ready.restartRequired).toBe(false)
    await manager.sendCommand(managedId, userId, 'say fixture-console-check')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { entries } = await manager.console(managedId, 0, 200)
      if (entries.some((entry) => entry.source === 'stdout' && entry.message.includes('say fixture-console-check'))) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    const beforeStop = await manager.console(managedId, 0, 200)
    expect(beforeStop.entries.some((entry) => entry.source === 'command' && entry.message.includes('content not stored'))).toBe(true)
    expect(beforeStop.entries.some((entry) => entry.source === 'stdout' && entry.message.includes('say fixture-console-check'))).toBe(true)
    expect((await manager.stop(managedId, userId)).status).toBe('stopping')
    expect((await waitForStatus('stopped')).lastExitCode).toBe(0)
    const structuredTypes = new Set(opened.db.select({ eventType: localServerStructuredEvents.eventType }).from(localServerStructuredEvents).where(eq(localServerStructuredEvents.serverId, managedId)).all().map((entry) => entry.eventType))
    expect(['server_ready', 'player_joined', 'player_kicked', 'server_shutdown_started', 'server_stopped'].every((eventType) => structuredTypes.has(eventType))).toBe(true)
    expect(opened.db.select().from(localServerSessions).where(eq(localServerSessions.serverId, managedId)).all()).toEqual([
      expect.objectContaining({ outcome: 'stopped', endedAt: expect.any(String), uptimeSeconds: expect.any(Number) }),
    ])
    expect(await manager.consoleSessions(managedId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: firstConsoleSession.id, outcome: 'stopped', live: false })]))
    const endedEntries = await manager.console(managedId, 0, 200, firstConsoleSession.id)
    expect(endedEntries.entries.at(-1)?.message).toBe('The server process stopped.')
    await manager.start(managedId, userId)
    await waitForStatus('running')
    const restartedSessions = await manager.consoleSessions(managedId)
    expect(restartedSessions).toHaveLength(3)
    expect(restartedSessions[0]).toMatchObject({ outcome: 'running', live: true })
    expect(restartedSessions[0]?.id).not.toBe(firstConsoleSession.id)
    await manager.stop(managedId, userId)
    await waitForStatus('stopped')
    expect(opened.db.select().from(localServerResourceSamples).where(eq(localServerResourceSamples.serverId, managedId)).all().length).toBeGreaterThan(0)
    const files = await readdir(join(temp, 'server-logs'))
    const stdoutLog = `${firstConsoleSession.id}-stdout-000.log`
    expect(files).toContain(stdoutLog)
    const raw = await readFile(join(temp, 'server-logs', stdoutLog), 'utf8')
    expect(raw).toContain('[Server thread/INFO]: Done')
    expect(raw).toContain('say fixture-console-check')
  })

  it('allows only one concurrent start request for a server', async () => {
    const firstStart = manager.start(managedId, userId)
    await expect(manager.start(managedId, userId)).rejects.toMatchObject({ code: 'SERVER_ALREADY_STARTING' })
    await firstStart
    await waitForStatus('running')
    await manager.stop(managedId, userId)
    await waitForStatus('stopped')
  })

  it('scheduled restart never starts an offline or unmanaged server and gates the player check', async () => {
    await expect(manager.restartScheduled(managedId, true)).rejects.toMatchObject({ code: 'SCHEDULED_SERVER_OFFLINE' })
    await expect(manager.restartScheduled(importedId, false)).rejects.toMatchObject({ code: 'SCHEDULED_UNMANAGED' })
    await manager.start(managedId, userId)
    await waitForStatus('running')
    const beforePid = opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, managedId)).get()?.processPid
    const at = new Date().toISOString()
    const removalId = randomUUID()
    await opened.db.insert(localServerRemovalOperations).values({ id: removalId, serverId: managedId, mode: 'permanent', state: 'prepared', actorUserId: userId, serverName: 'Managed Fixture', directory: 'managed-fixture', source: 'created', errorCode: null, errorMessage: null, createdAt: at, updatedAt: at }).run()
    await expect(manager.restartScheduled(managedId, false)).rejects.toMatchObject({ code: 'SCHEDULED_PENDING_REMOVAL' })
    await opened.db.delete(localServerRemovalOperations).where(eq(localServerRemovalOperations.id, removalId)).run()
    const selectedBackupId = randomUUID()
    const safetyBackupId = randomUUID()
    const backupValues = (id: string) => ({ id, serverId: managedId, actorUserId: userId, kind: 'manual' as const, origin: 'manual' as const, directoryName: id, createdAt: at, archiveSizeBytes: 0, manifestSizeBytes: 0, worldPathsJson: '[]', archiveSha256: '0'.repeat(64), manifestSha256: '0'.repeat(64), entryCount: 0, fileCount: 0, totalFileBytes: 0, excludedCount: 0 })
    await opened.db.insert(localServerBackups).values([backupValues(selectedBackupId), backupValues(safetyBackupId)]).run()
    const restoreId = randomUUID()
    await opened.db.insert(localServerBackupRestores).values({ id: restoreId, serverId: managedId, backupId: selectedBackupId, safetyBackupId, actorUserId: userId, startedAt: at, completedAt: null, status: 'prepared', stagingName: '.fixture-stage', rollbackName: '.fixture-rollback', errorCode: null }).run()
    await expect(manager.restartScheduled(managedId, false)).rejects.toMatchObject({ code: 'SCHEDULED_PENDING_RESTORE' })
    await opened.db.delete(localServerBackupRestores).where(eq(localServerBackupRestores.id, restoreId)).run()
    await opened.db.delete(localServerBackups).where(eq(localServerBackups.serverId, managedId)).run()
    await expect(manager.restartScheduled(managedId, true)).rejects.toMatchObject({ code: 'SCHEDULED_PLAYERS_ONLINE' })
    expect(await manager.get(managedId)).toMatchObject({ status: 'running', ready: true })
    expect(opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, managedId)).get()?.processPid).toBe(beforePid)

    let release!: () => void
    let entered!: () => void
    const gateEntered = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const heldFileOperation = manager.withServerFileMutation(managedId, async () => { entered(); await gate })
    await gateEntered
    await expect(manager.restartScheduled(managedId, false)).rejects.toMatchObject({ code: 'SCHEDULED_CONFLICT' })
    release()
    await heldFileOperation

    const result = await manager.restartScheduled(managedId, false)
    expect(result).toMatchObject({ status: 'running', ready: true })
    await manager.stop(managedId, userId)
    await waitForStatus('stopped')
  })

  it('serializes permanent removal against starts and file mutations', async () => {
    await expect(manager.withServerRemoval(managedId, 'permanent', async () => {
      await expect(manager.start(managedId, userId)).rejects.toMatchObject({ code: 'SERVER_FILE_BUSY' })
      await expect(manager.withServerFileMutation(managedId, async () => undefined)).rejects.toMatchObject({ code: 'SERVER_FILE_BUSY' })
      return 'removal-reserved'
    })).resolves.toBe('removal-reserved')
  })

  it('serializes permanent removal against starts and file mutations', async () => {
    await expect(manager.withServerRemoval(managedId, 'permanent', async () => {
      await expect(manager.start(managedId, userId)).rejects.toMatchObject({ code: 'SERVER_FILE_BUSY' })
      await expect(manager.withServerFileMutation(managedId, async () => undefined)).rejects.toMatchObject({ code: 'SERVER_FILE_BUSY' })
      return 'removal-reserved'
    })).resolves.toBe('removal-reserved')
  })

  it('times out restart safely and keeps an unresponsive child owned without force-killing it', async () => {
    await manager.start(stubbornId, userId)
    await waitForServerStatus(stubbornId, 'running')
    const pid = opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, stubbornId)).get()?.processPid
    expect(pid).toBeTypeOf('number')
    await expect(manager.restart(stubbornId, userId)).rejects.toMatchObject({ code: 'RESTART_STOP_TIMEOUT' })
    expect(await manager.get(stubbornId)).toMatchObject({ status: 'stopping', ready: false })
    expect(opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, stubbornId)).get()?.processPid).toBe(pid)
    await expect(manager.start(stubbornId, userId)).rejects.toMatchObject({ code: 'SERVER_ALREADY_RUNNING' })
    process.kill(pid!, 'SIGTERM')
    await waitForServerStatus(stubbornId, 'stopped')
  })

  it('bounds API shutdown and releases its pipes without killing an unresponsive child', async () => {
    await manager.start(stubbornId, userId)
    await waitForServerStatus(stubbornId, 'running')
    const pid = opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, stubbornId)).get()?.processPid
    expect(pid).toBeTypeOf('number')
    const beforeShutdown = Date.now()
    await manager.shutdown()
    expect(Date.now() - beforeShutdown).toBeLessThan(1400)
    expect(await manager.get(stubbornId)).toMatchObject({ status: 'external/unmanaged', ready: false })
    expect(opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, stubbornId)).get()?.processPid).toBe(pid)
    expect(() => process.kill(pid!, 0)).not.toThrow()
    process.kill(pid!, 'SIGTERM')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { process.kill(pid!, 0) } catch { break }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    expect(await manager.get(stubbornId)).toMatchObject({ status: 'external/unmanaged', ready: false })
  })

  it('sets restart-required after changing Fabric files on a running owned process', async () => {
    await opened.db.update(localServers).set({ software: 'fabric' }).where(eq(localServers.id, managedId)).run()
    await manager.start(managedId, userId)
    await waitForStatus('running')
    const service = new ServerModsService(opened.db, registry, manager)
    let releaseFileGate!: () => void
    let announceGate!: () => void
    const gateEntered = new Promise<void>((resolveGate) => { announceGate = resolveGate })
    const gate = new Promise<void>((resolveGate) => { releaseFileGate = resolveGate })
    const heldMutation = manager.withServerFileMutation(managedId, async () => { announceGate(); await gate })
    await gateEntered
    await expect(manager.stop(managedId, userId)).rejects.toMatchObject({ code: 'SERVER_FILE_BUSY' })
    releaseFileGate()
    await heldMutation
    const emptyZip = Buffer.alloc(22)
    emptyZip.writeUInt32LE(0x06054b50, 0)
    const inventory = await service.upload(managedId, userId, 'fixture-plugin.jar', Readable.from([emptyZip]), () => false)
    expect(inventory).toMatchObject({ restartRequired: true, items: [{ fileName: 'fixture-plugin.jar', state: 'enabled', metadataState: 'unknown' }] })
    expect((await manager.get(managedId)).restartRequired).toBe(true)
    expect((await manager.console(managedId, 0, 200)).entries.some((entry) => entry.source === 'command')).toBe(false)
    await manager.stop(managedId, userId)
    await waitForStatus('stopped')
  })

  it('does not adopt a process after API restart and verifies identity before clearing unmanaged state', async () => {
    await manager.start(managedId, userId)
    await waitForStatus('running')
    const recovered = new ServerProcessManager(opened.db, registry)
    await recovered.prepare()
    expect((await recovered.get(managedId)).status).toBe('external/unmanaged')
    await expect(recovered.start(managedId, userId)).rejects.toMatchObject({ code: 'SERVER_STATE_CONFLICT' })
    await expect(recovered.stop(managedId, userId)).rejects.toMatchObject({ code: 'PROCESS_UNMANAGED' })
    await expect(recovered.confirmStopped(managedId, userId)).rejects.toMatchObject({ code: 'PROCESS_STILL_RUNNING' })
    await manager.stop(managedId, userId)
    await waitForStatus('stopped')
    await recovered.shutdown()
  })

  it('requires accepted EULA and verifies the stored process identity before clearing unmanaged state', async () => {
    const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { shell: false, stdio: 'ignore' })
    try {
      const pid = fake.pid!
      let statText = ''
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { statText = await readFile(`/proc/${pid}/stat`, 'utf8'); break } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 10)) }
      }
      const close = statText.lastIndexOf(')')
      const marker = statText.slice(close + 1).trim().split(/\s+/)[19]!
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      expect(marker).toMatch(/^\d+$/)
      await opened.db.insert(localServerRuntime).values({ serverId: managedId, status: 'external/unmanaged', processPid: pid, processStartMarker: marker, processBootId: bootId, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastExitCode: null, errorMessage: 'test-only', restartRequired: false })
      await expect(manager.confirmStopped(managedId, userId)).rejects.toMatchObject({ code: 'PROCESS_STILL_RUNNING' })
      fake.kill('SIGTERM')
      await new Promise<void>((resolveExit) => fake.once('exit', () => resolveExit()))
      await expect(manager.confirmStopped(managedId, userId)).resolves.toMatchObject({ status: 'stopped' })

      const noEulaId = randomUUID()
      const noEulaDirectory = join(root, 'no-eula-fixture')
      await mkdir(noEulaDirectory)
      await writeFile(join(noEulaDirectory, 'server.jar'), Buffer.from([0x50, 0x4b, 3, 4]))
      await opened.db.insert(localServers).values({ id: noEulaId, name: 'No EULA Fixture', directory: noEulaDirectory, source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath, javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: await availablePort(), eula: 'not-accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).run()
      await expect(manager.start(noEulaId, userId)).rejects.toMatchObject({ code: 'EULA_NOT_ACCEPTED' })
    } finally {
      if (fake.exitCode === null && fake.signalCode === null) fake.kill('SIGTERM')
    }
  })
})
