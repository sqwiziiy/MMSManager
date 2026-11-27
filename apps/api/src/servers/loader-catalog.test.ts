import { describe, expect, it } from 'vitest'
import {
  compareLoaderVersions, forgeGameVersions, forgeLoaderVersions, isExperimentalLoaderVersion,
  neoForgeLoaderVersions, neoForgeMinecraftVersion, parseForgePromotions, parseMavenMetadata,
} from './loader-catalog.js'

describe('official Forge and NeoForge catalogs', () => {
  it('parses bounded Maven coordinates without accepting XML declarations', () => {
    expect(parseMavenMetadata('<metadata><versioning><versions><version>1.20.1-47.1.106</version><version>1.20.1-47.2.0</version></versions></versioning></metadata>'))
      .toEqual(['1.20.1-47.1.106', '1.20.1-47.2.0'])
    expect(parseMavenMetadata('<metadata><versioning><versions></versions></versioning></metadata>')).toEqual([])
    expect(() => parseMavenMetadata('<!DOCTYPE metadata [<!ENTITY x SYSTEM "file:///etc/passwd">]><metadata/>')).toThrow(/declarations/)
    expect(() => parseMavenMetadata('x'.repeat(2 * 1024 * 1024 + 1))).toThrow(/oversized/)
  })

  it('keeps Forge recommended and latest builds separate and verifies Maven publication', () => {
    const promotions = parseForgePromotions({ promos: {
      '1.20.1-recommended': '47.2.0', '1.20.1-latest': '47.3.0',
      '1.21.1-recommended': '52.0.0', 'invalid-version-latest': 'oops',
    } })
    expect(forgeGameVersions(['1.20.1', '1.21.1', '1.21.4'], promotions)).toEqual(['1.20.1', '1.21.1'])
    expect(forgeLoaderVersions('1.20.1', promotions, ['1.20.1-47.2.0', '1.20.1-47.3.0'])).toEqual({ stable: ['47.2.0'], experimental: ['47.3.0'] })
    expect(forgeLoaderVersions('1.20.1', promotions, ['1.20.1-47.3.0'])).toEqual({ stable: [], experimental: ['47.3.0'] })
  })

  it('maps versioned NeoForge coordinates to official releases and separates experimental builds', () => {
    const releases = ['1.20.1', '1.20.4', '1.21', '1.21.1', '1.21.2']
    expect(neoForgeMinecraftVersion('21.1.184', releases)).toBe('1.21.1')
    expect(neoForgeMinecraftVersion('20.4.237', releases)).toBe('1.20.4')
    expect(neoForgeMinecraftVersion('1.20.1-47.1.106', releases)).toBe('1.20.1')
    expect(neoForgeMinecraftVersion('21.1.184', ['1.21.2'])).toBeNull()
    const selected = neoForgeLoaderVersions('1.21.1', ['21.1.184', '21.1.185-beta.1'], ['1.20.1-47.1.106'], releases)
    expect(selected.stable).toEqual(['21.1.184'])
    expect(selected.experimental).toEqual(['21.1.185-beta.1'])
    expect(isExperimentalLoaderVersion('21.1.185-beta.1')).toBe(true)
  })

  it('compares numeric build segments numerically', () => {
    expect(compareLoaderVersions('47.1.10', '47.1.9')).toBeGreaterThan(0)
    expect(compareLoaderVersions('21.1.200', '21.1.99')).toBeGreaterThan(0)
  })
})
