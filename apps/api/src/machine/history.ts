import { and, asc, desc, eq, gte, lt, ne, sql } from 'drizzle-orm'
import type { MachineCalendarDay, MachineResourcePoint } from '@mmsmanager/shared'
import { machines, machineDayRollups, machineEvents, machineMinuteRollups, machineSamples } from '../db/schema.js'
import type { AppDatabase } from '../db/client.js'
import { COLLECTOR_INTERVAL_MS, MAX_HISTORY_DAYS } from '../config.js'
import { dateInTimeZone, localDayWindow, validateCalendarDate } from '../time.js'
import type { CollectorHealth } from './collector.js'

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null
  return Math.max(0, Math.min(100, (used / total) * 100))
}

function parseStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function dayStatus(
  date: string,
  sampleCount: number,
  firstSampleAt: string | null,
  lastSampleAt: string | null,
  timeZone: string,
  nowMs: number,
): MachineCalendarDay['status'] {
  const today = dateInTimeZone(nowMs, timeZone)
  if (date > today) return 'future'
  if (sampleCount === 0 || firstSampleAt === null || lastSampleAt === null) return 'no-data'

  const window = localDayWindow(date, timeZone)
  const dayStart = Date.parse(window.from)
  const observedEnd = Math.min(nowMs, Date.parse(window.to))
  const expectedCount = Math.max(1, Math.floor(Math.max(0, observedEnd - dayStart) / COLLECTOR_INTERVAL_MS) + 1)
  const ratio = Math.min(1, sampleCount / expectedCount)
  return ratio >= 0.8 ? 'observed' : 'partial'
}

function coveragePercent(sampleCount: number, date: string, timeZone: string, nowMs: number): number {
  if (sampleCount <= 0) return 0
  const window = localDayWindow(date, timeZone)
  const expectedEnd = Math.min(nowMs, Date.parse(window.to))
  const expected = Math.max(1, Math.floor(Math.max(0, expectedEnd - Date.parse(window.from)) / COLLECTOR_INTERVAL_MS) + 1)
  return Math.max(0, Math.min(100, (sampleCount / expected) * 100))
}

function mapMinutePoint(row: typeof machineMinuteRollups.$inferSelect): MachineResourcePoint {
  const memoryUsed = row.memoryPeakUsedBytes
  const memoryTotal = row.memoryTotalBytes
  const storageUsed = row.storageLastUsedBytes
  const storageTotal = row.storageTotalBytes
  return {
    observedAt: row.lastSampleAt,
    sampleCount: row.sampleCount,
    cpuPercent: row.cpuCount > 0 && row.cpuSum !== null ? row.cpuSum / row.cpuCount : null,
    memoryUsedBytes: memoryUsed,
    memoryTotalBytes: memoryTotal,
    memoryPercent: row.memoryPeakPercent,
    storageUsedBytes: storageUsed,
    storageTotalBytes: storageTotal,
    storagePercent: percent(storageUsed, storageTotal),
    rxBytesPerSecond: row.networkRateCount > 0 && row.networkRxRateSum !== null
      ? row.networkRxRateSum / row.networkRateCount
      : null,
    txBytesPerSecond: row.networkRateCount > 0 && row.networkTxRateSum !== null
      ? row.networkTxRateSum / row.networkRateCount
      : null,
  }
}

function mapRawPoint(row: typeof machineSamples.$inferSelect): MachineResourcePoint {
  return {
    observedAt: row.collectedAt,
    sampleCount: 1,
    cpuPercent: row.cpuPercent,
    memoryUsedBytes: row.memoryUsedBytes,
    memoryTotalBytes: row.memoryTotalBytes,
    memoryPercent: percent(row.memoryUsedBytes, row.memoryTotalBytes),
    storageUsedBytes: row.storageUsedBytes,
    storageTotalBytes: row.storageTotalBytes,
    storagePercent: percent(row.storageUsedBytes, row.storageTotalBytes),
    rxBytesPerSecond: row.networkRxBytesPerSecond,
    txBytesPerSecond: row.networkTxBytesPerSecond,
  }
}

export class MachineHistoryService {
  constructor(
    private readonly db: AppDatabase,
    readonly timeZone: string,
    private readonly now: () => number = Date.now,
  ) {}

  getHealth(collector: CollectorHealth) {
    const latestSample = this.db.select({ collectedAt: machineSamples.collectedAt })
      .from(machineSamples).where(eq(machineSamples.machineId, 'local'))
      .orderBy(desc(machineSamples.collectedAt)).limit(1).get()
    const latestSuccessful = this.db.select({ collectedAt: machineSamples.collectedAt })
      .from(machineSamples).where(and(eq(machineSamples.machineId, 'local'), ne(machineSamples.sampleStatus, 'error')))
      .orderBy(desc(machineSamples.collectedAt)).limit(1).get()
    return {
      service: 'mmsmanager-local-api' as const,
      status: 'ok' as const,
      timeZone: this.timeZone,
      collector: {
        ...collector,
        lastSampleAt: collector.lastSampleAt ?? latestSample?.collectedAt ?? null,
        lastSuccessfulAt: collector.lastSuccessfulAt ?? latestSuccessful?.collectedAt ?? null,
      },
    }
  }

  getCurrent(collector: CollectorHealth) {
    const hostRow = this.db.select().from(machines).where(eq(machines.id, 'local')).limit(1).get()
    const sampleRow = this.db.select().from(machineSamples).where(eq(machineSamples.machineId, 'local'))
      .orderBy(desc(machineSamples.collectedAt)).limit(1).get()
    const lastSuccessful = this.db.select({ collectedAt: machineSamples.collectedAt })
      .from(machineSamples).where(and(eq(machineSamples.machineId, 'local'), ne(machineSamples.sampleStatus, 'error')))
      .orderBy(desc(machineSamples.collectedAt)).limit(1).get()

    const sample = sampleRow ? {
      id: sampleRow.id,
      collectedAt: sampleRow.collectedAt,
      cpuPercent: sampleRow.cpuPercent,
      coreCount: sampleRow.coreCount,
      loadAverage: sampleRow.loadOne !== null && sampleRow.loadFive !== null && sampleRow.loadFifteen !== null
        ? { one: sampleRow.loadOne, five: sampleRow.loadFive, fifteen: sampleRow.loadFifteen }
        : null,
      memory: {
        usedBytes: sampleRow.memoryUsedBytes,
        availableBytes: sampleRow.memoryAvailableBytes,
        totalBytes: sampleRow.memoryTotalBytes,
        swapUsedBytes: sampleRow.swapUsedBytes,
        swapTotalBytes: sampleRow.swapTotalBytes,
        usedPercent: percent(sampleRow.memoryUsedBytes, sampleRow.memoryTotalBytes),
      },
      storage: sampleRow.storageMount ? {
        device: sampleRow.storageDevice,
        mount: sampleRow.storageMount,
        usedBytes: sampleRow.storageUsedBytes,
        availableBytes: sampleRow.storageAvailableBytes,
        totalBytes: sampleRow.storageTotalBytes,
        usedPercent: percent(sampleRow.storageUsedBytes, sampleRow.storageTotalBytes),
      } : null,
      network: {
        interface: sampleRow.networkInterface,
        rxBytesPerSecond: sampleRow.networkRxBytesPerSecond,
        txBytesPerSecond: sampleRow.networkTxBytesPerSecond,
        rxTransferredBytes: sampleRow.networkRxTransferredBytes,
        txTransferredBytes: sampleRow.networkTxTransferredBytes,
      },
      sampleStatus: sampleRow.sampleStatus as 'ok' | 'partial' | 'error',
      unavailableFields: parseStringArray(sampleRow.unavailableFields),
      source: 'systeminformation' as const,
    } : null
    const age = sampleRow ? this.now() - Date.parse(sampleRow.collectedAt) : null
    const status = !sampleRow
      ? 'collecting' as const
      : !collector.running || age === null || age > collector.intervalMs * 2.5
        ? 'stale' as const
        : 'live' as const

    return {
      status,
      timeZone: this.timeZone,
      host: hostRow ? {
        id: 'local' as const,
        hostname: hostRow.hostname,
        platform: hostRow.platform,
        distro: hostRow.distro,
        release: hostRow.release,
        architecture: hostRow.architecture,
        cpuModel: hostRow.cpuModel,
        coreCount: hostRow.coreCount,
        uptimeSeconds: hostRow.uptimeSeconds,
        source: 'systeminformation' as const,
      } : null,
      sample,
      lastSuccessfulAt: collector.lastSuccessfulAt ?? lastSuccessful?.collectedAt ?? null,
      intervalMs: collector.intervalMs,
      provenance: 'LOCAL_HOST' as const,
    }
  }

  getCalendar(year: number, month: number) {
    const firstDate = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01`
    const nextMonth = new Date(Date.UTC(year, month, 1))
    const afterLastDate = `${nextMonth.getUTCFullYear().toString().padStart(4, '0')}-${(nextMonth.getUTCMonth() + 1).toString().padStart(2, '0')}-01`
    const rows = this.db.select().from(machineDayRollups).where(and(
      eq(machineDayRollups.machineId, 'local'),
      eq(machineDayRollups.timeZone, this.timeZone),
      gte(machineDayRollups.localDate, firstDate),
      lt(machineDayRollups.localDate, afterLastDate),
    )).all()
    const indexed = new Map(rows.map((row) => [row.localDate, row]))
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const nowMs = this.now()
    const days: MachineCalendarDay[] = Array.from({ length: daysInMonth }, (_, index) => {
      const date = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${(index + 1).toString().padStart(2, '0')}`
      const row = indexed.get(date)
      const sampleCount = row?.sampleCount ?? 0
      return {
        date,
        status: dayStatus(date, sampleCount, row?.firstSampleAt ?? null, row?.lastSampleAt ?? null, this.timeZone, nowMs),
        sampleCount,
        firstSampleAt: row?.firstSampleAt ?? null,
        lastSampleAt: row?.lastSampleAt ?? null,
        coveragePercent: coveragePercent(sampleCount, date, this.timeZone, nowMs),
      }
    })
    return { year, month, timeZone: this.timeZone, days }
  }

  getDay(date: string) {
    const { year, month } = validateCalendarDate(date)
    const window = localDayWindow(date, this.timeZone)
    const row = this.db.select().from(machineDayRollups).where(and(
      eq(machineDayRollups.machineId, 'local'),
      eq(machineDayRollups.timeZone, this.timeZone),
      eq(machineDayRollups.localDate, date),
    )).limit(1).get()
    const today = dateInTimeZone(this.now(), this.timeZone)
    const sampleCount = row?.sampleCount ?? 0
    const status = dayStatus(date, sampleCount, row?.firstSampleAt ?? null, row?.lastSampleAt ?? null, this.timeZone, this.now())
    const summary = row ? {
      sampleCount,
      firstSampleAt: row.firstSampleAt,
      lastSampleAt: row.lastSampleAt,
      coveragePercent: coveragePercent(sampleCount, date, this.timeZone, this.now()),
      cpuAveragePercent: row.cpuCount > 0 && row.cpuSum !== null ? row.cpuSum / row.cpuCount : null,
      cpuMaximumPercent: row.cpuMaximum,
      memoryPeakUsedBytes: row.memoryPeakUsedBytes,
      memoryTotalBytes: row.memoryTotalBytes,
      memoryPeakPercent: row.memoryPeakPercent,
      storageSnapshotUsedBytes: row.storageSnapshotUsedBytes,
      storagePeakUsedBytes: row.storagePeakUsedBytes,
      storageTotalBytes: row.storageTotalBytes,
      networkReceivedBytes: row.networkReceivedBytes,
      networkTransmittedBytes: row.networkTransmittedBytes,
    } : null
    const points = this.db.select().from(machineMinuteRollups).where(and(
      eq(machineMinuteRollups.machineId, 'local'),
      eq(machineMinuteRollups.timeZone, this.timeZone),
      eq(machineMinuteRollups.localDate, date),
      gte(machineMinuteRollups.minuteStart, window.from),
      lt(machineMinuteRollups.minuteStart, window.to),
    )).orderBy(asc(machineMinuteRollups.minuteStart)).all().map(mapMinutePoint)
    const events = this.db.select().from(machineEvents).where(and(
      eq(machineEvents.machineId, 'local'),
      eq(machineEvents.timeZone, this.timeZone),
      eq(machineEvents.localDate, date),
    )).orderBy(asc(machineEvents.occurredAt)).limit(100).all().map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt,
      category: event.category as 'collector' | 'sample',
      severity: event.severity as 'info' | 'warning' | 'error',
      message: event.message,
      source: 'local-backend' as const,
    }))
    return {
      date,
      timeZone: this.timeZone,
      status: date > today ? 'future' as const : status,
      summary: date > today ? null : summary,
      points,
      events: date > today ? [] : events,
      window,
      calendar: { year, month },
    }
  }

  getHistory(from: string, to: string, requestedLimit: number) {
    const fromMs = Date.parse(from)
    const toMs = Date.parse(to)
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new RangeError('Invalid time range')
    if (toMs - fromMs > MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000) throw new RangeError('History range exceeds 31 days')
    const durationMs = toMs - fromMs
    const limit = requestedLimit
    const resolution = durationMs <= 60 * 60 * 1000 ? 'raw' as const : 'minute' as const
    let points: MachineResourcePoint[]

    if (resolution === 'raw') {
      const rows = this.db.select().from(machineSamples).where(and(
        eq(machineSamples.machineId, 'local'),
        gte(machineSamples.collectedAt, from),
        lt(machineSamples.collectedAt, to),
      )).orderBy(asc(machineSamples.collectedAt)).limit(Math.min(360, limit * 4)).all()
      points = downsample(rows.map(mapRawPoint), limit)
    } else {
      const bucketSeconds = Math.max(60, Math.ceil(durationMs / limit / 60_000) * 60)
      const rows = this.db.select().from(machineMinuteRollups).where(and(
        eq(machineMinuteRollups.machineId, 'local'),
        eq(machineMinuteRollups.timeZone, this.timeZone),
        gte(machineMinuteRollups.minuteStart, from),
        lt(machineMinuteRollups.minuteStart, to),
        sql`CAST(strftime('%s', ${machineMinuteRollups.minuteStart}) AS INTEGER) % ${bucketSeconds} = 0`,
      )).orderBy(asc(machineMinuteRollups.minuteStart)).limit(limit).all()
      points = rows.map(mapMinutePoint)
    }
    return { from, to, timeZone: this.timeZone, resolution, points }
  }
}

function downsample(points: MachineResourcePoint[], limit: number): MachineResourcePoint[] {
  if (points.length <= limit) return points
  if (limit === 1) return [points[points.length - 1]!]
  const step = (points.length - 1) / (limit - 1)
  return Array.from({ length: limit }, (_, index) => points[Math.round(index * step)]!)
}
