import { describe, expect, it } from 'vitest'
import { collectStorageVolumes, longestMountForPath, parseLinuxMountInfo } from './storage-volumes.js'

const mountInfo = [
  '1 0 8:1 / / rw,relatime - ext4 /dev/root rw',
  '2 1 8:2 / /home rw,relatime - ext4 /dev/home rw',
  '3 1 8:2 /servers /mnt/servers rw,relatime - ext4 /dev/home rw',
  '4 1 0:44 / /run rw,nosuid - tmpfs tmpfs rw',
  '5 1 0:55 / /mnt/remote rw - nfs4 storage.internal:/share rw',
].join('\n')

describe('local storage volume discovery', () => {
  it('decodes escaped mount fields and chooses the longest boundary-safe mount', () => {
    const mounts = parseLinuxMountInfo('1 0 8:1 / /srv/minecraft\\040data rw - ext4 /dev/root rw\n')
    expect(mounts[0]?.mountPoint).toBe('/srv/minecraft data')
    expect(longestMountForPath('/home/player/world', parseLinuxMountInfo(mountInfo))?.mountPoint).toBe('/home')
    expect(longestMountForPath('/home2/player', parseLinuxMountInfo(mountInfo))?.mountPoint).toBe('/')
  })

  it('assigns configured roles to backing devices, deduplicates bind aliases, and excludes virtual and remote filesystems', async () => {
    const statPaths: string[] = []
    const readings = await collectStorageVolumes({
      mountInfoPath: '/fixture/mountinfo',
      paths: { home: '/home/player', applicationData: '/home/player/.local/state/mmsmanager', serverData: '/mnt/servers/world-one' },
      now: () => Date.parse('2026-11-24T12:00:00.000Z'),
      readMountInfo: async () => mountInfo,
      resolvePath: async (path) => path,
      readStats: async (path) => {
        statPaths.push(path)
        return path === '/' ? { blocks: 100n, bfree: 20n, bavail: 15n, bsize: 4096n } : { blocks: 1000n, bfree: 400n, bavail: 350n, bsize: 4096n }
      },
    })

    expect(statPaths.sort()).toEqual(['/', '/home'])
    expect(readings).toHaveLength(2)
    expect(readings[0]?.roles).toContain('server-data')
    const system = readings.find((volume) => volume.roles.includes('system'))
    const server = readings.find((volume) => volume.roles.includes('server-data'))
    expect(system).toMatchObject({ name: 'System volume', roles: ['system'], totalBytes: 409600, usedBytes: 327680, availableBytes: 61440, usedPercent: 80 })
    expect(server).toMatchObject({ name: 'Server data', roles: ['server-data', 'application-data', 'home'], totalBytes: 4096000, usedBytes: 2457600, availableBytes: 1433600, usedPercent: 60 })
    expect(JSON.stringify(readings)).not.toContain('/dev/')
    expect(JSON.stringify(readings)).not.toContain('/home/player')
    expect(JSON.stringify(readings)).not.toContain('storage.internal')
  })

  it('returns unavailable measurements for a disappearing mount without inventing capacity', async () => {
    const readings = await collectStorageVolumes({
      mountInfoPath: '/fixture/mountinfo',
      paths: { serverData: '/home/player/servers' },
      readMountInfo: async () => mountInfo,
      resolvePath: async (path) => path,
      readStats: async () => { throw new Error('mount disappeared') },
    })
    const server = readings.find((volume) => volume.roles.includes('server-data'))
    expect(server).toMatchObject({ usedBytes: null, availableBytes: null, totalBytes: null, usedPercent: null })
  })
})
