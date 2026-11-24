import { and, asc, desc, eq, gte, lte } from 'drizzle-orm'
import type { MachineStorage } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { machineStorageSamples } from '../db/schema.js'
import type { StorageVolumeRole } from './storage-volumes.js'
import type { StorageVolumeReading } from './storage-volumes.js'

const STORAGE_RETENTION_DAYS = 30
const roles = new Set<StorageVolumeRole>(['system', 'home', 'application-data', 'server-data', 'local'])

function readRoles(json: string): StorageVolumeRole[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return ['local']
    const valid = parsed.filter((role): role is StorageVolumeRole => typeof role === 'string' && roles.has(role as StorageVolumeRole))
    return valid.length ? [...new Set(valid)].slice(0, 5) : ['local']
  } catch { return ['local'] }
}

type Query = { from?: string; to?: string; volumeId?: string; limit: number }

export class MachineStorageHistoryService {
  constructor(private readonly db: AppDatabase, private readonly now: () => number = Date.now) {}

  get(query: Query, currentVolumes?: StorageVolumeReading[]): MachineStorage {
    const to = query.to ?? new Date(this.now()).toISOString()
    const from = query.from ?? new Date(Date.parse(to) - 24 * 60 * 60 * 1000).toISOString()
    const condition = and(
      eq(machineStorageSamples.machineId, 'local'),
      gte(machineStorageSamples.collectedAt, from),
      lte(machineStorageSamples.collectedAt, to),
      ...(query.volumeId ? [eq(machineStorageSamples.volumeId, query.volumeId)] : []),
    )
    const points = this.db.select().from(machineStorageSamples).where(condition)
      .orderBy(asc(machineStorageSamples.collectedAt), asc(machineStorageSamples.volumeId))
      .limit(query.limit).all()
    let volumes: MachineStorage['volumes']
    if (currentVolumes) {
      volumes = currentVolumes.map((volume) => ({
        id: volume.id,
        name: volume.name,
        roles: volume.roles,
        usedBytes: volume.usedBytes,
        availableBytes: volume.availableBytes,
        totalBytes: volume.totalBytes,
        usedPercent: volume.usedPercent,
        collectedAt: volume.collectedAt,
      }))
    } else {
      const recent = this.db.select().from(machineStorageSamples)
        .where(eq(machineStorageSamples.machineId, 'local'))
        .orderBy(desc(machineStorageSamples.collectedAt), desc(machineStorageSamples.id))
        .limit(500).all()
      const latestByVolume = new Map<string, typeof recent[number]>()
      for (const row of recent) if (!latestByVolume.has(row.volumeId)) latestByVolume.set(row.volumeId, row)
      volumes = [...latestByVolume.values()].map((row) => ({
        id: row.volumeId,
        name: row.name,
        roles: readRoles(row.roles),
        usedBytes: row.usedBytes,
        availableBytes: row.availableBytes,
        totalBytes: row.totalBytes,
        usedPercent: row.usedPercent,
        collectedAt: row.collectedAt,
      }))
    }
    const grouped = new Map<string, MachineStorage['history'][number]>()
    for (const row of points) {
      let series = grouped.get(row.volumeId)
      if (!series) {
        series = { volumeId: row.volumeId, name: row.name, roles: readRoles(row.roles), points: [] }
        grouped.set(row.volumeId, series)
      }
      series.points.push({
        collectedAt: row.collectedAt,
        usedBytes: row.usedBytes,
        availableBytes: row.availableBytes,
        totalBytes: row.totalBytes,
        usedPercent: row.usedPercent,
      })
    }
    return { volumes, history: [...grouped.values()], historyRetentionDays: STORAGE_RETENTION_DAYS }
  }
}
