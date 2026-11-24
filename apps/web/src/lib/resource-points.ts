import type { MachineResourcePoint } from '@mmsmanager/shared'

export function mergeResourcePoints(persisted: MachineResourcePoint[], live: MachineResourcePoint[], windowMs = Number.POSITIVE_INFINITY): MachineResourcePoint[] {
  const cutoff = Date.now() - windowMs
  const byTimestamp = new Map<string, MachineResourcePoint>()
  for (const point of persisted) if (Date.parse(point.observedAt) >= cutoff) byTimestamp.set(point.observedAt, point)
  for (const point of live) if (Date.parse(point.observedAt) >= cutoff) byTimestamp.set(point.observedAt, point)
  return [...byTimestamp.values()].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
}
