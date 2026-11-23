import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { API_HOST, WEB_ORIGIN } from './config.js'
import { openDatabase } from './db/client.js'
import { machineSamples } from './db/schema.js'
import { AuthService } from './auth/service.js'
import { AvatarStore } from './auth/avatar-store.js'
import { MachineCollector } from './machine/collector.js'
import type { SnapshotReader } from './machine/reader.js'
import { createApiApp } from './routes.js'

const ADMIN_PASSWORD = 'synthetic admin passphrase 7fX!4pQz'
const requestHeaders = { origin: WEB_ORIGIN, host: '127.0.0.1:4174' }

describe('authenticated local API', () => {
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let collector: MachineCollector
  let app: FastifyInstance
  let auth: AuthService
  let dataDirectory: string

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'mmsmanager-routes-'))
    opened = await openDatabase({ path: join(dataDirectory, 'mmsmanager.sqlite') })
    const reader: SnapshotReader = { read: async () => { throw new Error('Not sampled') } }
    collector = new MachineCollector(opened.db, reader, 'Europe/Paris')
    auth = new AuthService(opened.native, dataDirectory, () => Date.parse('2026-11-23T12:00:00.000Z'))
    await auth.prepare()
    const avatars = new AvatarStore(dataDirectory)
    await avatars.prepare()
    app = await createApiApp({
      db: opened.db,
      collector,
      timeZone: 'Europe/Paris',
      auth,
      avatars,
      webOrigin: WEB_ORIGIN,
      apiPort: 4174,
      now: () => Date.parse('2026-11-23T12:00:00.000Z'),
    })
  })

  afterEach(async () => {
    await collector.stop()
    await app.close()
    opened.native.close()
    await rm(dataDirectory, { recursive: true, force: true })
  })

  async function bootstrapAdmin() {
    const token = (await readFile(auth.bootstrapPath, 'utf8')).trim()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { ...requestHeaders, 'content-type': 'application/json' },
      payload: { token, username: 'owner', displayName: 'Local Owner', password: ADMIN_PASSWORD, confirmPassword: ADMIN_PASSWORD },
    })
    expect(response.statusCode).toBe(201)
    const cookies = response.headers['set-cookie']
    const cookieList = (Array.isArray(cookies) ? cookies : [cookies]).filter((item): item is string => typeof item === 'string')
    const cookieHeader = cookieList.map((item) => item.split(';')[0]).join('; ')
    const csrfToken = cookieList.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? ''
    return { cookieHeader, csrfToken }
  }

  it('publishes minimal health and denies telemetry until a real account is initialized', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ service: 'mmsmanager-local-api', status: 'ok', setupRequired: true })
    const current = await app.inject({ method: 'GET', url: '/api/v1/machine/current' })
    const history = await app.inject({ method: 'GET', url: '/api/v1/machine/history?from=2026-11-23T00%3A00%3A00Z&to=2026-11-23T00%3A01%3A00Z' })
    expect([current.statusCode, history.statusCode]).toEqual([401, 401])
  })

  it('consumes the out-of-band bootstrap credential and protects telemetry/history with a session', async () => {
    const session = await bootstrapAdmin()
    expect(auth.getSetupRequired()).toBe(false)
    await expect(readFile(auth.bootstrapPath, 'utf8')).rejects.toThrow()

    const current = await app.inject({ method: 'GET', url: '/api/v1/machine/current', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    expect(current.statusCode).toBe(200)
    expect(current.json().status).toBe('collecting')
    const day = await app.inject({ method: 'GET', url: '/api/v1/machine/day/2026-11-23', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    expect(day.statusCode).toBe(200)
    expect(day.json().status).toBe('no-data')

    const health = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(health.json()).toEqual({ service: 'mmsmanager-local-api', status: 'ok', setupRequired: false })
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ username: 'owner', displayName: 'Local Owner', role: 'administrator' })
  })

  it('restores the local administrator session after an API and SQLite restart', async () => {
    const session = await bootstrapAdmin()
    await app.close()
    await collector.stop()
    opened.native.close()

    opened = await openDatabase({ path: join(dataDirectory, 'mmsmanager.sqlite') })
    auth = new AuthService(opened.native, dataDirectory, () => Date.parse('2026-11-23T12:00:00.000Z'))
    await auth.prepare()
    const avatars = new AvatarStore(dataDirectory)
    await avatars.prepare()
    collector = new MachineCollector(opened.db, { read: async () => { throw new Error('Not sampled') } }, 'Europe/Paris')
    app = await createApiApp({
      db: opened.db,
      collector,
      timeZone: 'Europe/Paris',
      auth,
      avatars,
      webOrigin: WEB_ORIGIN,
      apiPort: 4174,
      now: () => Date.parse('2026-11-23T12:00:00.000Z'),
    })

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ username: 'owner', displayName: 'Local Owner', role: 'administrator' })
    expect(auth.authenticate(session.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')).not.toBeNull()
  })

  it('rejects setup token reuse, foreign origins, missing CSRF and invalid payloads', async () => {
    const token = (await readFile(auth.bootstrapPath, 'utf8')).trim()
    const invalidOrigin = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      headers: { origin: 'https://outside.example', host: '127.0.0.1:4174', 'content-type': 'application/json' },
      payload: { token, username: 'owner', displayName: 'Local Owner', password: ADMIN_PASSWORD, confirmPassword: ADMIN_PASSWORD },
    })
    expect(invalidOrigin.statusCode).toBe(403)

    const admin = await bootstrapAdmin()
    const noCsrf = await app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: {},
    })
    expect(noCsrf.statusCode).toBe(403)

    const reused = await app.inject({
      method: 'POST', url: '/api/v1/auth/setup',
      headers: { ...requestHeaders, 'content-type': 'application/json' },
      payload: { token, username: 'second', displayName: 'Second', password: ADMIN_PASSWORD, confirmPassword: ADMIN_PASSWORD },
    })
    expect(reused.statusCode).toBe(401)
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: { username: 'x', password: 'x', isAdmin: true } })
    expect(malformed.statusCode).toBe(400)
  })

  it('enforces strict CORS and supports only authenticated reads from the web origin', async () => {
    const allowed = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: WEB_ORIGIN, host: '127.0.0.1:4174' } })
    const foreign = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: 'https://outside.example', host: '127.0.0.1:4174' } })
    const wrongHost = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'outside.example' } })
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN)
    expect(allowed.headers['access-control-allow-credentials']).toBe('true')
    expect(foreign.statusCode).toBe(403)
    expect(wrongHost.statusCode).toBe(400)
  })

  it('keeps machine reads from writing telemetry and binds only to IPv4 loopback', async () => {
    const session = await bootstrapAdmin()
    const before = opened.db.select().from(machineSamples).where(eq(machineSamples.machineId, 'local')).all().length
    const first = await app.inject({ method: 'GET', url: '/api/v1/machine/current', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    const second = await app.inject({ method: 'GET', url: '/api/v1/machine/current', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    const after = opened.db.select().from(machineSamples).where(eq(machineSamples.machineId, 'local')).all().length
    expect(first.json()).toEqual(second.json())
    expect(after).toBe(before)

    await app.listen({ host: API_HOST, port: 0 })
    expect(app.addresses().map((address) => typeof address === 'string' ? address : address.address)).toEqual(['127.0.0.1'])
  })
})
