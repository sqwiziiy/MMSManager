import { createHash } from 'node:crypto'
import { readFile, realpath, statfs } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export type StorageVolumeRole = 'system' | 'home' | 'application-data' | 'server-data' | 'local'
export type StorageVolumeReading = {
  id: string
  name: string
  roles: StorageVolumeRole[]
  usedBytes: number | null
  availableBytes: number | null
  totalBytes: number | null
  usedPercent: number | null
  collectedAt: string
}

export type LinuxMount = {
  deviceId: string
  root: string
  mountPoint: string
  fileSystem: string
  source: string
}

export type StoragePathConfig = {
  home?: string
  applicationData?: string
  serverData?: string
}

const excludedFileSystems = new Set([
  'autofs', 'binfmt_misc', 'bpf', 'cgroup', 'cgroup2', 'configfs', 'debugfs', 'devpts',
  'devtmpfs', 'efivarfs', 'fusectl', 'hugetlbfs', 'mqueue', 'proc', 'pstore', 'rpc_pipefs', 'tmpfs',
  'securityfs', 'sysfs', 'tracefs',
])
const remoteFileSystems = /^(?:9p|afs|ceph|cifs|davfs|fuse\.sshfs|glusterfs|ncp|nfs|nfs4|smb3|sshfs|virtiofs)$/i
const maxSafeBigInt = BigInt(Number.MAX_SAFE_INTEGER)

function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

export function parseLinuxMountInfo(content: string): LinuxMount[] {
  const mounts: LinuxMount[] = []
  for (const line of content.split('\n')) {
    if (!line) continue
    const separator = line.indexOf(' - ')
    if (separator < 0) continue
    const before = line.slice(0, separator).split(' ')
    const after = line.slice(separator + 3).split(' ')
    const deviceId = before[2]
    const root = before[3]
    const mountPoint = before[4]
    const fileSystem = after[0]
    const source = after[1]
    if (!deviceId || !root || !mountPoint || !fileSystem || !source || !/^\d+:\d+$/.test(deviceId)) continue
    mounts.push({
      deviceId,
      root: decodeMountField(root),
      mountPoint: decodeMountField(mountPoint),
      fileSystem,
      source: decodeMountField(source),
    })
  }
  return mounts
}

export function longestMountForPath(path: string, mounts: LinuxMount[]): LinuxMount | null {
  const target = resolve(path)
  return [...mounts]
    .filter((mount) => target === mount.mountPoint || target.startsWith(mount.mountPoint.endsWith(sep) ? mount.mountPoint : `${mount.mountPoint}${sep}`))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0] ?? null
}

function isLocalDiskMount(mount: LinuxMount): boolean {
  const type = mount.fileSystem.toLowerCase()
  return !excludedFileSystems.has(type) && !type.startsWith('cgroup') && !type.startsWith('fuse.') && !remoteFileSystems.test(type)
}

function safeBytes(value: bigint): number | null {
  return value >= 0n && value <= maxSafeBigInt ? Number(value) : null
}

function uniqueRoles(roles: StorageVolumeRole[]): StorageVolumeRole[] {
  const order: StorageVolumeRole[] = ['server-data', 'application-data', 'home', 'system', 'local']
  return order.filter((role) => roles.includes(role))
}

function volumeName(roles: StorageVolumeRole[]): string {
  if (roles.includes('server-data')) return 'Server data'
  if (roles.includes('application-data')) return 'Application data'
  if (roles.includes('home')) return 'Home volume'
  if (roles.includes('system')) return 'System volume'
  return 'Local volume'
}

export async function collectStorageVolumes(options: {
  mountInfoPath?: string
  paths?: StoragePathConfig
  now?: () => number
  readMountInfo?: (path: string) => Promise<string>
  resolvePath?: (path: string) => Promise<string>
  readStats?: (path: string) => Promise<{ blocks: bigint; bfree: bigint; bavail: bigint; bsize: bigint }>
} = {}): Promise<StorageVolumeReading[]> {
  const mountInfoPath = options.mountInfoPath ?? '/proc/self/mountinfo'
  const readMountInfo = options.readMountInfo ?? ((path: string) => readFile(path, 'utf8'))
  const resolvePath = options.resolvePath ?? (async (path: string) => realpath(path).catch(() => resolve(path)))
  const readStats = options.readStats ?? ((path: string) => statfs(path, { bigint: true }))
  const mountInfo = await readMountInfo(mountInfoPath).catch(() => '')
  const allMounts = parseLinuxMountInfo(mountInfo)
  const mounts = allMounts.filter(isLocalDiskMount)
  const rolesByDevice = new Map<string, StorageVolumeRole[]>()
  const rootMount = longestMountForPath('/', mounts)
  if (rootMount) rolesByDevice.set(rootMount.deviceId, ['system'])

  const pathRoles: Array<[string | undefined, StorageVolumeRole]> = [
    [options.paths?.home, 'home'],
    [options.paths?.applicationData, 'application-data'],
    [options.paths?.serverData, 'server-data'],
  ]
  for (const [configuredPath, role] of pathRoles) {
    if (!configuredPath) continue
    const resolvedPath = await resolvePath(configuredPath)
    const mount = longestMountForPath(resolvedPath, mounts)
    if (!mount) continue
    const roles = rolesByDevice.get(mount.deviceId) ?? []
    roles.push(role)
    rolesByDevice.set(mount.deviceId, roles)
  }

  const representativeByDevice = new Map<string, LinuxMount>()
  for (const mount of mounts) {
    if (!representativeByDevice.has(mount.deviceId)) representativeByDevice.set(mount.deviceId, mount)
  }
  const collectedAt = new Date((options.now ?? Date.now)()).toISOString()
  const readings = await Promise.all([...representativeByDevice.entries()].map(async ([deviceId, mount]) => {
    const roles = uniqueRoles(rolesByDevice.get(deviceId) ?? ['local'])
    const id = createHash('sha256').update(`${mount.fileSystem}\0${deviceId}`).digest('hex')
    try {
      const stats = await readStats(mount.mountPoint)
      const blockSize = stats.bsize
      const totalRaw = stats.blocks * blockSize
      const usedRaw = (stats.blocks - stats.bfree) * blockSize
      const availableRaw = stats.bavail * blockSize
      const totalBytes = safeBytes(totalRaw)
      const usedBytes = safeBytes(usedRaw)
      const availableBytes = safeBytes(availableRaw)
      return {
        id,
        name: volumeName(roles),
        roles,
        usedBytes,
        availableBytes,
        totalBytes,
        usedPercent: totalBytes && usedBytes !== null ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : null,
        collectedAt,
      } satisfies StorageVolumeReading
    } catch {
      return roles.includes('local')
        ? null
        : { id, name: volumeName(roles), roles, usedBytes: null, availableBytes: null, totalBytes: null, usedPercent: null, collectedAt } satisfies StorageVolumeReading
    }
  }))
  const displayPriority: StorageVolumeRole[] = ['server-data', 'application-data', 'system', 'home', 'local']
  return readings.filter((reading): reading is StorageVolumeReading => reading !== null)
    .sort((left, right) => {
      const leftRank = displayPriority.findIndex((role) => left.roles.includes(role))
      const rightRank = displayPriority.findIndex((role) => right.roles.includes(role))
      return leftRank - rightRank || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    })
    .slice(0, 100)
}

export function rolePathDefaults(home: string | undefined, applicationData: string, serverData: string): StoragePathConfig {
  return { home: home || undefined, applicationData: resolve(applicationData), serverData: resolve(serverData) }
}
