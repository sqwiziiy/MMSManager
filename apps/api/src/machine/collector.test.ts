import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { asc } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { machineDayRollups, machineEvents, machineMinuteRollups, machineSamples, machineStorageSamples } from '../db/schema.js'
import { MachineCollector } from './collector.js'
import type { CollectedSnapshot, SnapshotReader } from './reader.js'
import { MachineStorageHistoryService } from './storage-history.js'
import type { StorageVolumeReading } from './storage-volumes.js'

let temporaryDirectory: string | undefined

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

function snapshot(cpu: number, usedMemory: number, storageUsed: number, received = 100, transmitted = 50, storageVolumes?: CollectedSnapshot['storageVolumes']): CollectedSnapshot {
  return {
    host: {
      id: 'local', hostname: 'test-node', platform: 'linux', distro: 'Test Linux', release: '1.0',
      architecture: 'x64', cpuModel: 'Example CPU', coreCount: 4, uptimeSeconds: 1234, source: 'systeminformation',
    },
    ...(storageVolumes ? { storageVolumes } : {}),
    sample: {
      cpuPercent: cpu,
      coreCount: 4,
      loadAverage: { one: 0.3, five: 0.2, fifteen: 0.1 },
      memory: {
        usedBytes: usedMemory, availableBytes: 1000 - usedMemory, totalBytes: 1000,
        swapUsedBytes: 0, swapTotalBytes: 0, usedPercent: (usedMemory / 1000) * 100,
      },
      storage: {
        device: '/dev/test', mount: '/', usedBytes: storageUsed,
        availableBytes: 1000 - storageUsed, totalBytes: 1000, usedPercent: (storageUsed / 1000) * 100,
      },
      network: {
        interface: 'eth0', rxBytesPerSecond: received / 10, txBytesPerSecond: transmitted / 10,
        rxTransferredBytes: received, txTransferredBytes: transmitted,
      },
      sampleStatus: 'ok', unavailableFields: [], source: 'systeminformation',
    },
  }
}

class QueueReader implements SnapshotReader {
  constructor(private readonly values: CollectedSnapshot[]) {}
  async read(): Promise<CollectedSnapshot> {
    const value = this.values.shift()
    if (!value) throw new Error('No fixture snapshot remains')
    return value
  }
}

describe('machine collector persistence', () => {
  it('writes one raw sample and updates real-unit minute/day rollups transactionally', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    let now = Date.parse('2026-11-23T10:00:00.000Z')
    const collector = new MachineCollector(
      opened.db,
      new QueueReader([snapshot(25, 100, 200, 100, 50), snapshot(75, 300, 400, 300, 150)]),
      'Europe/Paris',
      10_000,
      () => now,
    )

    await collector.collectOnce()
    now += 10_000
    await collector.collectOnce()

    const samples = opened.db.select().from(machineSamples).orderBy(asc(machineSamples.collectedAt)).all()
    const minutes = opened.db.select().from(machineMinuteRollups).all()
    const days = opened.db.select().from(machineDayRollups).all()
    expect(samples).toHaveLength(2)
    expect(minutes).toHaveLength(1)
    expect(minutes[0]?.sampleCount).toBe(2)
    expect(minutes[0]?.cpuSum && minutes[0].cpuSum / minutes[0].cpuCount).toBe(50)
    expect(days).toHaveLength(1)
    expect(days[0]?.cpuMaximum).toBe(75)
    expect(days[0]?.memoryPeakUsedBytes).toBe(300)
    expect(days[0]?.memoryPeakPercent).toBe(30)
    expect(days[0]?.storageSnapshotUsedBytes).toBe(400)
    expect(days[0]?.storagePeakUsedBytes).toBe(400)
    expect(days[0]?.networkReceivedBytes).toBe(400)
    expect(days[0]?.networkTransmittedBytes).toBe(200)
    expect(collector.health.lastSuccessfulAt).toBe('2026-11-23T10:00:10.000Z')
    opened.native.close()
  })

  it('does not duplicate a sample or rollup when a collection timestamp repeats', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    const now = Date.parse('2026-11-23T10:00:00.000Z')
    const collector = new MachineCollector(opened.db, new QueueReader([snapshot(20, 200, 300), snapshot(20, 200, 300)]), 'UTC', 10_000, () => now)
    await collector.collectOnce()
    await collector.collectOnce()
    expect(opened.db.select().from(machineSamples).all()).toHaveLength(1)
    expect(opened.db.select().from(machineMinuteRollups).get()?.sampleCount).toBe(1)
    expect(opened.db.select().from(machineDayRollups).get()?.sampleCount).toBe(1)
    opened.native.close()
  })

  it('keeps a fast in-memory sampler while persisting at a slower cadence and aggregating observed peaks', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    const start = Date.parse('2026-11-23T10:00:00.000Z')
    let now = start
    const collector = new MachineCollector(
      opened.db,
      new QueueReader([snapshot(10, 100, 200), snapshot(10, 100, 200), snapshot(20, 200, 300), snapshot(90, 800, 700), snapshot(20, 200, 300), snapshot(10, 100, 200)]),
      'UTC',
      1_000,
      () => now,
      5_000,
    )
    for (let index = 0; index <= 5; index += 1) {
      now = start + index * 1_000
      await collector.collectOnce()
    }
    const samples = opened.db.select().from(machineSamples).orderBy(asc(machineSamples.collectedAt)).all()
    const minute = opened.db.select().from(machineMinuteRollups).get()
    expect(samples).toHaveLength(2)
    expect(minute?.sampleCount).toBe(2)
    expect(minute?.cpuCount).toBe(6)
    expect(minute?.cpuSum && minute.cpuSum / minute.cpuCount).toBeCloseTo(26.67, 1)
    expect(minute?.cpuMaximum).toBe(90)
    expect(minute?.memoryPeakUsedBytes).toBe(800)
    expect(minute?.storagePeakUsedBytes).toBe(700)
    opened.native.close()
  })

  it('reopens the SQLite file with samples and rollups intact', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'mmsmanager-reopen-'))
    const databasePath = join(temporaryDirectory, 'mmsmanager.sqlite')
    const opened = await openDatabase({ path: databasePath })
    const collector = new MachineCollector(
      opened.db,
      new QueueReader([snapshot(42, 450, 500)]),
      'Europe/Paris',
      10_000,
      () => Date.parse('2026-11-23T11:00:00.000Z'),
    )
    await collector.collectOnce()
    opened.native.close()

    const reopened = await openDatabase({ path: databasePath })
    expect(reopened.db.select().from(machineSamples).all()).toHaveLength(1)
    expect(reopened.db.select().from(machineDayRollups).get()?.memoryPeakUsedBytes).toBe(450)
    reopened.native.close()
  })

  it('persists role-labeled volumes transactionally and exposes bounded saved history', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    const volume: StorageVolumeReading = {
      id: 'a'.repeat(64), name: 'Server data', roles: ['server-data', 'application-data'],
      usedBytes: 700, availableBytes: 300, totalBytes: 1000, usedPercent: 70,
      collectedAt: '2026-11-23T10:00:00.000Z',
    }
    let now = Date.parse('2026-11-23T10:00:00.000Z')
    const collector = new MachineCollector(opened.db, new QueueReader([
      snapshot(20, 200, 300, 100, 50, [volume]),
      snapshot(25, 220, 320, 120, 60, [volume]),
    ]), 'UTC', 10_000, () => now)
    await collector.collectOnce()
    now += 10_000
    await collector.collectOnce()

    const saved = opened.db.select().from(machineStorageSamples).all()
    const result = new MachineStorageHistoryService(opened.db, () => now).get({ limit: 500 })
    expect(saved).toHaveLength(1)
    expect(JSON.parse(saved[0]!.roles)).toEqual(['server-data', 'application-data'])
    expect(result.volumes).toHaveLength(1)
    expect(result.volumes[0]).toMatchObject({ id: volume.id, name: 'Server data', roles: ['server-data', 'application-data'], usedBytes: 700 })
    expect(result.history[0]?.points).toHaveLength(1)
    expect(result.history[0]?.points[0]).toMatchObject({ collectedAt: volume.collectedAt, usedPercent: 70 })
    expect(result.historyRetentionDays).toBe(30)
    expect(new MachineStorageHistoryService(opened.db, () => now).get({ limit: 500 }, []).volumes).toHaveLength(0)
    opened.native.close()
  })

  it('retains daily rollups after deleting raw samples beyond the seven-day window', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    let now = Date.parse('2026-01-01T12:00:00.000Z')
    const collector = new MachineCollector(opened.db, new QueueReader([snapshot(10, 100, 200), snapshot(80, 700, 800)]), 'UTC', 10_000, () => now)
    await collector.collectOnce()
    now += 9 * 24 * 60 * 60 * 1000
    await collector.collectOnce()

    expect(opened.db.select().from(machineSamples).all()).toHaveLength(1)
    expect(opened.db.select().from(machineMinuteRollups).all()).toHaveLength(2)
    expect(opened.db.select().from(machineDayRollups).all()).toHaveLength(2)
    opened.native.close()
  })

  it('records collector start and recovers after one sampling failure', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    const reader = {
      read: vi.fn<SnapshotReader['read']>()
        .mockRejectedValueOnce(new Error('private system error'))
        .mockResolvedValueOnce(snapshot(55, 350, 440)),
    }
    const collector = new MachineCollector(opened.db, reader, 'UTC', 10_000, () => Date.parse('2026-11-23T10:00:00.000Z'))
    await collector.collectOnce()
    await collector.collectOnce()
    const events = opened.db.select().from(machineEvents).orderBy(asc(machineEvents.occurredAt)).all()
    expect(events.map((event) => event.message)).toEqual([
      'Local machine collector started.',
      'The local metrics collector could not sample the host.',
      'Local machine sampling recovered.',
    ])
    expect(events.some((event) => event.message.includes('private system error'))).toBe(false)
    expect(opened.db.select().from(machineSamples).all()).toHaveLength(1)
    opened.native.close()
  })
})
