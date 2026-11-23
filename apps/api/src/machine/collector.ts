import { lt, sql } from 'drizzle-orm'
import type { SQL, SQLWrapper } from 'drizzle-orm'
import { machines, machineDayRollups, machineEvents, machineMinuteRollups, machineSamples } from '../db/schema.js'
import type { AppDatabase } from '../db/client.js'
import { COLLECTOR_INTERVAL_MS, EVENT_RETENTION_DAYS, MINUTE_RETENTION_DAYS, RAW_RETENTION_DAYS } from '../config.js'
import { dateInTimeZone, utcMinuteBucket } from '../time.js'
import type { CollectedSnapshot, SnapshotReader } from './reader.js'

const DAY_MS = 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

export type CollectorHealth = {
  running: boolean
  intervalMs: number
  lastSampleAt: string | null
  lastSuccessfulAt: string | null
}

type SampleInsert = typeof machineSamples.$inferInsert

function sampleInsert(snapshot: CollectedSnapshot, timestamp: string, timeZone: string): SampleInsert {
  const { host, sample } = snapshot
  return {
    machineId: host.id,
    collectedAt: timestamp,
    minuteStart: utcMinuteBucket(timestamp),
    localDate: dateInTimeZone(Date.parse(timestamp), timeZone),
    timeZone,
    cpuPercent: sample.cpuPercent,
    coreCount: sample.coreCount,
    loadOne: sample.loadAverage?.one ?? null,
    loadFive: sample.loadAverage?.five ?? null,
    loadFifteen: sample.loadAverage?.fifteen ?? null,
    memoryUsedBytes: sample.memory.usedBytes,
    memoryAvailableBytes: sample.memory.availableBytes,
    memoryTotalBytes: sample.memory.totalBytes,
    swapUsedBytes: sample.memory.swapUsedBytes,
    swapTotalBytes: sample.memory.swapTotalBytes,
    storageDevice: sample.storage?.device ?? null,
    storageMount: sample.storage?.mount ?? null,
    storageUsedBytes: sample.storage?.usedBytes ?? null,
    storageAvailableBytes: sample.storage?.availableBytes ?? null,
    storageTotalBytes: sample.storage?.totalBytes ?? null,
    networkInterface: sample.network.interface,
    networkRxBytesPerSecond: sample.network.rxBytesPerSecond,
    networkTxBytesPerSecond: sample.network.txBytesPerSecond,
    networkRxTransferredBytes: sample.network.rxTransferredBytes,
    networkTxTransferredBytes: sample.network.txTransferredBytes,
    sampleStatus: sample.sampleStatus,
    unavailableFields: JSON.stringify(sample.unavailableFields),
    source: sample.source,
  }
}

function nullableAdd(column: SQLWrapper, value: number | null): SQL {
  return value === null ? sql`${column}` : sql`coalesce(${column}, 0) + ${value}`
}

function nullablePeak(column: SQLWrapper, value: number | null): SQL {
  return value === null
    ? sql`${column}`
    : sql`CASE WHEN ${column} IS NULL OR ${value} > ${column} THEN ${value} ELSE ${column} END`
}

function nullableMinimum(column: SQLWrapper, value: number | null): SQL {
  return value === null
    ? sql`${column}`
    : sql`CASE WHEN ${column} IS NULL OR ${value} < ${column} THEN ${value} ELSE ${column} END`
}

function nullableLatest(current: number | null, column: SQLWrapper): SQL | number | null {
  return current === null ? sql`${column}` : current
}

function recordSampleAndRollups(db: AppDatabase, snapshot: CollectedSnapshot, timestamp: string, timeZone: string): boolean {
  const { host, sample } = snapshot
  const stored = db.transaction((transaction) => {
    transaction.insert(machines).values({
      id: host.id,
      hostname: host.hostname,
      platform: host.platform,
      distro: host.distro,
      release: host.release,
      architecture: host.architecture,
      cpuModel: host.cpuModel,
      coreCount: host.coreCount,
      uptimeSeconds: host.uptimeSeconds,
      source: host.source,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
    }).onConflictDoUpdate({
      target: machines.id,
      set: {
        hostname: host.hostname,
        platform: host.platform,
        distro: host.distro,
        release: host.release,
        architecture: host.architecture,
        cpuModel: host.cpuModel,
        coreCount: host.coreCount,
        uptimeSeconds: host.uptimeSeconds,
        lastSeenAt: timestamp,
      },
    }).run()

    const inserted = transaction.insert(machineSamples).values(sampleInsert(snapshot, timestamp, timeZone))
      .onConflictDoNothing().returning({ id: machineSamples.id }).all()
    if (!inserted.length) return false

    const localDate = dateInTimeZone(Date.parse(timestamp), timeZone)
    const minuteStart = utcMinuteBucket(timestamp)
    const cpu = sample.cpuPercent
    const memoryUsed = sample.memory.usedBytes
    const memoryTotal = sample.memory.totalBytes
    const storageUsed = sample.storage?.usedBytes ?? null
    const storageTotal = sample.storage?.totalBytes ?? null
    const rx = sample.network.rxBytesPerSecond
    const tx = sample.network.txBytesPerSecond
    const received = sample.network.rxTransferredBytes
    const transmitted = sample.network.txTransferredBytes
    const validNetwork = rx !== null && tx !== null

    transaction.insert(machineMinuteRollups).values({
      machineId: host.id,
      timeZone,
      localDate,
      minuteStart,
      sampleCount: 1,
      cpuSum: cpu,
      cpuCount: cpu === null ? 0 : 1,
      cpuMinimum: cpu,
      cpuMaximum: cpu,
      memoryPeakUsedBytes: memoryUsed,
      memoryTotalBytes: memoryTotal,
      memoryPeakPercent: sample.memory.usedPercent,
      storageLastUsedBytes: storageUsed,
      storagePeakUsedBytes: storageUsed,
      storageTotalBytes: storageTotal,
      networkRxRateSum: rx,
      networkTxRateSum: tx,
      networkRateCount: validNetwork ? 1 : 0,
      networkReceivedBytes: received,
      networkTransmittedBytes: transmitted,
      firstSampleAt: timestamp,
      lastSampleAt: timestamp,
    }).onConflictDoUpdate({
      target: [machineMinuteRollups.machineId, machineMinuteRollups.timeZone, machineMinuteRollups.minuteStart],
      set: {
        sampleCount: sql`${machineMinuteRollups.sampleCount} + 1`,
        cpuSum: nullableAdd(machineMinuteRollups.cpuSum, cpu),
        cpuCount: sql`${machineMinuteRollups.cpuCount} + ${cpu === null ? 0 : 1}`,
        cpuMinimum: nullableMinimum(machineMinuteRollups.cpuMinimum, cpu),
        cpuMaximum: nullablePeak(machineMinuteRollups.cpuMaximum, cpu),
        memoryPeakUsedBytes: nullablePeak(machineMinuteRollups.memoryPeakUsedBytes, memoryUsed),
        memoryTotalBytes: nullableLatest(memoryTotal, machineMinuteRollups.memoryTotalBytes),
        memoryPeakPercent: nullablePeak(machineMinuteRollups.memoryPeakPercent, sample.memory.usedPercent),
        storageLastUsedBytes: nullableLatest(storageUsed, machineMinuteRollups.storageLastUsedBytes),
        storagePeakUsedBytes: nullablePeak(machineMinuteRollups.storagePeakUsedBytes, storageUsed),
        storageTotalBytes: nullableLatest(storageTotal, machineMinuteRollups.storageTotalBytes),
        networkRxRateSum: nullableAdd(machineMinuteRollups.networkRxRateSum, rx),
        networkTxRateSum: nullableAdd(machineMinuteRollups.networkTxRateSum, tx),
        networkRateCount: sql`${machineMinuteRollups.networkRateCount} + ${validNetwork ? 1 : 0}`,
        networkReceivedBytes: nullableAdd(machineMinuteRollups.networkReceivedBytes, received),
        networkTransmittedBytes: nullableAdd(machineMinuteRollups.networkTransmittedBytes, transmitted),
        firstSampleAt: sql`min(${machineMinuteRollups.firstSampleAt}, ${timestamp})`,
        lastSampleAt: sql`max(${machineMinuteRollups.lastSampleAt}, ${timestamp})`,
      },
    }).run()

    transaction.insert(machineDayRollups).values({
      machineId: host.id,
      timeZone,
      localDate,
      sampleCount: 1,
      cpuSum: cpu,
      cpuCount: cpu === null ? 0 : 1,
      cpuMinimum: cpu,
      cpuMaximum: cpu,
      memoryPeakUsedBytes: memoryUsed,
      memoryTotalBytes: memoryTotal,
      memoryPeakPercent: sample.memory.usedPercent,
      storageSnapshotUsedBytes: storageUsed,
      storagePeakUsedBytes: storageUsed,
      storageTotalBytes: storageTotal,
      networkReceivedBytes: received,
      networkTransmittedBytes: transmitted,
      firstSampleAt: timestamp,
      lastSampleAt: timestamp,
    }).onConflictDoUpdate({
      target: [machineDayRollups.machineId, machineDayRollups.timeZone, machineDayRollups.localDate],
      set: {
        sampleCount: sql`${machineDayRollups.sampleCount} + 1`,
        cpuSum: nullableAdd(machineDayRollups.cpuSum, cpu),
        cpuCount: sql`${machineDayRollups.cpuCount} + ${cpu === null ? 0 : 1}`,
        cpuMinimum: nullableMinimum(machineDayRollups.cpuMinimum, cpu),
        cpuMaximum: nullablePeak(machineDayRollups.cpuMaximum, cpu),
        memoryPeakUsedBytes: nullablePeak(machineDayRollups.memoryPeakUsedBytes, memoryUsed),
        memoryTotalBytes: nullableLatest(memoryTotal, machineDayRollups.memoryTotalBytes),
        memoryPeakPercent: nullablePeak(machineDayRollups.memoryPeakPercent, sample.memory.usedPercent),
        storageSnapshotUsedBytes: nullableLatest(storageUsed, machineDayRollups.storageSnapshotUsedBytes),
        storagePeakUsedBytes: nullablePeak(machineDayRollups.storagePeakUsedBytes, storageUsed),
        storageTotalBytes: nullableLatest(storageTotal, machineDayRollups.storageTotalBytes),
        networkReceivedBytes: nullableAdd(machineDayRollups.networkReceivedBytes, received),
        networkTransmittedBytes: nullableAdd(machineDayRollups.networkTransmittedBytes, transmitted),
        firstSampleAt: sql`min(${machineDayRollups.firstSampleAt}, ${timestamp})`,
        lastSampleAt: sql`max(${machineDayRollups.lastSampleAt}, ${timestamp})`,
      },
    }).run()

    return true
  })
  return stored
}

export class MachineCollector {
  private timer: NodeJS.Timeout | undefined
  private activeRun: Promise<void> | undefined
  private running = false
  private startupRecorded = false
  private errorActive = false
  private lastCleanupAt = 0
  private lastSampleAt: string | null = null
  private lastSuccessfulAt: string | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly reader: SnapshotReader,
    private readonly timeZone: string,
    private readonly intervalMs = COLLECTOR_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get health(): CollectorHealth {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      lastSampleAt: this.lastSampleAt,
      lastSuccessfulAt: this.lastSuccessfulAt,
    }
  }

  start(): void {
    if (this.timer) return
    this.running = true
    this.timer = setInterval(() => { void this.collectOnce() }, this.intervalMs)
    this.timer.unref()
    void this.collectOnce()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.running = false
    await this.activeRun
  }

  async collectOnce(): Promise<void> {
    if (this.activeRun) return this.activeRun
    const task = this.collectAndPersist()
    this.activeRun = task
    try {
      await task
    } finally {
      if (this.activeRun === task) this.activeRun = undefined
    }
  }

  private async collectAndPersist(): Promise<void> {
    const timestamp = new Date(this.now()).toISOString()
    try {
      if (!this.startupRecorded) {
        this.recordEvent(timestamp, 'info', 'Local machine collector started.')
        this.startupRecorded = true
      }
      const snapshot = await this.reader.read()
      const inserted = recordSampleAndRollups(this.db, snapshot, timestamp, this.timeZone)
      if (inserted) {
        this.lastSampleAt = timestamp
        if (snapshot.sample.sampleStatus !== 'error') this.lastSuccessfulAt = timestamp
      }
      if (this.errorActive) {
        this.recordEvent(timestamp, 'info', 'Local machine sampling recovered.')
        this.errorActive = false
      }
      if (timestampDateMs(timestamp) - this.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        this.cleanup(timestampDateMs(timestamp))
        this.lastCleanupAt = timestampDateMs(timestamp)
      }
    } catch {
      if (!this.errorActive) {
        this.recordEvent(timestamp, 'error', 'The local metrics collector could not sample the host.')
        this.errorActive = true
      }
    }
  }

  private recordEvent(timestamp: string, severity: 'info' | 'warning' | 'error', message: string): void {
    this.db.insert(machineEvents).values({
      machineId: 'local',
      occurredAt: timestamp,
      timeZone: this.timeZone,
      localDate: dateInTimeZone(Date.parse(timestamp), this.timeZone),
      category: severity === 'error' ? 'sample' : 'collector',
      severity,
      message,
      source: 'local-backend',
    }).run()
  }

  private cleanup(nowMs: number): void {
    const rawCutoff = new Date(nowMs - RAW_RETENTION_DAYS * DAY_MS).toISOString()
    const minuteCutoff = new Date(nowMs - MINUTE_RETENTION_DAYS * DAY_MS).toISOString()
    const eventCutoff = new Date(nowMs - EVENT_RETENTION_DAYS * DAY_MS).toISOString()
    this.db.transaction((transaction) => {
      transaction.delete(machineSamples).where(lt(machineSamples.collectedAt, rawCutoff)).run()
      transaction.delete(machineMinuteRollups).where(lt(machineMinuteRollups.minuteStart, minuteCutoff)).run()
      transaction.delete(machineEvents).where(lt(machineEvents.occurredAt, eventCutoff)).run()
    })
  }
}

function timestampDateMs(timestamp: string): number {
  return Date.parse(timestamp)
}
