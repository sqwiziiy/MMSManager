import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client.js'
import { MachineCollector } from './collector.js'
import { MachineHistoryService } from './history.js'
import type { CollectedSnapshot, SnapshotReader } from './reader.js'

function snapshot(cpu: number): CollectedSnapshot {
  return {
    host: {
      id: 'local', hostname: 'history-fixture', platform: 'linux', distro: 'Fixture Linux', release: '1',
      architecture: 'x64', cpuModel: 'Fixture CPU', coreCount: 2, uptimeSeconds: 100, source: 'systeminformation',
    },
    sample: {
      cpuPercent: cpu, coreCount: 2, loadAverage: null,
      memory: { usedBytes: 400, availableBytes: 600, totalBytes: 1000, swapUsedBytes: 0, swapTotalBytes: 0, usedPercent: 40 },
      storage: { device: '/dev/fixture', mount: '/', usedBytes: 200, availableBytes: 800, totalBytes: 1000, usedPercent: 20 },
      network: { interface: 'fixture0', rxBytesPerSecond: 10, txBytesPerSecond: 20, rxTransferredBytes: 100, txTransferredBytes: 200 },
      sampleStatus: 'ok', unavailableFields: [], source: 'systeminformation',
    },
  }
}

describe('machine history selection', () => {
  it('aggregates minutes chronologically and keeps both range boundaries', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    let now = Date.parse('2026-11-23T10:00:00.000Z')
    let cpu = 0
    const reader: SnapshotReader = { read: async () => snapshot((cpu += 1) % 100) }
    const collector = new MachineCollector(opened.db, reader, 'UTC', 10_000, () => now)
    for (let index = 0; index <= 720; index += 1) {
      now = Date.parse('2026-11-23T10:00:00.000Z') + index * 10_000
      await collector.collectOnce()
    }

    const from = '2026-11-23T10:00:00.000Z'
    const to = '2026-11-23T12:00:00.000Z'
    const result = new MachineHistoryService(opened.db, 'UTC', () => Date.parse(to)).getHistory(from, to, 10)
    expect(result.resolution).toBe('minute')
    expect(result.bucketSeconds).toBe(720)
    expect(result.points).toHaveLength(10)
    expect(result.points[0]?.observedAt).toBe('2026-11-23T10:11:50.000Z')
    expect(result.points.at(-1)?.observedAt).toBe('2026-11-23T11:59:50.000Z')
    expect(result.points[0]?.cpuPercent).toBeGreaterThan(0)
    expect(result.points.every((point, index, points) => index === 0 || Date.parse(point.observedAt) > Date.parse(points[index - 1]!.observedAt))).toBe(true)
    expect(result.coveragePercent).toBeGreaterThan(90)
    opened.native.close()
  })

  it('keeps the newest raw samples when a short interval is downsampled', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    let now = Date.parse('2026-11-23T10:00:00.000Z')
    let cpu = 0
    const collector = new MachineCollector(opened.db, { read: async () => snapshot((cpu += 1) % 100) }, 'UTC', 1_000, () => now, 1_000)
    for (let index = 0; index <= 60; index += 1) {
      now = Date.parse('2026-11-23T10:00:00.000Z') + index * 1_000
      await collector.collectOnce()
    }
    const from = '2026-11-23T10:00:00.000Z'
    const to = '2026-11-23T10:01:00.000Z'
    const result = new MachineHistoryService(opened.db, 'UTC', () => Date.parse(to)).getHistory(from, to, 6)
    expect(result.resolution).toBe('raw')
    expect(result.points).toHaveLength(6)
    expect(result.points[0]?.observedAt).toBe('2026-11-23T10:00:09.000Z')
    expect(result.points.at(-1)?.observedAt).toBe('2026-11-23T10:00:59.000Z')
    expect(result.points[0]?.sampleCount).toBeGreaterThan(1)
    opened.native.close()
  })

  it('returns a valid empty series and preserves a lone sample', async () => {
    const opened = await openDatabase({ path: ':memory:' })
    const history = new MachineHistoryService(opened.db, 'UTC')
    const empty = history.getHistory('2026-11-23T10:00:00.000Z', '2026-11-23T10:00:30.000Z', 10)
    expect(empty.points).toEqual([])
    expect(empty.coveragePercent).toBe(0)
    const collector = new MachineCollector(opened.db, { read: async () => snapshot(12) }, 'UTC', 10_000, () => Date.parse('2026-11-23T10:00:10.000Z'))
    await collector.collectOnce()
    const lone = history.getHistory('2026-11-23T10:00:00.000Z', '2026-11-23T10:00:30.000Z', 10)
    expect(lone.points).toHaveLength(1)
    expect(lone.points[0]?.cpuPercent).toBe(12)
    opened.native.close()
  })
})
