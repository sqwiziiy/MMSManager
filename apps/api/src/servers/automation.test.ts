import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { localServerAutomationJobs, localServerBackups, localServers, users } from '../db/schema.js'
import { ServerAutomationService, nextAutomationInstant } from './automation.js'
import type { ServerBackupService } from './backups.js'
import { ServerRegistry } from './registry.js'

describe('local server backup automation', () => {
  let temp: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let servers: ServerRegistry
  let service: ServerAutomationService
  let now: number
  let userId: string
  let serverId: string
  let createBackup: ReturnType<typeof vi.fn>
  let persistBackup: (scheduledServerId: string) => Promise<{ id: string }>

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-automation-'))
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    servers = new ServerRegistry(opened.db, temp, { MMSMANAGER_SERVER_ROOT: join(temp, 'servers') })
    await servers.prepare()
    now = Date.parse('2026-11-24T11:59:00.000Z')
    userId = randomUUID()
    serverId = randomUUID()
    const createdAt = new Date(now).toISOString()
    const serverDirectory = join(servers.managedRoot, 'automation-fixture')
    await mkdir(serverDirectory)
    await opened.db.insert(users).values({
      id: userId, username: `automation-${userId.slice(0, 6)}`, usernameKey: `automation-${userId.slice(0, 6)}`,
      displayName: 'Automation Fixture', role: 'administrator', passwordHash: 'fixture-hash', enabled: true,
      avatarKey: null, createdAt, updatedAt: createdAt, lastLoginAt: createdAt, passwordChangedAt: createdAt,
    }).run()
    await opened.db.insert(localServers).values({
      id: serverId, name: 'Automation Fixture', directory: serverDirectory, source: 'created', software: 'vanilla', version: '1.21.4',
      jarName: 'server.jar', javaPath: '/fixture/java', javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024,
      port: 25565, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: userId, createdAt, updatedAt: createdAt,
    }).run()
    persistBackup = async (scheduledServerId: string) => {
      const id = randomUUID()
      await opened.db.insert(localServerBackups).values({
        id, serverId: scheduledServerId, actorUserId: null, kind: 'manual', origin: 'scheduled', directoryName: id,
        createdAt: new Date(now).toISOString(), archiveSizeBytes: 0, manifestSizeBytes: 0, worldPathsJson: '[]',
        archiveSha256: '0'.repeat(64), manifestSha256: '0'.repeat(64), entryCount: 0, fileCount: 0, totalFileBytes: 0, excludedCount: 0,
      }).run()
      return { id }
    }
    createBackup = vi.fn(persistBackup)
    const backups = { create: createBackup } as unknown as ServerBackupService
    service = new ServerAutomationService(opened.db, backups, 'Europe/Paris', () => now)
    await service.prepare()
  })

  afterEach(async () => {
    opened.native.close()
    await rm(temp, { recursive: true, force: true })
  })

  it('maps daily wall-clock jobs through daylight-saving gaps and repeated hours', () => {
    const dailyGap = nextAutomationInstant({ frequency: 'daily', localTime: '02:30', weekday: null, timeZone: 'Europe/Paris' }, Date.parse('2026-03-28T12:00:00Z'))
    expect(new Date(dailyGap).toISOString()).toBe('2026-03-29T01:00:00.000Z')
    const repeatedHour = nextAutomationInstant({ frequency: 'daily', localTime: '02:30', weekday: null, timeZone: 'Europe/Paris' }, Date.parse('2026-10-24T12:00:00Z'))
    expect(new Date(repeatedHour).toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })

  it('persists a weekly local-time schedule and creates one scheduled backup when due', async () => {
    const saved = await service.update(serverId, userId, { enabled: true, frequency: 'weekly', localTime: '13:00', weekday: 2 })
    expect(saved).toMatchObject({ enabled: true, frequency: 'weekly', weekday: 2, timeZone: 'Europe/Paris', nextRunAt: '2026-11-24T12:00:00.000Z' })
    now += 2 * 60_000
    await service.checkDue()
    await service.checkDue()
    expect(createBackup).toHaveBeenCalledTimes(1)
    expect(createBackup).toHaveBeenCalledWith(serverId, null, expect.objectContaining({ origin: 'scheduled', signal: expect.any(AbortSignal) }))
    const result = await service.get(serverId)
    expect(result).toMatchObject({ lastStatus: 'completed', lastRunAt: '2026-11-24T12:00:00.000Z', jobs: [expect.objectContaining({ kind: 'backup', status: 'completed' })] })
    expect(opened.db.select().from(localServerAutomationJobs).where(eq(localServerAutomationJobs.serverId, serverId)).all()).toHaveLength(1)
  })

  it('records overdue work as missed, does not backfill it, and requires acknowledgement', async () => {
    await service.update(serverId, userId, { enabled: true, frequency: 'daily', localTime: '13:00', weekday: null })
    now += 12 * 60_000
    await service.checkDue()
    expect(createBackup).not.toHaveBeenCalled()
    let result = await service.get(serverId)
    expect(result).toMatchObject({ lastStatus: 'missed', unacknowledgedCount: 1, jobs: [expect.objectContaining({ status: 'missed', acknowledgedAt: null })] })
    const job = result.jobs[0]!
    result = await service.acknowledge(serverId, job.id, userId)
    expect(result).toMatchObject({ unacknowledgedCount: 0, jobs: [expect.objectContaining({ acknowledgedAt: new Date(now).toISOString() })] })
    await expect(service.acknowledge(serverId, job.id, userId)).rejects.toMatchObject({ code: 'AUTOMATION_JOB_NOT_ACKNOWLEDGEABLE' })
  })

  it('recovers an interrupted running job and advances a schedule left at the same slot', async () => {
    const saved = await service.update(serverId, userId, { enabled: true, frequency: 'daily', localTime: '13:00', weekday: null })
    const scheduledFor = saved.nextRunAt!
    now = Date.parse(scheduledFor) + 30_000
    const startedAt = new Date(now).toISOString()
    await opened.db.insert(localServerAutomationJobs).values({
      id: randomUUID(), serverId, kind: 'backup', scheduledFor, status: 'running', startedAt,
      finishedAt: null, backupId: null, errorMessage: null, acknowledgedAt: null, createdAt: startedAt,
    }).run()

    const recovered = new ServerAutomationService(opened.db, { create: createBackup } as unknown as ServerBackupService, 'Europe/Paris', () => now)
    await recovered.prepare()
    await recovered.checkDue()
    const result = await recovered.get(serverId)
    expect(result).toMatchObject({ lastStatus: 'failed', lastRunAt: scheduledFor, jobs: [expect.objectContaining({ status: 'failed', scheduledFor })] })
    expect(Date.parse(result.nextRunAt!)).toBeGreaterThan(now)
    expect(createBackup).not.toHaveBeenCalled()
    expect(opened.db.select().from(localServerAutomationJobs).where(eq(localServerAutomationJobs.serverId, serverId)).all()).toHaveLength(1)
  })

  it('shares one in-flight tick and never duplicates a scheduled attempt', async () => {
    await service.update(serverId, userId, { enabled: true, frequency: 'daily', localTime: '13:00', weekday: null })
    let release!: () => void
    createBackup.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return persistBackup(serverId)
    })
    now += 60_000
    const first = service.checkDue()
    await vi.waitFor(() => expect(createBackup).toHaveBeenCalledTimes(1))
    const second = service.checkDue()
    release()
    await Promise.all([first, second])
    expect(createBackup).toHaveBeenCalledTimes(1)
  })

  it('does not expose or schedule imported servers', async () => {
    await opened.db.update(localServers).set({ source: 'imported', managed: false }).where(eq(localServers.id, serverId)).run()
    await expect(service.get(serverId)).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
    await expect(service.update(serverId, userId, { enabled: true, frequency: 'daily', localTime: '13:00', weekday: null })).rejects.toMatchObject({ code: 'SERVER_NOT_PANEL_MANAGED' })
  })
})
