import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { localServerEvents, localServerRuntime, localServers, users } from '../db/schema.js'
import { JavaRuntimeRegistry, type JavaRuntime } from './java.js'
import { ServerProcessManager } from './processes.js'
import { ServerRegistry } from './registry.js'
import { generatedStartScript, ServerRuntimeSettingsService } from './runtime.js'

describe('typed local server runtime settings', () => {
  let temp: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let servers: ServerRegistry
  let processes: ServerProcessManager
  let service: ServerRuntimeSettingsService
  let serverId: string
  let userId: string
  let javaPath: string
  let javaRuntimes: JavaRuntimeRegistry
  let discoveredRuntimes: JavaRuntime[]
  let serverDirectory: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-runtime-'))
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    servers = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: join(temp, 'servers') })
    await servers.prepare()
    serverId = randomUUID()
    userId = randomUUID()
    javaPath = join(temp, 'fake-java-21')
    serverDirectory = join(servers.managedRoot, 'runtime-fixture')
    await mkdir(serverDirectory)
    const createdAt = new Date().toISOString()
    await opened.db.insert(users).values({
      id: userId, username: 'runtime-fixture', usernameKey: 'runtime-fixture', displayName: 'Runtime Fixture',
      role: 'administrator', passwordHash: 'test-only-hash', createdAt, updatedAt: createdAt, lastLoginAt: createdAt, passwordChangedAt: createdAt,
    }).run()
    const options = { collector: 'default' as const, maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false }
    const script = generatedStartScript(javaPath, { minMemoryMb: 512, maxMemoryMb: 1024, jvmOptions: options }, 'server.jar')
    await writeFile(join(serverDirectory, 'start.sh'), script, { mode: 0o700 })
    await writeFile(join(serverDirectory, 'server.jar'), 'synthetic jar bytes')
    await writeFile(javaPath, `#!/bin/sh
if [ "$1" = "-version" ]; then printf 'openjdk version "21.0.4" 2024-07-16\\n' >&2; exit 0; fi
printf '%s\\n' "$@" > '${join(temp, 'launch-args')}'
printf '[Server thread/INFO]: Starting fixture\\n'
( sleep 0.04; printf '[Server thread/INFO]: Done (0.1s)! For help, type "help"\\n' ) &
while IFS= read -r line; do
  if [ "$line" = "stop" ]; then printf '[Server thread/INFO]: Stopping server.\\n'; exit 0; fi
done
`)
    await chmod(javaPath, 0o700)
    const listener = createServer()
    const port = await new Promise<number>((resolvePort, reject) => {
      listener.once('error', reject)
      listener.listen({ host: '127.0.0.1', port: 0 }, () => {
        const address = listener.address()
        if (!address || typeof address === 'string') return reject(new Error('No fixture port'))
        listener.close((error) => error ? reject(error) : resolvePort(address.port))
      })
    })
    await opened.db.insert(localServers).values({
      id: serverId, name: 'Runtime Fixture', directory: serverDirectory, source: 'created', software: 'vanilla', version: '1.21.4',
      jarName: 'server.jar', javaPath, javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port,
      eula: 'accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt, updatedAt: createdAt,
      jvmOptionsJson: JSON.stringify(options), startScriptSha256: createHash('sha256').update(script).digest('hex'),
    }).run()
    discoveredRuntimes = [{ path: javaPath, version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered' }]
    javaRuntimes = new JavaRuntimeRegistry(async () => discoveredRuntimes)
    processes = new ServerProcessManager(opened.db, servers, Date.now, { stopTimeoutMs: 1500, readinessTimeoutMs: 1500, shutdownTimeoutMs: 1500 }, javaRuntimes)
    await processes.prepare()
    service = new ServerRuntimeSettingsService(opened.db, servers, processes, javaRuntimes)
  })

  afterEach(async () => {
    try { await processes?.shutdown() } finally {
      opened?.native.close()
      await rm(temp, { recursive: true, force: true })
    }
  })

  async function waitForRunning() {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const runtime = await processes.get(serverId)
      if (runtime.status === 'running') return runtime
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    }
    throw new Error('Fake Java process did not report readiness.')
  }

  it('persists typed Java, heap and collector settings and uses them on the next panel restart', async () => {
    const input = {
      javaSelectionMode: 'manual' as const, confirmCompatibilityOverride: false,
      javaPath, minMemoryMb: 1024, maxMemoryMb: 2048,
      jvmOptions: { collector: 'g1' as const, maxGCPauseMs: 200, parallelGcThreads: 4, alwaysPreTouch: true, disableExplicitGc: true },
    }
    const saved = await service.update(serverId, userId, input)
    expect(saved).toMatchObject({ javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 2048, compatibility: 'meets-minimum', javaSelectionMode: 'manual', startScript: 'synchronized' })
    const launchScript = await readFile(join(serverDirectory, 'start.sh'), 'utf8')
    expect(launchScript).toContain('-XX:+UseG1GC')
    expect(launchScript).toContain('-XX:MaxGCPauseMillis=200')
    expect(launchScript).toContain('-XX:ParallelGCThreads=4')
    expect(launchScript).toContain('-XX:+AlwaysPreTouch')
    expect(launchScript).toContain('-XX:+DisableExplicitGC')

    await processes.start(serverId, userId)
    const effectiveArguments = await readFile(join(temp, 'launch-args'), 'utf8')
    expect(effectiveArguments).toContain('-Xms1024M')
    expect(effectiveArguments).toContain('-Xmx2048M')
    expect(effectiveArguments).toContain('-XX:+UseG1GC')
    expect(effectiveArguments).toContain('-XX:MaxGCPauseMillis=200')
    expect(effectiveArguments).toContain('-XX:ParallelGCThreads=4')
    expect(effectiveArguments).toContain('-jar')
    expect(effectiveArguments).toContain('server.jar')
    expect(effectiveArguments).toContain('nogui')
    const first = await waitForRunning()
    expect(first.restartRequired).toBe(false)
    const changed = await service.update(serverId, userId, { ...input, maxMemoryMb: 3072 })
    expect(changed.restartRequired).toBe(true)
    const firstPid = opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()?.processPid
    const restarted = await processes.restart(serverId, userId)
    const row = opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()
    expect(restarted).toMatchObject({ status: 'running', ready: true, restartRequired: false })
    expect(row?.processPid).not.toBe(firstPid)
    expect(opened.db.select().from(localServerEvents).where(eq(localServerEvents.action, 'server-restart-completed')).all()).toHaveLength(1)
    expect(await readFile(join(serverDirectory, 'start.sh'), 'utf8')).toContain('-Xmx3072M')
  })

  it('rejects a Java runtime below the installation minimum without changing settings', async () => {
    const java8 = join(temp, 'fake-java-8')
    await writeFile(java8, '#!/bin/sh\nprintf \'openjdk version "1.8.0_402"\\n\' >&2\n')
    await chmod(java8, 0o700)
    await expect(service.update(serverId, userId, {
      javaSelectionMode: 'manual', javaPath: java8, confirmCompatibilityOverride: false, minMemoryMb: 512, maxMemoryMb: 1024,
      jvmOptions: { collector: 'default', maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false },
    })).rejects.toMatchObject({ code: 'JAVA_OVERRIDE_CONFIRMATION_REQUIRED' })
    expect(opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get()?.javaPath).toBe(javaPath)
  })

  it('selects the lowest available runtime meeting the declared minimum and updates only the owned script', async () => {
    discoveredRuntimes = [
      { path: '/fixture/java-25', version: '25.0.1', major: 25, vendor: 'Fixture', source: 'discovered' },
      { path: '/fixture/java-23', version: '23.0.1', major: 23, vendor: 'Fixture', source: 'discovered' },
    ]
    const saved = await service.update(serverId, userId, {
      javaSelectionMode: 'auto', javaPath: null, confirmCompatibilityOverride: false, minMemoryMb: 512, maxMemoryMb: 1024,
      jvmOptions: { collector: 'default', maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false },
    })
    expect(saved).toMatchObject({ javaSelectionMode: 'auto', javaSelectionReason: 'automatic-lowest-meeting-minimum', javaPath: '/fixture/java-23', javaMajor: 23, compatibility: 'meets-minimum' })
    expect(await readFile(join(serverDirectory, 'start.sh'), 'utf8')).toContain("exec '/fixture/java-23'")
  })

  it('keeps Auto unselected for an unknown requirement or when no checked runtime meets it, and blocks start', async () => {
    discoveredRuntimes = []
    const noRuntime = await service.update(serverId, userId, {
      javaSelectionMode: 'auto', javaPath: null, confirmCompatibilityOverride: false, minMemoryMb: 512, maxMemoryMb: 1024,
      jvmOptions: { collector: 'default', maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false },
    })
    expect(noRuntime).toMatchObject({ javaPath: null, javaMajor: null, javaSelectionReason: 'automatic-no-runtime' })
    await expect(processes.start(serverId, userId)).rejects.toMatchObject({ code: 'JAVA_AUTO_RUNTIME_UNAVAILABLE' })

    await opened.db.update(localServers).set({ requiredJavaMajor: null }).where(eq(localServers.id, serverId)).run()
    discoveredRuntimes = [{ path: javaPath, version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered' }]
    const unknown = await service.get(serverId)
    expect(unknown).toMatchObject({ javaPath: null, javaMajor: null, javaSelectionReason: 'automatic-requirement-unknown' })
    await expect(processes.start(serverId, userId)).rejects.toMatchObject({ code: 'JAVA_AUTO_REQUIREMENT_UNKNOWN' })
  })

  it('requires a manual exception confirmation and rejects a runtime whose checked identity later changes', async () => {
    const java8 = join(temp, 'fake-java-8')
    const writeJava8 = async (version: string) => {
      await writeFile(java8, `#!/bin/sh\nif [ "$1" = "-version" ]; then printf 'openjdk version "${version}"\\n' >&2; exit 0; fi\nprintf '[Server thread/INFO]: Starting fixture\\n'\n( sleep 0.04; printf '[Server thread/INFO]: Done (0.1s)! For help, type "help"\\n' ) &\nwhile IFS= read -r line; do [ "$line" = "stop" ] && exit 0; done\n`)
      await chmod(java8, 0o700)
    }
    await writeJava8('1.8.0_402')
    const input = {
      javaSelectionMode: 'manual' as const, javaPath: java8, minMemoryMb: 512, maxMemoryMb: 1024,
      jvmOptions: { collector: 'default' as const, maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false },
    }
    await expect(service.update(serverId, userId, { ...input, confirmCompatibilityOverride: false })).rejects.toMatchObject({ code: 'JAVA_OVERRIDE_CONFIRMATION_REQUIRED' })
    const saved = await service.update(serverId, userId, { ...input, confirmCompatibilityOverride: true })
    expect(saved).toMatchObject({ javaSelectionMode: 'manual', javaMajor: 8, compatibility: 'below-minimum', javaCompatibilityOverrideConfirmed: true })
    await processes.start(serverId, userId)
    await waitForRunning()
    await processes.stop(serverId, userId)
    for (let attempt = 0; attempt < 100 && (await processes.get(serverId)).status !== 'stopped'; attempt += 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    await writeJava8('1.8.0_403')
    expect(await service.get(serverId)).toMatchObject({ javaMajor: 8, javaCompatibilityOverrideConfirmed: false })
    await expect(processes.start(serverId, userId)).rejects.toMatchObject({ code: 'JAVA_OVERRIDE_CONFIRMATION_REQUIRED' })
    expect(opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()?.status).toBe('stopped')
  })

  it('requires confirmation when the declared minimum is unknown and invalidates it when the requirement changes', async () => {
    await opened.db.update(localServers).set({ requiredJavaMajor: null }).where(eq(localServers.id, serverId)).run()
    const input = {
      javaSelectionMode: 'manual' as const, javaPath, minMemoryMb: 512, maxMemoryMb: 1024,
      jvmOptions: { collector: 'default' as const, maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false },
    }
    await expect(service.update(serverId, userId, { ...input, confirmCompatibilityOverride: false })).rejects.toMatchObject({ code: 'JAVA_OVERRIDE_CONFIRMATION_REQUIRED' })
    const confirmed = await service.update(serverId, userId, { ...input, confirmCompatibilityOverride: true })
    expect(confirmed).toMatchObject({ compatibility: 'unknown', javaCompatibilityOverrideConfirmed: true })
    await processes.start(serverId, userId)
    await waitForRunning()
    await processes.stop(serverId, userId)
    for (let attempt = 0; attempt < 100 && (await processes.get(serverId)).status !== 'stopped'; attempt += 1) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
    await opened.db.update(localServers).set({ requiredJavaMajor: 22 }).where(eq(localServers.id, serverId)).run()
    expect(await service.get(serverId)).toMatchObject({ compatibility: 'below-minimum', javaCompatibilityOverrideConfirmed: false })
    await expect(processes.start(serverId, userId)).rejects.toMatchObject({ code: 'JAVA_OVERRIDE_CONFIRMATION_REQUIRED' })
  })

  it('leaves a user-customized generated start script unchanged', async () => {
    await writeFile(join(serverDirectory, 'start.sh'), '#!/bin/sh\n# edited by owner\n')
    const saved = await service.update(serverId, userId, {
      javaSelectionMode: 'manual', javaPath, confirmCompatibilityOverride: false, minMemoryMb: 512, maxMemoryMb: 1536,
      jvmOptions: { collector: 'default', maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false },
    })
    expect(saved.startScript).toBe('customized')
    expect(await readFile(join(serverDirectory, 'start.sh'), 'utf8')).toBe('#!/bin/sh\n# edited by owner\n')
  })
})
