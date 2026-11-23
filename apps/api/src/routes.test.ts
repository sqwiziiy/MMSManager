import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { API_HOST, WEB_ORIGIN } from './config.js'
import { openDatabase } from './db/client.js'
import { machineSamples, localServers } from './db/schema.js'
import { AuthService } from './auth/service.js'
import { AvatarStore } from './auth/avatar-store.js'
import { MachineCollector } from './machine/collector.js'
import type { SnapshotReader } from './machine/reader.js'
import { createApiApp } from './routes.js'
import { ServerRegistry } from './servers/registry.js'
import { JavaRuntimeRegistry } from './servers/java.js'

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
    const servers = new ServerRegistry(opened.db, dataDirectory, { MMSMANAGER_SERVER_ROOT: join(dataDirectory, 'servers') })
    await servers.prepare()
    const javaRuntimes = new JavaRuntimeRegistry(async () => [{
      path: '/test/java-21/bin/java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered',
    }])
    app = await createApiApp({
      db: opened.db,
      collector,
      timeZone: 'Europe/Paris',
      auth,
      avatars,
      servers,
      javaRuntimes,
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

  it('returns a proper rate-limit response after a bounded local request burst', async () => {
    for (let index = 0; index < 600; index += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' })
      expect(response.statusCode).toBe(200)
    }
    const limited = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
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
    const servers = new ServerRegistry(opened.db, dataDirectory, { MMSMANAGER_SERVER_ROOT: join(dataDirectory, 'servers') })
    await servers.prepare()
    const javaRuntimes = new JavaRuntimeRegistry(async () => [{
      path: '/test/java-21/bin/java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered',
    }])
    collector = new MachineCollector(opened.db, { read: async () => { throw new Error('Not sampled') } }, 'Europe/Paris')
    app = await createApiApp({
      db: opened.db,
      collector,
      timeZone: 'Europe/Paris',
      auth,
      avatars,
      servers,
      javaRuntimes,
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

  it('protects the filesystem inventory with admin role and CSRF checks', async () => {
    const admin = await bootstrapAdmin()
    const serverDirectory = join(dataDirectory, 'servers', 'legacy')
    await mkdir(serverDirectory, { recursive: true })
    await writeFile(join(serverDirectory, 'server.properties'), 'server-port=25565\n')
    await writeFile(join(serverDirectory, 'server.jar'), 'test bytes')
    const adminHeaders = {
      ...requestHeaders,
      cookie: admin.cookieHeader,
      'x-mms-csrf': admin.csrfToken,
      'content-type': 'application/json',
    }
    const preview = await app.inject({
      method: 'POST', url: '/api/v1/admin/servers/import/inspect', headers: adminHeaders,
      payload: { path: serverDirectory },
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ software: 'vanilla', port: 25565, alreadyRegistered: false })
    const registered = await app.inject({
      method: 'POST', url: '/api/v1/admin/servers/import', headers: adminHeaders,
      payload: { path: serverDirectory, name: 'Legacy Preview', minMemoryMb: 1024, maxMemoryMb: 4096 },
    })
    expect(registered.statusCode).toBe(201)
    expect(registered.json().server).toMatchObject({ name: 'Legacy Preview', source: 'imported', managed: false })
    const inventory = await app.inject({ method: 'GET', url: '/api/v1/admin/servers', headers: adminHeaders })
    expect(inventory.statusCode).toBe(200)
    expect(inventory.json().servers).toHaveLength(1)
    expect(inventory.json().servers[0].directory).toBe(serverDirectory)
    const memberSafeList = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: adminHeaders })
    expect(memberSafeList.statusCode).toBe(200)
    expect(memberSafeList.json().servers[0].directory).toBeUndefined()
    const javaBeforeScan = await app.inject({ method: 'GET', url: '/api/v1/admin/java', headers: adminHeaders })
    expect(javaBeforeScan.statusCode).toBe(200)
    expect(javaBeforeScan.json().runtimes).toEqual([])
    const javaScan = await app.inject({
      method: 'POST', url: '/api/v1/admin/java/scan', headers: adminHeaders, payload: {},
    })
    expect(javaScan.statusCode).toBe(200)
    expect(javaScan.json().runtimes).toMatchObject([{ major: 21, version: '21.0.4', source: 'discovered' }])

    const missingCsrf = await app.inject({
      method: 'POST', url: '/api/v1/admin/servers/import/inspect',
      headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' },
      payload: { path: serverDirectory },
    })
    expect(missingCsrf.statusCode).toBe(403)

    const principal = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    await auth.createUser(principal, {
      username: 'member',
      displayName: 'Local Member',
      password: 'synthetic member passphrase 3M!k4Pq9',
      role: 'member',
    })
    const memberLogin = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { ...requestHeaders, 'content-type': 'application/json' },
      payload: { username: 'member', password: 'synthetic member passphrase 3M!k4Pq9' },
    })
    expect(memberLogin.statusCode).toBe(200)
    const memberCookies = memberLogin.headers['set-cookie']
    const memberCookieList = (Array.isArray(memberCookies) ? memberCookies : [memberCookies]).filter((item): item is string => typeof item === 'string')
    const memberCookieHeader = memberCookieList.map((item) => item.split(';')[0]).join('; ')
    const memberCsrf = memberCookieList.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? ''
    const denied = await app.inject({
      method: 'POST', url: '/api/v1/admin/servers/import/inspect',
      headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' },
      payload: { path: serverDirectory },
    })
    expect(denied.statusCode).toBe(403)
    const memberList = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { ...requestHeaders, cookie: memberCookieHeader } })
    expect(memberList.statusCode).toBe(200)
    expect(memberList.json().servers[0]).toMatchObject({ name: 'Legacy Preview', managed: false })
    expect(memberList.json().servers[0].directory).toBeUndefined()
    const memberScan = await app.inject({
      method: 'POST', url: '/api/v1/admin/java/scan',
      headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' },
      payload: {},
    })
    expect(memberScan.statusCode).toBe(403)
    const installInput = {
      name: 'Should not install', directoryName: 'should-not-install', software: 'vanilla', version: '1.21.4',
      javaPath: '/tmp/not-probed-java', minMemoryMb: 1024, maxMemoryMb: 2048, port: 25566, eulaAccepted: false,
    }
    const deniedInstall = await app.inject({
      method: 'POST', url: '/api/v1/admin/server-installs',
      headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' },
      payload: installInput,
    })
    expect(deniedInstall.statusCode).toBe(403)
    const deniedInstallHistory = await app.inject({ method: 'GET', url: '/api/v1/admin/server-installs', headers: { ...requestHeaders, cookie: memberCookieHeader } })
    expect(deniedInstallHistory.statusCode).toBe(403)
    const installMissingCsrf = await app.inject({
      method: 'POST', url: '/api/v1/admin/server-installs',
      headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: installInput,
    })
    expect(installMissingCsrf.statusCode).toBe(403)
  })

  it('enforces administrator and CSRF checks for lifecycle controls and managed properties', async () => {
    const admin = await bootstrapAdmin()
    const managedDirectory = join(dataDirectory, 'servers', 'route-managed')
    await mkdir(managedDirectory, { recursive: true })
    const original = '# preserve me\nserver-ip=127.0.0.1\nmotd=Before\ngamemode=survival\ndifficulty=normal\nmax-players=20\nview-distance=10\nsimulation-distance=10\nspawn-protection=16\npvp=true\nwhite-list=false\nallow-nether=true\nunknown-option=preserve\n'
    await writeFile(join(managedDirectory, 'server.properties'), original, { mode: 0o600 })
    const id = randomUUID()
    const now = new Date().toISOString()
    await opened.db.insert(localServers).values({
      id, name: 'Route Managed', directory: managedDirectory, source: 'created', software: 'vanilla', version: '1.21.4',
      jarName: 'server.jar', javaPath: '/test/java-21/bin/java', javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024,
      port: 25568, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!.userId,
      createdAt: now, updatedAt: now,
    }).run()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }
    const properties = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/properties`, headers: adminHeaders })
    expect(properties.statusCode).toBe(200)
    expect(properties.json().properties.settings.motd).toBe('Before')
    expect(properties.json().properties.unknownKeys).toContain('server-ip')
    expect(properties.json().properties.unknownKeys).toContain('unknown-option')

    const missingCsrf = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: { motd: 'Blocked' } })
    expect(missingCsrf.statusCode).toBe(403)
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: adminHeaders, payload: { motd: 'After', maxPlayers: 32 } })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().properties.settings).toMatchObject({ motd: 'After', maxPlayers: 32 })
    expect(updated.json().properties.backups).toHaveLength(1)
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toContain('server-ip=127.0.0.1')

    const unauthenticated = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/start`, headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: {} })
    expect(unauthenticated.statusCode).toBe(401)
    const principal = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    await auth.createUser(principal, { username: 'server-member', displayName: 'Server Member', password: 'synthetic member passphrase 6R!d2Hk8', role: 'member' })
    const memberLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: { username: 'server-member', password: 'synthetic member passphrase 6R!d2Hk8' } })
    const memberCookies = memberLogin.headers['set-cookie']
    const memberCookieList = (Array.isArray(memberCookies) ? memberCookies : [memberCookies]).filter((item): item is string => typeof item === 'string')
    const memberCookieHeader = memberCookieList.map((item) => item.split(';')[0]).join('; ')
    const memberCsrf = memberCookieList.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? ''
    const memberHeaders = { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' }
    expect(memberLogin.statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/start`, headers: memberHeaders, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: memberHeaders, payload: { motd: 'Blocked' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/player-actions`, headers: memberHeaders, payload: { action: 'ban', username: 'Alex_123' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/player-actions`, headers: adminHeaders, payload: { action: 'ban', username: 'Alex_123;stop' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/player-actions`, headers: adminHeaders, payload: { action: 'ban', username: 'Alex_123' } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${id}/console`, headers: memberHeaders })).statusCode).toBe(200)
  })
})
