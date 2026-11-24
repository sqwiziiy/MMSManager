import os from 'node:os'
import si from 'systeminformation'
import { TELEMETRY_SOURCE } from '../config.js'
import { collectStorageVolumes } from './storage-volumes.js'
import type { StoragePathConfig, StorageVolumeReading } from './storage-volumes.js'

type NullableNumber = number | null

export type HostSnapshot = {
  id: 'local'
  hostname: string
  platform: string
  distro: string | null
  release: string | null
  architecture: string
  cpuModel: string | null
  coreCount: number | null
  uptimeSeconds: NullableNumber
  source: typeof TELEMETRY_SOURCE
}

export type SampleSnapshot = {
  cpuPercent: NullableNumber
  coreCount: number | null
  loadAverage: { one: number; five: number; fifteen: number } | null
  memory: {
    usedBytes: NullableNumber
    availableBytes: NullableNumber
    totalBytes: NullableNumber
    swapUsedBytes: NullableNumber
    swapTotalBytes: NullableNumber
    usedPercent: NullableNumber
  }
  storage: {
    device: string | null
    mount: string | null
    usedBytes: NullableNumber
    availableBytes: NullableNumber
    totalBytes: NullableNumber
    usedPercent: NullableNumber
  } | null
  network: {
    interface: string | null
    rxBytesPerSecond: NullableNumber
    txBytesPerSecond: NullableNumber
    rxTransferredBytes: NullableNumber
    txTransferredBytes: NullableNumber
  }
  sampleStatus: 'ok' | 'partial' | 'error'
  unavailableFields: string[]
  source: typeof TELEMETRY_SOURCE
}

export type CollectedSnapshot = { host: HostSnapshot; sample: SampleSnapshot; storageVolumes?: StorageVolumeReading[] }

export interface SnapshotReader {
  read(): Promise<CollectedSnapshot>
}

function finiteNonnegative(value: unknown): NullableNumber {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function percent(value: unknown): NullableNumber {
  const number = finiteNonnegative(value)
  return number === null ? null : Math.min(100, number)
}

function usedPercent(used: NullableNumber, total: NullableNumber): NullableNumber {
  if (used === null || total === null || total <= 0) return null
  return Math.min(100, Math.max(0, (used / total) * 100))
}

export class SystemInformationReader implements SnapshotReader {
  private diskRefreshMs: number
  private hostCache: { osInfo: Awaited<ReturnType<typeof si.osInfo>> | null; cpu: Awaited<ReturnType<typeof si.cpu>> | null; coreCount: number | null } | null = null
  private hostCacheAt = 0
  private hostCacheRequest: Promise<void> | null = null
  private diskCache: Awaited<ReturnType<typeof si.fsSize>>[number] | null = null
  private diskCacheAt = 0
  private diskCacheRequest: Promise<void> | null = null
  private storagePaths: StoragePathConfig = {}
  private storageVolumesCache: StorageVolumeReading[] = []

  constructor(diskRefreshMs = 30_000) {
    this.diskRefreshMs = diskRefreshMs
  }

  configureDiskRefresh(diskRefreshMs: number): void {
    this.diskRefreshMs = diskRefreshMs
  }

  configureStoragePaths(paths: StoragePathConfig): void {
    this.storagePaths = paths
    this.diskCacheAt = 0
  }

  async read(): Promise<CollectedSnapshot> {
    const [loadResult, memoryResult, interfaceResult] = await Promise.allSettled([
      si.currentLoad(),
      si.mem(),
      si.networkInterfaceDefault(),
    ])
    await Promise.all([this.refreshHostCache(), this.refreshDiskCache()])
    const hostCache = this.hostCache
    const rootFilesystem = this.diskCache?.mount === '/' ? this.diskCache : null

    const networkInterface = interfaceResult.status === 'fulfilled' && interfaceResult.value.length > 0
      ? interfaceResult.value
      : null
    const networkStatsResult = networkInterface
      ? await Promise.allSettled([si.networkStats(networkInterface)])
      : []
    const networkStats = networkStatsResult[0]?.status === 'fulfilled'
      ? networkStatsResult[0].value.find((entry) => entry.iface === networkInterface)
      : undefined

    const load = loadResult.status === 'fulfilled' ? percent(loadResult.value.currentLoad) : null
    const memoryData = memoryResult.status === 'fulfilled' ? memoryResult.value : null
    const memoryTotal = finiteNonnegative(memoryData?.total)
    const memoryAvailableRaw = finiteNonnegative(memoryData?.available)
    const memoryAvailable = memoryTotal === null || memoryAvailableRaw === null
      ? null
      : Math.min(memoryTotal, memoryAvailableRaw)
    const memoryUsed = memoryTotal === null || memoryAvailable === null
      ? null
      : Math.max(0, memoryTotal - memoryAvailable)
    const swapTotal = finiteNonnegative(memoryData?.swaptotal)
    const swapUsedRaw = finiteNonnegative(memoryData?.swapused)
    const swapUsed = swapTotal === null || swapUsedRaw === null ? null : Math.min(swapTotal, swapUsedRaw)

    const storageTotal = finiteNonnegative(rootFilesystem?.size)
    const storageUsed = finiteNonnegative(rootFilesystem?.used)
    const storageAvailable = finiteNonnegative(rootFilesystem?.available)
    const disk = rootFilesystem && storageTotal !== null && storageUsed !== null && storageAvailable !== null
      ? {
          device: rootFilesystem.fs || null,
          mount: rootFilesystem.mount,
          usedBytes: storageUsed,
          availableBytes: storageAvailable,
          totalBytes: storageTotal,
          usedPercent: percent(rootFilesystem.use),
        }
      : null

    const rxRate = finiteNonnegative(networkStats?.rx_sec)
    const txRate = finiteNonnegative(networkStats?.tx_sec)
    const networkIntervalMs = finiteNonnegative(networkStats?.ms)
    const network = {
      interface: networkInterface || null,
      rxBytesPerSecond: rxRate,
      txBytesPerSecond: txRate,
      rxTransferredBytes: rxRate !== null && networkIntervalMs !== null && networkIntervalMs > 0
        ? (rxRate * networkIntervalMs) / 1000
        : null,
      txTransferredBytes: txRate !== null && networkIntervalMs !== null && networkIntervalMs > 0
        ? (txRate * networkIntervalMs) / 1000
        : null,
    }

    const cpuInfo = hostCache?.cpu ?? null
    const osInfo = hostCache?.osInfo ?? null
    const cores = (hostCache?.coreCount ?? os.cpus().length) || null
    const loadAverageValues = os.loadavg()
    const loadAverage = loadAverageValues.length === 3 && loadAverageValues.every(Number.isFinite)
      ? { one: loadAverageValues[0] ?? 0, five: loadAverageValues[1] ?? 0, fifteen: loadAverageValues[2] ?? 0 }
      : null

    const unavailableFields: string[] = []
    if (load === null) unavailableFields.push('cpu')
    if (memoryUsed === null || memoryTotal === null) unavailableFields.push('memory')
    if (!disk) unavailableFields.push('storage')
    if (!networkInterface || rxRate === null || txRate === null) unavailableFields.push('network')
    if (!osInfo) unavailableFields.push('host')

    const sample: SampleSnapshot = {
      cpuPercent: load,
      coreCount: cores,
      loadAverage,
      memory: {
        usedBytes: memoryUsed,
        availableBytes: memoryAvailable,
        totalBytes: memoryTotal,
        swapUsedBytes: swapUsed,
        swapTotalBytes: swapTotal,
        usedPercent: usedPercent(memoryUsed, memoryTotal),
      },
      storage: disk,
      network,
      sampleStatus: unavailableFields.length === 0 ? 'ok' : unavailableFields.length >= 4 ? 'error' : 'partial',
      unavailableFields,
      source: TELEMETRY_SOURCE,
    }

    const host: HostSnapshot = {
      id: 'local',
      hostname: os.hostname(),
      platform: osInfo?.platform || os.platform(),
      distro: osInfo?.distro || null,
      release: osInfo?.release || os.release() || null,
      architecture: os.arch(),
      cpuModel: cpuInfo?.brand || null,
      coreCount: cores,
      uptimeSeconds: finiteNonnegative(os.uptime()),
      source: TELEMETRY_SOURCE,
    }

    return { host, sample, storageVolumes: this.storageVolumesCache }
  }

  private async refreshHostCache(): Promise<void> {
    if (this.hostCacheAt > 0 && Date.now() - this.hostCacheAt < 5 * 60_000) return
    if (this.hostCacheRequest) return this.hostCacheRequest
    this.hostCacheRequest = (async () => {
      const [osResult, cpuResult] = await Promise.allSettled([si.osInfo(), si.cpu()])
      const previous = this.hostCache
      const coreCount = os.cpus().length || previous?.coreCount || null
      this.hostCache = {
        osInfo: osResult.status === 'fulfilled' ? osResult.value : previous?.osInfo ?? null,
        cpu: cpuResult.status === 'fulfilled' ? cpuResult.value : previous?.cpu ?? null,
        coreCount,
      }
      this.hostCacheAt = Date.now()
    })().finally(() => { this.hostCacheRequest = null })
    return this.hostCacheRequest
  }

  private async refreshDiskCache(): Promise<void> {
    if (this.diskCacheAt > 0 && Date.now() - this.diskCacheAt < this.diskRefreshMs) return
    if (this.diskCacheRequest) return this.diskCacheRequest
    this.diskCacheRequest = (async () => {
      const [fsSizeResult, volumeResult] = await Promise.allSettled([
        si.fsSize(),
        collectStorageVolumes({ paths: this.storagePaths }),
      ])
      const filesystems = fsSizeResult.status === 'fulfilled' ? fsSizeResult.value : null
      if (volumeResult.status === 'fulfilled') this.storageVolumesCache = volumeResult.value
      const root = filesystems?.find((filesystem) => filesystem.mount === '/') ?? null
      if (root) this.diskCache = root
      else if (filesystems?.length === 0) this.diskCache = null
      this.diskCacheAt = Date.now()
    })().finally(() => { this.diskCacheRequest = null })
    return this.diskCacheRequest
  }
}
