import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { localServerAutomationJobs, localServerBackups, localServerRestartJobs, localServerRestartSchedules, localServers, users } from '../db/schema.js'
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
  let restartScheduled: ReturnType<typeof vi.fn>
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
    restartScheduled = vi.fn(async () => undefined)
    const backups = { create: createBackup } as unknown as ServerBackupService
    service = new ServerAutomationService(opened.db, backups, 'Europe/Paris', () => now, { restartScheduled })
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

  it('keeps restart scheduling disabled by default and requires the empty-player condition', async () => {
    const initial = await service.get(serverId)
    expect(initial.restartSchedule).toMatchObject({ enabled: false, onlyWhenEmpty: true, waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30, nextRunAt: null })
    expect(initial.restartJobs).toEqual([])
    const disabled = await service.updateRestart(serverId, userId, {
      enabled: false, frequency: 'daily', localTime: '03:00', weekday: null, onlyWhenEmpty: true,
      waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    expect(disabled.restartSchedule).toMatchObject({ enabled: false, onlyWhenEmpty: true, nextRunAt: null, timeZone: 'Europe/Paris' })
    expect(opened.db.select().from(localServerRestartSchedules).where(eq(localServerRestartSchedules.serverId, serverId)).get()).toMatchObject({ enabled: false, onlyWhenEmpty: true })
  })

  it('runs a due weekly restart exactly once and persists an executed slot', async () => {
    const saved = await service.updateRestart(serverId, userId, {
      enabled: true, frequency: 'weekly', localTime: '13:00', weekday: 2, onlyWhenEmpty: true,
      waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    expect(saved.restartSchedule).toMatchObject({ enabled: true, weekday: 2, onlyWhenEmpty: true, timeZone: 'Europe/Paris', nextRunAt: '2026-11-24T12:00:00.000Z' })
    now += 2 * 60_000
    await service.checkDue()
    await service.checkDue()
    expect(restartScheduled).toHaveBeenCalledTimes(1)
    expect(restartScheduled).toHaveBeenCalledWith(serverId, true)
    const result = await service.get(serverId)
    expect(result.restartSchedule).toMatchObject({ lastStatus: 'executed', lastRunAt: '2026-11-24T12:00:00.000Z', lastOutcome: 'completed' })
    expect(result.restartJobs).toEqual([expect.objectContaining({ status: 'executed', outcome: 'completed', scheduledFor: '2026-11-24T12:00:00.000Z' })])
    expect(opened.db.select().from(localServerRestartJobs).where(eq(localServerRestartJobs.serverId, serverId)).all()).toHaveLength(1)
  })

  it('defers on online players and retries the same durable slot only within its deadline', async () => {
    restartScheduled.mockRejectedValueOnce(Object.assign(new Error('players remain online'), { code: 'SCHEDULED_PLAYERS_ONLINE' }))
    const saved = await service.updateRestart(serverId, userId, {
      enabled: true, frequency: 'daily', localTime: '13:00', weekday: null, onlyWhenEmpty: true,
      waitPolicy: 'retry', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    now = Date.parse(saved.restartSchedule.nextRunAt!) + 1_000
    await service.checkDue()
    let result = await service.get(serverId)
    expect(result.restartJobs).toEqual([expect.objectContaining({ status: 'deferred', outcome: 'players-online', nextAttemptAt: new Date(now + 5 * 60_000).toISOString() })])
    now = Date.parse(result.restartJobs[0]!.nextAttemptAt!)
    await service.checkDue()
    result = await service.get(serverId)
    expect(restartScheduled).toHaveBeenCalledTimes(2)
    expect(result.restartJobs).toEqual([expect.objectContaining({ status: 'executed', outcome: 'completed', scheduledFor: saved.restartSchedule.nextRunAt })])
    expect(opened.db.select().from(localServerRestartJobs).where(eq(localServerRestartJobs.serverId, serverId)).all()).toHaveLength(1)
  })

  it('skips unknown player counts under the default policy and records missed slots without restarting', async () => {
    restartScheduled.mockRejectedValueOnce(Object.assign(new Error('no reliable player response'), { code: 'SCHEDULED_PLAYER_COUNT_UNKNOWN' }))
    const saved = await service.updateRestart(serverId, userId, {
      enabled: true, frequency: 'daily', localTime: '13:00', weekday: null, onlyWhenEmpty: true,
      waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    now = Date.parse(saved.restartSchedule.nextRunAt!) + 1_000
    await service.checkDue()
    let result = await service.get(serverId)
    expect(result.restartJobs[0]).toMatchObject({ status: 'skipped', outcome: 'player-count-unknown' })
    const nextSlot = result.restartSchedule.nextRunAt
    now = Date.parse(nextSlot!) + 11 * 60_000
    await service.checkDue()
    result = await service.get(serverId)
    expect(restartScheduled).toHaveBeenCalledTimes(1)
    expect(result.restartJobs.map((job) => job.status)).toEqual(['missed', 'skipped'])
    expect(result.restartSchedule.lastStatus).toBe('missed')
  })

  it('cancels a deferred slot when the schedule is disabled or edited', async () => {
    restartScheduled.mockRejectedValueOnce(Object.assign(new Error('another operation'), { code: 'SCHEDULED_CONFLICT' }))
    const saved = await service.updateRestart(serverId, userId, {
      enabled: true, frequency: 'daily', localTime: '13:00', weekday: null, onlyWhenEmpty: true,
      waitPolicy: 'retry', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    now = Date.parse(saved.restartSchedule.nextRunAt!) + 1_000
    await service.checkDue()
    expect((await service.get(serverId)).restartJobs[0]?.status).toBe('deferred')
    const disabled = await service.updateRestart(serverId, userId, {
      enabled: false, frequency: 'daily', localTime: '13:00', weekday: null, onlyWhenEmpty: true,
      waitPolicy: 'retry', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    expect(disabled.restartSchedule.enabled).toBe(false)
    expect(disabled.restartJobs[0]).toMatchObject({ status: 'skipped', outcome: 'schedule-changed', nextAttemptAt: null })
  })

  it('marks an in-progress restart interrupted on API recovery and never replays it', async () => {
    const saved = await service.updateRestart(serverId, userId, {
      enabled: true, frequency: 'daily', localTime: '13:00', weekday: null, onlyWhenEmpty: true,
      waitPolicy: 'retry', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    const scheduledFor = saved.restartSchedule.nextRunAt!
    const at = new Date(now).toISOString()
    await opened.db.insert(localServerRestartJobs).values({
      id: randomUUID(), serverId, scheduledFor, status: 'running', outcome: 'pending', startedAt: at,
      finishedAt: null, nextAttemptAt: null, deadlineAt: new Date(Date.parse(scheduledFor) + 30 * 60_000).toISOString(),
      errorMessage: null, acknowledgedAt: null, createdAt: at,
    }).run()
    now = Date.parse(scheduledFor) + 1_000
    const recovered = new ServerAutomationService(opened.db, { create: createBackup } as unknown as ServerBackupService, 'Europe/Paris', () => now, { restartScheduled })
    await recovered.prepare()
    await recovered.checkDue()
    const result = await recovered.get(serverId)
    expect(result.restartSchedule.lastStatus).toBe('interrupted')
    expect(result.restartJobs[0]).toMatchObject({ status: 'interrupted', outcome: 'interrupted' })
    expect(restartScheduled).not.toHaveBeenCalled()
  })

  it('shares concurrent ticks and never runs duplicate restart slots', async () => {
    const saved = await service.updateRestart(serverId, userId, {
      enabled: true, frequency: 'daily', localTime: '13:00', weekday: null, onlyWhenEmpty: false,
      waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    let release!: () => void
    restartScheduled.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve }) })
    now = Date.parse(saved.restartSchedule.nextRunAt!) + 1_000
    const first = service.checkDue()
    await vi.waitFor(() => expect(restartScheduled).toHaveBeenCalledTimes(1))
    const second = service.checkDue()
    release()
    await Promise.all([first, second])
    expect(restartScheduled).toHaveBeenCalledTimes(1)
    expect(restartScheduled).toHaveBeenCalledWith(serverId, false)
  })

  it('waits for an active restart before allowing process shutdown to continue', async () => {
    const saved = await service.updateRestart(serverId, userId, {
      enabled: true, frequency: 'daily', localTime: '13:00', weekday: null, onlyWhenEmpty: false,
      waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30,
    })
    let release!: () => void
    restartScheduled.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve }) })
    now = Date.parse(saved.restartSchedule.nextRunAt!) + 1_000
    const tick = service.checkDue()
    await vi.waitFor(() => expect(restartScheduled).toHaveBeenCalledTimes(1))
    let stopped = false
    const stopping = service.stop().then(() => { stopped = true })
    expect(stopped).toBe(false)
    release()
    await Promise.all([tick, stopping])
    expect(stopped).toBe(true)
    expect((await service.get(serverId)).restartJobs[0]).toMatchObject({ status: 'executed', outcome: 'completed' })
  })
})
