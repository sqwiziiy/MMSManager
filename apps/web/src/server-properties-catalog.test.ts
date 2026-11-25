import { describe, expect, it } from 'vitest'
import { compareMinecraftVersions, serverPropertiesCatalog, serverPropertyAvailable } from '@mmsmanager/shared'

describe('versioned server.properties catalog', () => {
  it('compares supported version fixtures and keeps unknown releases unavailable', () => {
    expect(compareMinecraftVersions('1.20.1', '1.21.4')).toBeLessThan(0)
    expect(compareMinecraftVersions('1.21.4', '1.21.4')).toBe(0)
    expect(compareMinecraftVersions('unknown', '1.21.4')).toBeNull()
    const allowFlight = serverPropertiesCatalog.find((entry) => entry.key === 'allow-flight')!
    expect(serverPropertyAvailable(allowFlight, 'fabric', '1.20.1')).toBe(true)
    expect(serverPropertyAvailable(allowFlight, 'paper', '1.21.4')).toBe(true)
    expect(serverPropertyAvailable(allowFlight, 'vanilla', '1.19.4')).toBe(false)
    expect(serverPropertyAvailable(allowFlight, 'unknown', '1.21.4')).toBe(false)
  })

  it('limits Paper-specific and version-specific keys to supported combinations', () => {
    const regionCompression = serverPropertiesCatalog.find((entry) => entry.key === 'region-file-compression')!
    expect(serverPropertyAvailable(regionCompression, 'paper', '1.20.1')).toBe(false)
    expect(serverPropertyAvailable(regionCompression, 'paper', '1.20.5')).toBe(true)
    expect(serverPropertyAvailable(regionCompression, 'fabric', '1.20.5')).toBe(true)
    expect(serverPropertyAvailable(regionCompression, 'vanilla', '1.21.4')).toBe(true)
    expect(regionCompression.options).toEqual(['deflate', 'lz4', 'none'])
    expect(regionCompression.softwareOptions?.paper).toContain('gzip')
    expect(serverPropertyAvailable(regionCompression, 'paper', 'unknown')).toBe(false)
  })
})
