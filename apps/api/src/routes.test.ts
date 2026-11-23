import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { API_HOST } from './config.js'
import { openDatabase } from './db/client.js'
import { machineSamples } from './db/schema.js'
import { MachineCollector } from './machine/collector.js'
import type { SnapshotReader } from './machine/reader.js'
import { createApiApp } from './routes.js'
import type { FastifyInstance } from 'fastify'

describe('read-only local API', () => {
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let collector: MachineCollector
  let app: FastifyInstance

  beforeEach(async () => {
    opened = await openDatabase({ path: ':memory:' })
    const reader: SnapshotReader = { read: async () => { throw new Error('Not sampled') } }
    collector = new MachineCollector(opened.db, reader, 'Europe/Paris')
    app = await createApiApp({
      db: opened.db,
      collector,
      timeZone: 'Europe/Paris',
      now: () => Date.parse('2026-11-23T12:00:00.000Z'),
    })
  })

  afterEach(async () => {
    await collector.stop()
    await app.close()
    opened.native.close()
  })

  it('reports health, collecting state, and an honest empty day', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json().timeZone).toBe('Europe/Paris')

    const current = await app.inject({ method: 'GET', url: '/api/v1/machine/current' })
    expect(current.statusCode).toBe(200)
    expect(current.json().status).toBe('collecting')
    expect(current.json().sample).toBeNull()

    const day = await app.inject({ method: 'GET', url: '/api/v1/machine/day/2026-11-23' })
    expect(day.statusCode).toBe(200)
    expect(day.json().status).toBe('no-data')
    expect(day.json().summary).toBeNull()
    expect(day.json().points).toEqual([])
  })

  it('validates month, date, range, and bounded history limits', async () => {
    const invalidMonth = await app.inject({ method: 'GET', url: '/api/v1/machine/calendar?year=2026&month=13' })
    const invalidDate = await app.inject({ method: 'GET', url: '/api/v1/machine/day/2026-02-30' })
    const invalidLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/machine/history?from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-02T00%3A00%3A00.000Z&limit=501',
    })
    const invalidRange = await app.inject({
      method: 'GET',
      url: '/api/v1/machine/history?from=2026-11-02T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z',
    })
    expect([invalidMonth.statusCode, invalidDate.statusCode, invalidLimit.statusCode, invalidRange.statusCode]).toEqual([400, 400, 400, 400])
  })

  it('keeps API routes read-only and rejects another website origin', async () => {
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/machine/current' })).toBe(true)
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/machine/current' })).toBe(false)
    expect(app.hasRoute({ method: 'PATCH', url: '/api/v1/machine/current' })).toBe(false)
    expect(app.hasRoute({ method: 'DELETE', url: '/api/v1/machine/current' })).toBe(false)

    const allowed = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: 'http://127.0.0.1:5173' } })
    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/machine/current',
      headers: { origin: 'https://outside.example', 'access-control-request-method': 'GET' },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173')
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('binds its listener to IPv4 loopback only', async () => {
    await app.listen({ host: API_HOST, port: 0 })
    expect(app.addresses().map((address) => typeof address === 'string' ? address : address.address)).toEqual(['127.0.0.1'])
  })

  it('serves repeat reads without writing telemetry records', async () => {
    const before = opened.db.select().from(machineSamples).where(eq(machineSamples.machineId, 'local')).all().length
    const first = await app.inject({ method: 'GET', url: '/api/v1/machine/current' })
    const second = await app.inject({ method: 'GET', url: '/api/v1/machine/current' })
    const after = opened.db.select().from(machineSamples).where(eq(machineSamples.machineId, 'local')).all().length
    expect(first.json()).toEqual(second.json())
    expect(after).toBe(before)
  })
})
