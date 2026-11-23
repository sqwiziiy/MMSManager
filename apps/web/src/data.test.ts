import { describe, expect, it } from 'vitest'
import { formatMemory, getServerSummary, servers } from './data'

describe('mock server fixtures', () => {
  it('summarizes only the supplied sample records', () => {
    expect(getServerSummary()).toEqual({ total: 3, online: 2, players: 24, allocatedMemory: 20 })
    expect(getServerSummary([])).toEqual({ total: 0, online: 0, players: 0, allocatedMemory: 0 })
  })

  it('formats memory consistently for metric cards', () => {
    expect(formatMemory(5.2)).toBe('5.2 GB')
    expect(formatMemory(8)).toBe('8 GB')
  })

  it('keeps every fixture fictional and non-operational', () => {
    expect(servers.every((server) => server.address.endsWith('.example') || server.address === 'not published')).toBe(true)
  })
})
