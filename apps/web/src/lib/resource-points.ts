import type { MachineResourcePoint } from '@mmsmanager/shared'

export function mergeResourcePoints(persisted: MachineResourcePoint[], live: MachineResourcePoint[], windowMs = Number.POSITIVE_INFINITY): MachineResourcePoint[] {
  const cutoff = Date.now() - windowMs
  const byTimestamp = new Map<number, MachineResourcePoint>()
  for (const point of [...persisted, ...live]) {
    const timestamp = Date.parse(point.observedAt)
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue
    byTimestamp.set(timestamp, point)
  }
  return [...byTimestamp.entries()].sort(([left], [right]) => left - right).map(([, point]) => point)
}

export function chartGapThresholdMs(points: MachineResourcePoint[], bucketSeconds?: number): number {
  if (bucketSeconds !== undefined && Number.isFinite(bucketSeconds) && bucketSeconds > 0) return bucketSeconds * 1000 * 1.75
  const times = [...new Set(points.map((point) => Date.parse(point.observedAt)).filter(Number.isFinite))].sort((left, right) => left - right)
  const intervals = times.slice(1).map((time, index) => time - times[index]!).filter((interval) => interval > 0)
  if (!intervals.length) return 60_000
  intervals.sort((left, right) => left - right)
  return intervals[Math.floor((intervals.length - 1) / 2)]! * 1.75
}

export function normalizeChartPoints(points: MachineResourcePoint[], metric: keyof Pick<MachineResourcePoint, 'cpuPercent' | 'memoryPercent' | 'storagePercent'>) {
  const byTimestamp = new Map<number, { point: MachineResourcePoint; timestamp: number; value: number | null }>()
  for (const point of points) {
    const timestamp = Date.parse(point.observedAt)
    if (!Number.isFinite(timestamp)) continue
    const raw = point[metric]
    const value = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : null
    byTimestamp.set(timestamp, { point, timestamp, value })
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp)
}

export function splitChartSegments(points: ReturnType<typeof normalizeChartPoints>, bucketSeconds?: number) {
  const gapThreshold = chartGapThresholdMs(points.map((item) => item.point), bucketSeconds)
  const segments: typeof points[] = []
  let current: typeof points = []
  for (const item of points) {
    if (item.value === null) {
      if (current.length > 1) segments.push(current)
      current = []
      continue
    }
    const previous = current.at(-1)
    if (previous && item.timestamp - previous.timestamp > gapThreshold) {
      if (current.length > 1) segments.push(current)
      current = [item]
    } else current.push(item)
  }
  if (current.length > 1) segments.push(current)
  return segments.filter((segment) => segment.length > 1)
}
