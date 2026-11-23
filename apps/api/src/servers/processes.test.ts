import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { users, localServers, localServerRuntime } from '../db/schema.js'
import { openDatabase } from '../db/client.js'
import { ServerRegistry } from './registry.js'
import { ServerProcessManager } from './processes.js'

describe('panel-owned local server processes', () => {
  let temp: string
  let root: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let registry: ServerRegistry
  let manager: ServerProcessManager
  let userId: string
  let managedId: string
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
( sleep 0.05; printf '[Server thread/INFO]: Done (0.1s)! For help, type "help"\\n' ) &
while IFS= read -r line; do
  if [ "$line" = "stop" ]; then printf '[Server thread/INFO]: Stopping fixture\\n'; exit 0; fi
  printf '[Server thread/INFO]: %s\\n' "$line"
done
`)
    await chmod(javaPath, 0o700)
    managedId = randomUUID()
    importedId = randomUUID()
    const managedDirectory = join(root, 'managed-fixture')
    const importedDirectory = join(root, 'imported-fixture')
    await mkdir(managedDirectory)
    await mkdir(importedDirectory)
    await writeFile(join(managedDirectory, 'server.jar'), Buffer.from([0x50, 0x4b, 3, 4]))
    await writeFile(join(importedDirectory, 'server.jar'), Buffer.from([0x50, 0x4b, 3, 4]))
    const port = await availablePort()
    await opened.db.insert(localServers).values([
      { id: managedId, name: 'Managed Fixture', directory: managedDirectory, source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath, javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now },
      { id: importedId, name: 'Imported Fixture', directory: importedDirectory, source: 'imported', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath, javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: null, eula: 'accepted', managed: false, worldFolders: '[]', createdBy: userId, createdAt: now, updatedAt: now },
    ]).run()
    manager = new ServerProcessManager(opened.db, registry)
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

  it('starts only a panel-created server, waits for readiness, forwards commands and stops gracefully', async () => {
    await expect(manager.start(importedId, userId)).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
    await opened.db.insert(localServerRuntime).values({ serverId: managedId, status: 'stopped', updatedAt: new Date().toISOString(), restartRequired: true }).run()
    const starting = await manager.start(managedId, userId)
    expect(starting).toMatchObject({ status: 'starting', restartRequired: true })
    const ready = await waitForStatus('running')
    expect(ready).toMatchObject({ ready: true, playersOnline: null, cpuPercent: null, memoryRssBytes: expect.any(Number) })
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
    const files = await readdir(join(temp, 'server-logs'))
    expect(files.some((file) => file.endsWith('-stdout-000.log'))).toBe(true)
    const stdoutLog = files.find((file) => file.endsWith('-stdout-000.log'))!
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
