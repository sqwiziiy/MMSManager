import { randomUUID } from 'node:crypto'
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { ServerAutomation, ServerAutomationJob, ServerAutomationUpdate } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { localServerAutomation, localServerAutomationJobs, localServerEvents, localServers } from '../db/schema.js'
import { ServerBackupError, type ServerBackupService } from './backups.js'

const CHECK_INTERVAL_MS = 30_000
const MISSED_GRACE_MS = 10 * 60_000
const JOB_RETENTION = 500
type ScheduleConfig = { frequency: 'daily' | 'weekly'; localTime: string; weekday: number | null; timeZone: string }

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

function localParts(instant: number, timeZone: string): LocalParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(instant).map(({ type, value }) => [type, value]))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values['weekday'] ?? '')
  const result = { year: Number(values['year']), month: Number(values['month']), day: Number(values['day']), hour: Number(values['hour']), minute: Number(values['minute']), weekday }
  if (Object.values(result).some((part) => !Number.isInteger(part)) || weekday < 0) throw new RangeError('The configured local time zone could not be evaluated.')
  return result
}

function asDate(parts: Pick<LocalParts, 'year' | 'month' | 'day'>): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function addLocalDays(date: string, amount: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, day! + amount))
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

function offsetAt(instant: number, timeZone: string): number {
  const local = localParts(instant, timeZone)
  const milliseconds = ((instant % 60_000) + 60_000) % 60_000
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - (instant - milliseconds)
}

function instantForLocalMinute(date: string, minuteOfDay: number, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const wallMinute = Date.UTC(year!, month! - 1, day!, Math.floor(minuteOfDay / 60), minuteOfDay % 60)
  const offsets = new Set([-12, -6, 0, 6, 12].map((hours) => offsetAt(wallMinute + hours * 3_600_000, timeZone)))
  for (let advance = 0; advance <= 180; advance += 1) {
    const desired = wallMinute + advance * 60_000
    const expected = new Date(desired)
    const localDate = `${String(expected.getUTCFullYear()).padStart(4, '0')}-${String(expected.getUTCMonth() + 1).padStart(2, '0')}-${String(expected.getUTCDate()).padStart(2, '0')}`
    const localMinute = expected.getUTCHours() * 60 + expected.getUTCMinutes()
    const matches = [...offsets].map((offset) => desired - offset).filter((candidate) => {
      const local = localParts(candidate, timeZone)
      return asDate(local) === localDate && local.hour * 60 + local.minute === localMinute
    }).sort((left, right) => left - right)
    if (matches.length) return matches[0]!
  }
  throw new RangeError('The scheduled local time could not be mapped to the configured time zone.')
}

export function nextAutomationInstant(config: ScheduleConfig, after: number): number {
  if (!Number.isFinite(after) || after < 0 || !/^\d{2}:\d{2}$/.test(config.localTime)) throw new RangeError('The automation schedule is invalid.')
  const [hour, minute] = config.localTime.split(':').map(Number)
  if (hour! > 23 || minute! > 59 || (config.frequency === 'weekly' && (config.weekday === null || config.weekday < 0 || config.weekday > 6))) {
    throw new RangeError('The automation schedule is invalid.')
  }
  const current = localParts(after, config.timeZone)
  const today = asDate(current)
  for (let days = 0; days <= 7; days += 1) {
    const candidateDate = addLocalDays(today, days)
    const weekday = new Date(`${candidateDate}T00:00:00Z`).getUTCDay()
    if (config.frequency === 'weekly' && weekday !== config.weekday) continue
    const candidate = instantForLocalMinute(candidateDate, hour! * 60 + minute!, config.timeZone)
    if (candidate > after) return candidate
  }
  throw new RangeError('The next local schedule time could not be found.')
}

function briefError(error: unknown): string {
  if (error instanceof ServerBackupError) return error.message.slice(0, 512)
  if (error instanceof Error && error.name === 'ServerProcessError') return error.message.slice(0, 512)
  return 'The scheduled backup did not complete. Check the server state and private backup storage.'
}

export class ServerAutomationError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class ServerAutomationService {
  private timer: NodeJS.Timeout | null = null
  private tickPromise: Promise<void> | null = null
  private readonly abortControllers = new Map<string, AbortController>()

  constructor(
    private readonly db: AppDatabase,
    private readonly backups: ServerBackupService,
    private readonly timeZone: string,
    private readonly now: () => number = Date.now,
  ) {
    new Intl.DateTimeFormat('en', { timeZone }).format(0)
  }

  async prepare(): Promise<void> {
    const interrupted = this.db.select().from(localServerAutomationJobs).where(eq(localServerAutomationJobs.status, 'running')).all()
    for (const job of interrupted) {
      const at = new Date(this.now()).toISOString()
      const message = 'The API restarted during this backup. It was not replayed automatically; review the backup inventory before the next scheduled run.'
      const schedule = this.db.select().from(localServerAutomation).where(eq(localServerAutomation.serverId, job.serverId)).get()
      const scheduledAt = Date.parse(job.scheduledFor)
      const currentNextRun = schedule?.nextRunAt ? Date.parse(schedule.nextRunAt) : NaN
      const nextRunAt = schedule?.backupEnabled && (!Number.isFinite(currentNextRun) || currentNextRun <= scheduledAt)
        ? new Date(nextAutomationInstant({ frequency: schedule.frequency, localTime: schedule.localTime, weekday: schedule.weekday, timeZone: this.timeZone }, Math.max(this.now(), scheduledAt))).toISOString()
        : schedule?.nextRunAt ?? null
      this.db.transaction((tx) => {
        tx.update(localServerAutomationJobs).set({ status: 'failed', finishedAt: at, errorMessage: message }).where(eq(localServerAutomationJobs.id, job.id)).run()
        tx.update(localServerAutomation).set({ lastRunAt: job.scheduledFor, lastStatus: 'failed', lastError: message, nextRunAt, updatedAt: at })
          .where(eq(localServerAutomation.serverId, job.serverId)).run()
      })
      this.event(job.serverId, null, 'server-backup-schedule-interrupted', 'failure', { jobId: job.id })
    }
    const rows = this.db.select().from(localServerAutomation).where(eq(localServerAutomation.backupEnabled, true)).all()
    for (const row of rows) {
      if (row.timeZone !== this.timeZone) {
        const nextRunAt = new Date(nextAutomationInstant({ frequency: row.frequency, localTime: row.localTime, weekday: row.weekday, timeZone: this.timeZone }, this.now())).toISOString()
        this.db.update(localServerAutomation).set({ timeZone: this.timeZone, nextRunAt, updatedAt: new Date(this.now()).toISOString() }).where(eq(localServerAutomation.serverId, row.serverId)).run()
      } else if (!row.nextRunAt || !Number.isFinite(Date.parse(row.nextRunAt))) {
        const nextRunAt = new Date(nextAutomationInstant({ frequency: row.frequency, localTime: row.localTime, weekday: row.weekday, timeZone: row.timeZone }, this.now())).toISOString()
        this.db.update(localServerAutomation).set({ nextRunAt, updatedAt: new Date(this.now()).toISOString() }).where(eq(localServerAutomation.serverId, row.serverId)).run()
      }
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.checkDue() }, CHECK_INTERVAL_MS)
    this.timer.unref()
    void this.checkDue()
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const controller of this.abortControllers.values()) controller.abort()
    const active = this.tickPromise
    if (!active) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([active, new Promise<void>((resolveWait) => {
      timer = setTimeout(resolveWait, timeoutMs)
      timer.unref()
    })])
    if (timer) clearTimeout(timer)
  }

  async get(serverId: string): Promise<ServerAutomation> {
    this.requireManaged(serverId)
    const row = this.db.select().from(localServerAutomation).where(eq(localServerAutomation.serverId, serverId)).get()
    const jobs = this.db.select().from(localServerAutomationJobs).where(eq(localServerAutomationJobs.serverId, serverId))
      .orderBy(desc(localServerAutomationJobs.createdAt)).limit(100).all()
    const unacknowledgedCount = this.db.select({ count: count() }).from(localServerAutomationJobs)
      .where(and(eq(localServerAutomationJobs.serverId, serverId), eq(localServerAutomationJobs.status, 'missed'), isNull(localServerAutomationJobs.acknowledgedAt))).get()?.count ?? 0
    return {
      serverId,
      enabled: row?.backupEnabled ?? false,
      frequency: row?.frequency ?? 'daily',
      localTime: row?.localTime ?? '03:00',
      weekday: row?.weekday ?? null,
      timeZone: row?.timeZone ?? this.timeZone,
      nextRunAt: row?.nextRunAt ?? null,
      lastRunAt: row?.lastRunAt ?? null,
      lastStatus: row?.lastStatus ?? null,
      lastError: row?.lastError ?? null,
      unacknowledgedCount,
      jobs: jobs.map((job) => this.publicJob(job)),
    }
  }

  async update(serverId: string, actorUserId: string, input: ServerAutomationUpdate): Promise<ServerAutomation> {
    this.requireManaged(serverId)
    const atMs = this.now()
    const nextRunAt = input.enabled
      ? new Date(nextAutomationInstant({ frequency: input.frequency, localTime: input.localTime, weekday: input.weekday, timeZone: this.timeZone }, atMs)).toISOString()
      : null
    const at = new Date(atMs).toISOString()
    this.db.transaction((tx) => {
      tx.insert(localServerAutomation).values({
        serverId, backupEnabled: input.enabled, frequency: input.frequency, localTime: input.localTime, weekday: input.weekday,
        timeZone: this.timeZone, nextRunAt, lastRunAt: null, lastStatus: null, lastError: null, updatedBy: actorUserId, updatedAt: at,
      }).onConflictDoUpdate({
        target: localServerAutomation.serverId,
        set: { backupEnabled: input.enabled, frequency: input.frequency, localTime: input.localTime, weekday: input.weekday, timeZone: this.timeZone, nextRunAt, updatedBy: actorUserId, updatedAt: at },
      }).run()
      tx.insert(localServerEvents).values({
        serverId, actorUserId, action: 'server-backup-schedule-updated', outcome: 'success', occurredAt: at,
        detail: JSON.stringify({ enabled: input.enabled, frequency: input.frequency, localTime: input.localTime, weekday: input.weekday, timeZone: this.timeZone }),
      }).run()
    })
    return this.get(serverId)
  }

  async acknowledge(serverId: string, jobId: string, actorUserId: string): Promise<ServerAutomation> {
    this.requireManaged(serverId)
    const row = this.db.select().from(localServerAutomationJobs).where(and(eq(localServerAutomationJobs.id, jobId), eq(localServerAutomationJobs.serverId, serverId))).get()
    if (!row) throw new ServerAutomationError('AUTOMATION_JOB_NOT_FOUND', 'The scheduled task was not found for this server.')
    if (row.status !== 'missed' || row.acknowledgedAt) throw new ServerAutomationError('AUTOMATION_JOB_NOT_ACKNOWLEDGEABLE', 'Only a missed schedule that has not been acknowledged can be acknowledged.')
    const at = new Date(this.now()).toISOString()
    this.db.update(localServerAutomationJobs).set({ acknowledgedAt: at }).where(eq(localServerAutomationJobs.id, jobId)).run()
    this.event(serverId, actorUserId, 'server-backup-schedule-missed-acknowledged', 'success', { jobId })
    return this.get(serverId)
  }

  async checkDue(): Promise<void> {
    if (this.tickPromise) return this.tickPromise
    this.tickPromise = this.runDue().finally(() => { this.tickPromise = null })
    return this.tickPromise
  }

  private async runDue(): Promise<void> {
    const rows = this.db.select().from(localServerAutomation).where(eq(localServerAutomation.backupEnabled, true)).all()
    for (const row of rows) {
      const dueAt = row.nextRunAt ? Date.parse(row.nextRunAt) : NaN
      if (!Number.isFinite(dueAt) || dueAt > this.now()) continue
      const scheduledFor = new Date(dueAt).toISOString()
      const now = this.now()
      const nextRunAt = new Date(nextAutomationInstant({ frequency: row.frequency, localTime: row.localTime, weekday: row.weekday, timeZone: row.timeZone }, Math.max(now, dueAt))).toISOString()
      if (now - dueAt > MISSED_GRACE_MS) {
        this.recordJob(row.serverId, scheduledFor, 'missed', null, new Date(now).toISOString(), 'The API was unavailable past the 10 minute catch-up window. No backup was run.')
        this.updateScheduleAfterRun(row.serverId, scheduledFor, 'missed', 'The API was unavailable past the 10 minute catch-up window. No backup was run.', nextRunAt)
        continue
      }
      const jobId = randomUUID()
      const createdAt = new Date(now).toISOString()
      const inserted = this.db.insert(localServerAutomationJobs).values({
        id: jobId, serverId: row.serverId, kind: 'backup', scheduledFor, status: 'running', startedAt: createdAt,
        finishedAt: null, backupId: null, errorMessage: null, acknowledgedAt: null, createdAt,
      }).onConflictDoNothing().run()
      if (inserted.changes === 0) continue
      this.db.update(localServerAutomation).set({ nextRunAt, updatedAt: createdAt }).where(eq(localServerAutomation.serverId, row.serverId)).run()
      const controller = new AbortController()
      this.abortControllers.set(jobId, controller)
      try {
        const backup = await this.backups.create(row.serverId, null, { signal: controller.signal, origin: 'scheduled' })
        const finishedAt = new Date(this.now()).toISOString()
        this.db.update(localServerAutomationJobs).set({ status: 'completed', finishedAt, backupId: backup.id }).where(eq(localServerAutomationJobs.id, jobId)).run()
        const nextAfterCompletion = new Date(nextAutomationInstant({ frequency: row.frequency, localTime: row.localTime, weekday: row.weekday, timeZone: row.timeZone }, Math.max(this.now(), dueAt))).toISOString()
        this.updateScheduleAfterRun(row.serverId, scheduledFor, 'completed', null, nextAfterCompletion)
        this.event(row.serverId, null, 'server-backup-schedule-completed', 'success', { jobId, backupId: backup.id, scheduledFor })
      } catch (error) {
        const finishedAt = new Date(this.now()).toISOString()
        const message = briefError(error)
        this.db.update(localServerAutomationJobs).set({ status: 'failed', finishedAt, errorMessage: message }).where(eq(localServerAutomationJobs.id, jobId)).run()
        const nextAfterFailure = new Date(nextAutomationInstant({ frequency: row.frequency, localTime: row.localTime, weekday: row.weekday, timeZone: row.timeZone }, Math.max(this.now(), dueAt))).toISOString()
        this.updateScheduleAfterRun(row.serverId, scheduledFor, 'failed', message, nextAfterFailure)
        this.event(row.serverId, null, 'server-backup-schedule-failed', 'failure', { jobId, scheduledFor, message })
      } finally {
        this.abortControllers.delete(jobId)
        this.trimJobs(row.serverId)
      }
    }
  }

  private recordJob(serverId: string, scheduledFor: string, status: 'missed', startedAt: string | null, finishedAt: string, message: string): void {
    const at = new Date(this.now()).toISOString()
    this.db.insert(localServerAutomationJobs).values({
      id: randomUUID(), serverId, kind: 'backup', scheduledFor, status, startedAt, finishedAt,
      backupId: null, errorMessage: message, acknowledgedAt: null, createdAt: at,
    }).onConflictDoNothing().run()
    this.event(serverId, null, 'server-backup-schedule-missed', 'failure', { scheduledFor, message })
  }

  private updateScheduleAfterRun(serverId: string, scheduledFor: string, status: 'completed' | 'failed' | 'missed', error: string | null, nextRunAt: string): void {
    const at = new Date(this.now()).toISOString()
    this.db.update(localServerAutomation).set({ lastRunAt: scheduledFor, lastStatus: status, lastError: error, nextRunAt, updatedAt: at })
      .where(eq(localServerAutomation.serverId, serverId)).run()
  }

  private trimJobs(serverId: string): void {
    const old = this.db.select({ id: localServerAutomationJobs.id }).from(localServerAutomationJobs)
      .where(and(eq(localServerAutomationJobs.serverId, serverId), eq(localServerAutomationJobs.status, 'completed')))
      .orderBy(desc(localServerAutomationJobs.createdAt)).limit(10_000).all().slice(JOB_RETENTION)
    if (old.length) this.db.delete(localServerAutomationJobs).where(inArray(localServerAutomationJobs.id, old.map((job) => job.id))).run()
  }

  private requireManaged(serverId: string): void {
    const server = this.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) throw new ServerAutomationError('SERVER_NOT_FOUND', 'The registered server was not found.')
    if (server.source !== 'created' || !server.managed) throw new ServerAutomationError('SERVER_NOT_PANEL_MANAGED', 'Automation is available only for panel-created servers.')
  }

  private publicJob(row: typeof localServerAutomationJobs.$inferSelect): ServerAutomationJob {
    return {
      id: row.id, kind: row.kind, scheduledFor: row.scheduledFor, status: row.status, startedAt: row.startedAt,
      finishedAt: row.finishedAt, backupId: row.backupId, errorMessage: row.errorMessage, acknowledgedAt: row.acknowledgedAt, createdAt: row.createdAt,
    }
  }

  private event(serverId: string, actorUserId: string | null, action: string, outcome: 'success' | 'failure', detail: Record<string, unknown>): void {
    this.db.insert(localServerEvents).values({ serverId, actorUserId, action, outcome, occurredAt: new Date(this.now()).toISOString(), detail: JSON.stringify(detail) }).run()
  }
}
