import { describe, expect, it } from 'vitest'
import type { MachineResourcePoint } from '@mmsmanager/shared'
import { chartGapThresholdMs, mergeResourcePoints, normalizeChartPoints, splitChartSegments } from './resource-points'

function point(observedAt: string, cpuPercent: number | null): MachineResourcePoint {
  return {
    observedAt, sampleCount: 1, cpuPercent, memoryUsedBytes: null, memoryTotalBytes: null, memoryPercent: null,
    storageUsedBytes: null, storageTotalBytes: null, storagePercent: null, rxBytesPerSecond: null, txBytesPerSecond: null,
  }
}

describe('resource chart point preparation', () => {
  it('sorts dense samples and keeps ordinary one-second cadence in one solid segment', () => {
    const input = [point('2026-11-26T12:00:02.000Z', 12), point('2026-11-26T12:00:00.000Z', 10), point('2026-11-26T12:00:01.000Z', 11)]
    const ordered = normalizeChartPoints(input, 'cpuPercent')
    expect(ordered.map((entry) => entry.point.observedAt)).toEqual([
      '2026-11-26T12:00:00.000Z', '2026-11-26T12:00:01.000Z', '2026-11-26T12:00:02.000Z',
    ])
    expect(splitChartSegments(ordered, 1)).toHaveLength(1)
    expect(splitChartSegments(ordered, 1)[0]).toHaveLength(3)
  })

  it('uses the declared bucket cadence for sparse rollups', () => {
    const sparse = [point('2026-11-26T12:00:00.000Z', 20), point('2026-11-26T12:01:00.000Z', 22), point('2026-11-26T12:02:00.000Z', 21)]
    expect(chartGapThresholdMs(sparse, 60)).toBe(105_000)
    expect(splitChartSegments(normalizeChartPoints(sparse, 'cpuPercent'), 60)).toHaveLength(1)
  })

  it('deduplicates overlapping historical and live points by UTC instant, with the live sample taking precedence', () => {
    const historical = point('2026-11-26T12:00:00.000Z', 30)
    const live = point('2026-11-26T13:00:00+01:00', 33)
    const merged = mergeResourcePoints([point('2026-11-26T12:00:01.000Z', 31), historical], [live])
    expect(merged.map((entry) => entry.observedAt)).toEqual(['2026-11-26T13:00:00+01:00', '2026-11-26T12:00:01.000Z'])
    expect(normalizeChartPoints(merged, 'cpuPercent')[0]?.value).toBe(33)
  })

  it('leaves real time gaps and explicit null samples between separate line segments', () => {
    const readings = [
      point('2026-11-26T12:00:00.000Z', 20), point('2026-11-26T12:00:01.000Z', 21),
      point('2026-11-26T12:00:02.000Z', null), point('2026-11-26T12:00:03.000Z', 22),
      point('2026-11-26T12:10:00.000Z', 35), point('2026-11-26T12:10:01.000Z', 36),
    ]
    const segments = splitChartSegments(normalizeChartPoints(readings, 'cpuPercent'), 1)
    expect(segments.map((segment) => segment.map((entry) => entry.value))).toEqual([[20, 21], [22], [35, 36]].filter((segment) => segment.length > 1))
  })

  it('ignores invalid timestamps and invalid percentage values without changing persisted readings', () => {
    const normalized = normalizeChartPoints([
      point('not-a-date', 50), point('2026-11-26T12:00:00.000Z', Number.NaN), point('2026-11-26T12:00:01.000Z', 50),
    ], 'cpuPercent')
    expect(normalized.map((entry) => entry.value)).toEqual([null, 50])
    expect(splitChartSegments(normalized, 1)).toEqual([])
  })
})
