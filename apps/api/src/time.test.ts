import { describe, expect, it } from 'vitest'
import { localDayWindow, startOfLocalDate, validateCalendarDate } from './time.js'

describe('local calendar date windows', () => {
  it('uses a 23-hour window across the spring daylight-saving change', () => {
    const window = localDayWindow('2026-03-29', 'Europe/Paris')
    expect(window.from).toBe('2026-03-28T23:00:00.000Z')
    expect(window.to).toBe('2026-03-29T22:00:00.000Z')
    expect(window.durationMs).toBe(23 * 60 * 60 * 1000)
  })

  it('uses a 25-hour window across the autumn daylight-saving change', () => {
    const window = localDayWindow('2026-10-25', 'Europe/Paris')
    expect(window.from).toBe('2026-10-24T22:00:00.000Z')
    expect(window.to).toBe('2026-10-25T23:00:00.000Z')
    expect(window.durationMs).toBe(25 * 60 * 60 * 1000)
  })

  it('uses a 24-hour UTC day and rejects impossible dates', () => {
    expect(localDayWindow('2026-11-23', 'UTC').durationMs).toBe(24 * 60 * 60 * 1000)
    expect(() => validateCalendarDate('2026-02-30')).toThrow(RangeError)
  })

  it('returns the first instant belonging to the selected local date', () => {
    const start = startOfLocalDate('2026-10-25', 'Europe/Paris')
    expect(new Date(start).toISOString()).toBe('2026-10-24T22:00:00.000Z')
  })
})
