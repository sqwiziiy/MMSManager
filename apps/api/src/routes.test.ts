import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import process from 'node:process'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { API_HOST, WEB_ORIGIN } from './config.js'
import { AppConfigStore } from './app-config.js'
import { openDatabase } from './db/client.js'
import { auditEvents, localServerEvents, localServerRemovalOperations, localServerStructuredEvents, machineSamples, localServerRuntime, localServers, serverAccessGrants } from './db/schema.js'
import { recordServerResourceSample, recordStructuredServerEvent } from './servers/history.js'
import { AuthService } from './auth/service.js'
import { AvatarStore } from './auth/avatar-store.js'
import { MachineCollector } from './machine/collector.js'
import type { SnapshotReader } from './machine/reader.js'
import { createApiApp } from './routes.js'
import { ServerRegistry } from './servers/registry.js'
import { JavaRuntimeRegistry } from './servers/java.js'
import type { JavaRuntime } from './servers/java.js'
import { ServerProcessManager } from './servers/processes.js'

const ADMIN_PASSWORD = 'synthetic admin passphrase 7fX!4pQz'
const requestHeaders = { origin: WEB_ORIGIN, host: '127.0.0.1:4174' }

function multipartFiles(boundary: string, manifest: { files: string[]; directories: string[] }, files: { path: string; bytes: Buffer }[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n`)]
  for (const file of files) chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.path}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file.bytes,
    Buffer.from('\r\n'),
  )
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function storedZip(entries: { path: string; bytes: Buffer; unixMode?: number }[], zip64 = false): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.path, 'utf8')
    const crc = crc32(item.bytes)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(item.bytes.byteLength, 18)
    localHeader.writeUInt32LE(item.bytes.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    local.push(localHeader, name, item.bytes)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(item.unixMode === undefined ? 20 : 0x0314, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(item.bytes.byteLength, 20)
    centralHeader.writeUInt32LE(item.bytes.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt32LE((item.unixMode ?? 0) * 0x10000 >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.byteLength + name.byteLength + item.bytes.byteLength
  }
  const directory = Buffer.concat(central)
  const directoryOffset = offset
  const records = [...local, directory]
  if (zip64) {
    const zip64Offset = directoryOffset + directory.byteLength
    const zip64End = Buffer.alloc(56)
    zip64End.writeUInt32LE(0x06064b50, 0)
    zip64End.writeBigUInt64LE(44n, 4)
    zip64End.writeUInt16LE(45, 12)
    zip64End.writeUInt16LE(45, 14)
    zip64End.writeBigUInt64LE(BigInt(entries.length), 24)
    zip64End.writeBigUInt64LE(BigInt(entries.length), 32)
    zip64End.writeBigUInt64LE(BigInt(directory.byteLength), 40)
    zip64End.writeBigUInt64LE(BigInt(directoryOffset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(zip64Offset), 8)
    locator.writeUInt32LE(1, 16)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0xffff, 8)
    end.writeUInt16LE(0xffff, 10)
    end.writeUInt32LE(0xffffffff, 12)
    end.writeUInt32LE(0xffffffff, 16)
    records.push(zip64End, locator, end)
  } else {
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(directory.byteLength, 12)
    end.writeUInt32LE(directoryOffset, 16)
    records.push(end)
  }
  return Buffer.concat(records)
}

function multipartArchive(boundary: string, filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}

describe('authenticated local API', () => {
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let collector: MachineCollector
  let app: FastifyInstance
  let auth: AuthService
  let dataDirectory: string
  let servers: ServerRegistry
  let avatars: AvatarStore
  let javaRuntimes: JavaRuntimeRegistry
  let monitoringConfig: AppConfigStore
  let availableJavaRuntimes: JavaRuntime[]
  let processManager: ServerProcessManager | null = null

  beforeEach(async () => {
    processManager = null
    dataDirectory = await mkdtemp(join(tmpdir(), 'mmsmanager-routes-'))
    opened = await openDatabase({ path: join(dataDirectory, 'mmsmanager.sqlite') })
    monitoringConfig = new AppConfigStore(dataDirectory)
    await monitoringConfig.load()
    const staticWebDirectory = join(dataDirectory, 'web-dist')
    await mkdir(join(staticWebDirectory, 'assets'), { recursive: true })
    await writeFile(join(staticWebDirectory, 'index.html'), '<!doctype html><html><body><div id="root">fixture app</div></body></html>')
    await writeFile(join(staticWebDirectory, 'assets', 'app-AbCdEf12.js'), 'window.fixtureReady = true')
    const reader: SnapshotReader = { read: async () => { throw new Error('Not sampled') } }
    collector = new MachineCollector(opened.db, reader, 'Europe/Paris')
    auth = new AuthService(opened.native, dataDirectory, () => Date.parse('2026-11-23T12:00:00.000Z'))
    await auth.prepare()
    avatars = new AvatarStore(dataDirectory)
    await avatars.prepare()
    servers = new ServerRegistry(opened.db, dataDirectory, { MMSMANAGER_SERVER_ROOT: join(dataDirectory, 'servers') })
    await servers.prepare()
    availableJavaRuntimes = [{
      path: '/test/java-21/bin/java', version: '21.0.4', major: 21, vendor: 'OpenJDK', source: 'discovered',
    }]
    javaRuntimes = new JavaRuntimeRegistry(async () => availableJavaRuntimes)
    app = await createApiApp({
      db: opened.db,
      collector,
      timeZone: 'Europe/Paris',
      auth,
      avatars,
      servers,
      javaRuntimes,
      monitoringConfig,
      staticWebDirectory,
      webOrigin: WEB_ORIGIN,
      apiPort: 4174,
      now: () => Date.parse('2026-11-23T12:00:00.000Z'),
    })
  })

  afterEach(async () => {
    await collector.stop()
    await processManager?.shutdown()
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

  async function signInCreatedAccount(username: string, password: string) {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: { username, password } })
    expect(login.statusCode, login.body).toBe(200)
    const readCookies = (response: typeof login) => (Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [response.headers['set-cookie']]).filter((item): item is string => typeof item === 'string')
    let cookieList = readCookies(login)
    let cookieHeader = cookieList.map((item) => item.split(';')[0]).join('; ')
    let csrfToken = cookieList.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? ''
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...requestHeaders, cookie: cookieHeader } })
    expect(me.statusCode, me.body).toBe(200)
    if (me.json().user.mustChangePassword) {
      const replacement = `synthetic changed credential ${randomUUID()} 7!`
      const changed = await app.inject({
        method: 'POST', url: '/api/v1/auth/change-password',
        headers: { ...requestHeaders, cookie: cookieHeader, 'x-mms-csrf': csrfToken, 'content-type': 'application/json' },
        payload: { currentPassword: password, newPassword: replacement, confirmPassword: replacement },
      })
      expect(changed.statusCode, changed.body).toBe(200)
      cookieList = readCookies(changed)
      cookieHeader = cookieList.map((item) => item.split(';')[0]).join('; ')
      csrfToken = cookieList.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? ''
      const verified = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...requestHeaders, cookie: cookieHeader } })
      expect(verified.json().user.mustChangePassword).toBe(false)
    }
    return { cookieHeader, csrfToken, headers: { ...requestHeaders, cookie: cookieHeader, 'x-mms-csrf': csrfToken, 'content-type': 'application/json' } }
  }

  it('restricts temporary-password sessions until a changed password establishes a new session', async () => {
    const owner = await bootstrapAdmin()
    const ownerToken = /mmsmanager_session=([^;]+)/.exec(owner.cookieHeader)?.[1]
    const administrator = ownerToken ? auth.authenticate(ownerToken) : null
    expect(administrator?.role).toBe('administrator')

    const memberPassword = 'temporary route member credential 82!'
    const member = await auth.createUser(administrator!, { username: 'temporary-route-member', displayName: 'Temporary Route Member', password: memberPassword, role: 'member' })
    const createdAdminPassword = 'temporary route admin credential 83!'
    await auth.createUser(administrator!, { username: 'temporary-route-admin', displayName: 'Temporary Route Admin', password: createdAdminPassword, role: 'administrator' })

    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: { username: member.username, password: memberPassword } })
    expect(login.statusCode, login.body).toBe(200)
    const readCookies = (response: typeof login) => (Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [response.headers['set-cookie']]).filter((item): item is string => typeof item === 'string')
    const loginCookies = readCookies(login)
    let cookieHeader = loginCookies.map((item) => item.split(';')[0]).join('; ')
    let csrfToken = loginCookies.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? ''
    const restrictedHeaders = { ...requestHeaders, cookie: cookieHeader, 'x-mms-csrf': csrfToken, 'content-type': 'application/json' }
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: restrictedHeaders })
    expect(me.statusCode).toBe(200)
    expect(me.json().user).toMatchObject({ username: member.username, mustChangePassword: true, role: 'member' })
    for (const url of ['/api/v1/machine/current', '/api/v1/admin/users', '/api/v1/servers', '/api/v1/templates']) {
      const blocked = await app.inject({ method: 'GET', url, headers: restrictedHeaders })
      expect(blocked.statusCode, `${url}: ${blocked.body}`).toBe(403)
      expect(blocked.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED')
    }
    const blockedProfileEdit = await app.inject({ method: 'PATCH', url: '/api/v1/profile', headers: restrictedHeaders, payload: { displayName: 'Must remain restricted' } })
    expect(blockedProfileEdit.statusCode).toBe(403)
    expect(blockedProfileEdit.json().error.code).toBe('PASSWORD_CHANGE_REQUIRED')
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200)

    const changedPassword = 'permanent route member credential 84!'
    const change = (currentPassword: string, newPassword: string, confirmPassword = newPassword) => app.inject({
      method: 'POST', url: '/api/v1/auth/change-password', headers: restrictedHeaders,
      payload: { currentPassword, newPassword, confirmPassword },
    })
    const wrongCurrent = await change('incorrect synthetic current password', changedPassword)
    expect(wrongCurrent.statusCode).toBe(400)
    expect(wrongCurrent.json().error.code).toBe('CURRENT_PASSWORD')
    expect((await change(memberPassword, changedPassword, 'a different synthetic confirmation 85!')).statusCode).toBe(400)
    const unchanged = await change(memberPassword, memberPassword)
    expect(unchanged.statusCode).toBe(400)
    expect(unchanged.json().error.code).toBe('PASSWORD_UNCHANGED')
    const replacement = await change(memberPassword, changedPassword)
    expect(replacement.statusCode, replacement.body).toBe(200)
    expect(replacement.json()).toEqual({ ok: true, signInAgain: false })
    const previousSession = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: restrictedHeaders })
    expect(previousSession.statusCode).toBe(401)
    const replacementCookies = readCookies(replacement)
    cookieHeader = replacementCookies.map((item) => item.split(';')[0]).join('; ')
    csrfToken = replacementCookies.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? ''
    const normalHeaders = { ...requestHeaders, cookie: cookieHeader, 'x-mms-csrf': csrfToken, 'content-type': 'application/json' }
    const verified = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: normalHeaders })
    expect(verified.statusCode).toBe(200)
    expect(verified.json().user.mustChangePassword).toBe(false)
    expect((await app.inject({ method: 'GET', url: '/api/v1/machine/current', headers: normalHeaders })).statusCode).toBe(200)

    const resetPassword = 'temporary route reset credential 86!'
    const reset = await app.inject({
      method: 'POST', url: `/api/v1/admin/users/${member.id}/password`,
      headers: { ...requestHeaders, cookie: owner.cookieHeader, 'x-mms-csrf': owner.csrfToken, 'content-type': 'application/json' },
      payload: { password: resetPassword },
    })
    expect(reset.statusCode, reset.body).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: normalHeaders })).statusCode).toBe(401)
    const resetLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: { username: member.username, password: resetPassword } })
    const resetCookies = readCookies(resetLogin)
    const resetHeader = resetCookies.map((item) => item.split(';')[0]).join('; ')
    const resetMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...requestHeaders, cookie: resetHeader } })
    expect(resetLogin.statusCode).toBe(200)
    expect(resetMe.json().user.mustChangePassword).toBe(true)

    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: { username: 'temporary-route-admin', password: createdAdminPassword } })
    const adminCookies = readCookies(adminLogin)
    const adminHeader = adminCookies.map((item) => item.split(';')[0]).join('; ')
    const loggedOut = await app.inject({
      method: 'POST', url: '/api/v1/auth/logout',
      headers: { ...requestHeaders, cookie: adminHeader, 'x-mms-csrf': adminCookies.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? '', 'content-type': 'application/json' },
      payload: {},
    })
    expect(adminLogin.statusCode).toBe(200)
    expect(loggedOut.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...requestHeaders, cookie: adminHeader } })).statusCode).toBe(401)
  })

  it('applies server grants to reads, mutations, aggregates, and active-session revocation', async () => {
    const admin = await bootstrapAdmin()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }
    const principal = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    const member = await auth.createUser(principal, { username: 'scoped-reader', displayName: 'Scoped Reader', password: 'synthetic scoped reader 8R!c2Vn4', role: 'member' })
    const memberSession = await signInCreatedAccount('scoped-reader', 'synthetic scoped reader 8R!c2Vn4')
    const memberCookie = memberSession.cookieHeader
    const csrf = memberSession.csrfToken
    const memberHeaders = { ...requestHeaders, cookie: memberCookie, 'x-mms-csrf': csrf, 'content-type': 'application/json' }
    const serverId = randomUUID()
    const hiddenId = randomUUID()
    const at = '2026-11-23T12:00:00.000Z'
    const directory = join(dataDirectory, 'servers', 'scoped-fixture')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'server.properties'), 'motd=Scoped fixture\nmax-players=20\n')
    await writeFile(join(directory, 'notes.txt'), 'Fixture file content\n')
    for (const [id, name, folder] of [[serverId, 'Scoped fixture', directory], [hiddenId, 'Hidden fixture', join(dataDirectory, 'servers', 'hidden-fixture')]] as const) {
      await opened.db.insert(localServers).values({
        id, name, directory: folder, source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar',
        javaPath: null, javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: null,
        eula: 'accepted', managed: true, worldFolders: '[]', createdBy: principal.userId, createdAt: at, updatedAt: at,
      }).run()
    }
    await opened.db.insert(localServerRuntime).values({ serverId, status: 'stopped', updatedAt: at, restartRequired: false }).run()
    const route = `/api/v1/admin/servers/${serverId}/access`
    const scoped = (flags: Partial<import('@mmsmanager/shared').ServerAccessPermissions> = {}) => ({
      viewServer: true, viewLogs: false, sendConsoleCommands: false, controlLifecycle: false, startServer: false, stopServer: false, restartServer: false, viewPlayers: false,
      moderatePlayers: false, viewMods: false, manageMods: false, viewFiles: false, manageFiles: false,
      viewSettings: false, manageSettings: false, viewWorlds: false, viewBackups: false, createBackups: false, ...flags,
    })
    const saveGrant = (permissions: ReturnType<typeof scoped>) => app.inject({ method: 'PUT', url: route, headers: adminHeaders, payload: { userId: member.id, permissions } })

    expect((await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { ...requestHeaders, cookie: memberCookie } })).json().servers).toEqual([])
    expect((await app.inject({ method: 'GET', url: route, headers: { ...requestHeaders, cookie: admin.cookieHeader } })).json().users).toContainEqual(expect.objectContaining({
      userId: member.id, permissions: expect.objectContaining({ viewServer: false }),
    }))
    expect((await app.inject({ method: 'PUT', url: route, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: { userId: member.id, permissions: scoped() } })).statusCode).toBe(403)
    const first = await saveGrant(scoped())
    expect(first.statusCode, first.body).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { ...requestHeaders, cookie: memberCookie } })).json().servers).toMatchObject([{ id: serverId }])
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/console`, headers: { ...requestHeaders, cookie: memberCookie } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${hiddenId}/access`, headers: { ...requestHeaders, cookie: memberCookie } })).statusCode).toBe(404)

    const readOnly = await saveGrant(scoped({ viewLogs: true, viewPlayers: true, viewFiles: true, viewSettings: true, viewBackups: true }))
    expect(readOnly.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/console`, headers: { ...requestHeaders, cookie: memberCookie } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/files`, headers: { ...requestHeaders, cookie: memberCookie } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/files/read?path=notes.txt`, headers: { ...requestHeaders, cookie: memberCookie } })).json()).toMatchObject({ text: 'Fixture file content\n' })
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/properties`, headers: { ...requestHeaders, cookie: memberCookie } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/backups`, headers: { ...requestHeaders, cookie: memberCookie } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard/players', headers: { ...requestHeaders, cookie: memberCookie } })).json().summary.registeredServerCount).toBe(1)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/console`, headers: memberHeaders, payload: { command: 'list' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/files/create`, headers: memberHeaders, payload: { path: 'blocked.txt', kind: 'file' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${serverId}/properties`, headers: memberHeaders, payload: { motd: 'Blocked' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/backups`, headers: memberHeaders, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/backups/unknown/restore`, headers: memberHeaders, payload: { confirmation: 'x' } })).statusCode).toBe(403)

    expect((await saveGrant(scoped({ manageFiles: true }))).statusCode).toBe(400)
    const fileManager = await saveGrant(scoped({ viewFiles: true, manageFiles: true }))
    expect(fileManager.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/export.zip`, headers: memberHeaders })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/files/create`, headers: memberHeaders, payload: { path: 'member-created.txt', kind: 'file' } })).statusCode).toBe(201)
    const properties = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/properties`, headers: adminHeaders })
    const propertyUpdate = await saveGrant(scoped({ viewSettings: true, manageSettings: true }))
    expect(propertyUpdate.statusCode).toBe(200)
    const savedProperties = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${serverId}/properties`, headers: memberHeaders, payload: { motd: 'Member change', expectedSha256: properties.json().properties.sha256 } })
    expect(savedProperties.statusCode).toBe(200)
    expect((await saveGrant(scoped({ viewLogs: true, sendConsoleCommands: true }))).statusCode).toBe(400)
    const noOwnedProcess = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/console`, headers: memberHeaders, payload: { command: 'list' } })
    expect(noOwnedProcess.statusCode).toBe(403)

    const revoke = await saveGrant(scoped({ viewServer: false, viewLogs: false, viewPlayers: false, viewFiles: false, viewSettings: false, viewBackups: false }))
    expect(revoke.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { ...requestHeaders, cookie: memberCookie } })).json().servers).toEqual([])
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/status`, headers: { ...requestHeaders, cookie: memberCookie } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/access`, headers: { ...requestHeaders, cookie: memberCookie } })).statusCode).toBe(404)
  })

  it('publishes minimal health and denies telemetry until a real account is initialized', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ service: 'mmsmanager-local-api', status: 'ok', setupRequired: true })
    const current = await app.inject({ method: 'GET', url: '/api/v1/machine/current' })
    const history = await app.inject({ method: 'GET', url: '/api/v1/machine/history?from=2026-11-23T00%3A00%3A00Z&to=2026-11-23T00%3A01%3A00Z' })
    const storage = await app.inject({ method: 'GET', url: '/api/v1/machine/storage' })
    const players = await app.inject({ method: 'GET', url: '/api/v1/dashboard/players' })
    expect([current.statusCode, history.statusCode, storage.statusCode, players.statusCode]).toEqual([401, 401, 401, 401])
  })

  it('allows authenticated members to read the bounded dashboard player summary', async () => {
    const admin = await bootstrapAdmin()
    const adminToken = /mmsmanager_session=([^;]+)/.exec(admin.cookieHeader)?.[1]
    const principal = adminToken ? auth.authenticate(adminToken) : null
    const member = await auth.createUser(principal!, {
      username: 'summary-member', displayName: 'Summary Member', password: 'synthetic summary member pass 93!', role: 'member',
    })
    expect(member.role).toBe('member')
    const session = await signInCreatedAccount('summary-member', 'synthetic summary member pass 93!')
    const response = await app.inject({
      method: 'GET', url: '/api/v1/dashboard/players',
      headers: { ...requestHeaders, cookie: session.cookieHeader },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ summary: { playersOnline: 0, complete: true, registeredServerCount: 0, pollIntervalMs: 15_000 } })
  })

  it('serves the production web build and direct SPA routes from the same origin', async () => {
    const page = await app.inject({ method: 'GET', url: '/machine/history', headers: { host: '127.0.0.1:4174' } })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('fixture app')
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    const asset = await app.inject({ method: 'GET', url: '/assets/app-AbCdEf12.js', headers: { host: '127.0.0.1:4174' } })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toContain('text/javascript')
    expect(asset.headers['cache-control']).toContain('immutable')
    const missingAsset = await app.inject({ method: 'GET', url: '/assets/missing.js', headers: { host: '127.0.0.1:4174' } })
    expect(missingAsset.statusCode).toBe(404)
    const missingApi = await app.inject({ method: 'GET', url: '/api/v1/missing', headers: { host: '127.0.0.1:4174' } })
    expect(missingApi.statusCode).toBe(404)
    expect(missingApi.body).not.toContain('fixture app')
  })

  it('keeps HTTPS deployment checks exact and ignores forwarded-host spoofing', async () => {
    await bootstrapAdmin()
    const origin = 'https://panel.example.test'
    const productionApp = await createApiApp({
      db: opened.db, collector, timeZone: 'Europe/Paris', auth, avatars, servers, javaRuntimes,
      monitoringConfig, staticWebDirectory: join(dataDirectory, 'web-dist'), webOrigin: origin,
      apiPort: 4174, secureCookies: true, now: () => Date.parse('2026-11-23T12:00:00.000Z'),
    })
    try {
      const login = await productionApp.inject({
        method: 'POST', url: '/api/v1/auth/login',
        headers: { host: 'panel.example.test', origin, 'content-type': 'application/json' },
        payload: { username: 'owner', password: ADMIN_PASSWORD },
      })
      expect(login.statusCode).toBe(200)
      const cookieLines = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter((value): value is string => typeof value === 'string')
      expect(cookieLines).toHaveLength(2)
      expect(cookieLines.every((value) => /; Secure(?:;|$)/i.test(value))).toBe(true)
      expect(login.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains')

      const page = await productionApp.inject({ method: 'GET', url: '/servers', headers: { host: 'panel.example.test' } })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('fixture app')
      const preflight = await productionApp.inject({ method: 'OPTIONS', url: '/api/v1/health', headers: { host: 'panel.example.test', origin, 'access-control-request-method': 'GET' } })
      expect(preflight.headers['access-control-allow-origin']).toBe(origin)
      expect(preflight.headers['access-control-allow-credentials']).toBe('true')

      const foreign = await productionApp.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'panel.example.test', origin: 'https://foreign.example' } })
      expect(foreign.statusCode).toBe(403)
      const spoofed = await productionApp.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'foreign.example', origin, 'x-forwarded-host': 'panel.example.test' } })
      expect(spoofed.statusCode).toBe(400)
      expect(spoofed.json()).toMatchObject({ error: { code: 'BAD_HOST' } })
    } finally {
      await productionApp.close()
    }
  })

  it('persists and applies validated monitoring settings for administrators', async () => {
    const session = await bootstrapAdmin()
    const read = await app.inject({ method: 'GET', url: '/api/v1/admin/monitoring-settings', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({ fastSampleMs: 1_000, historySaveMs: 10_000, diskRefreshMs: 30_000, statusPollMs: 15_000 })
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/monitoring-settings',
      headers: { ...requestHeaders, cookie: session.cookieHeader, 'x-mms-csrf': session.csrfToken, 'content-type': 'application/json' },
      payload: { fastSampleMs: 2_000, historySaveMs: 15_000, diskRefreshMs: 45_000, statusPollMs: 25_000 },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json()).toEqual({ fastSampleMs: 2_000, historySaveMs: 15_000, diskRefreshMs: 45_000, statusPollMs: 25_000 })
    expect(collector.health.intervalMs).toBe(2_000)
    expect(await new AppConfigStore(dataDirectory).load()).toEqual({ fastSampleMs: 2_000, historySaveMs: 15_000, diskRefreshMs: 45_000, statusPollMs: 25_000 })
    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/monitoring-settings',
      headers: { ...requestHeaders, cookie: session.cookieHeader, 'x-mms-csrf': session.csrfToken, 'content-type': 'application/json' },
      payload: { fastSampleMs: 500, historySaveMs: 15_000, diskRefreshMs: 45_000, statusPollMs: 25_000 },
    })
    expect(invalid.statusCode).toBe(400)
    expect((await new AppConfigStore(dataDirectory).load()).fastSampleMs).toBe(2_000)
  })

  it('persists bounded backup settings and limits the settings endpoints to administrators', async () => {
    const admin = await bootstrapAdmin()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }
    const read = await app.inject({ method: 'GET', url: '/api/v1/admin/backup-settings', headers: adminHeaders })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json()).toMatchObject({ maxArchiveBytes: 20 * 1024 ** 3, storageQuotaBytes: 100 * 1024 ** 3, maxEntries: 100_000, maxDurationMinutes: 30, storageUsedBytes: 0 })
    expect(read.json().storageAvailableBytes).toEqual(expect.any(Number))

    const update = await app.inject({
      method: 'PATCH', url: '/api/v1/admin/backup-settings', headers: adminHeaders,
      payload: { maxArchiveBytes: 2 * 1024 ** 2, storageQuotaBytes: null, maxEntries: 200, maxDurationMinutes: 45 },
    })
    expect(update.statusCode, update.body).toBe(200)
    expect(update.json()).toMatchObject({ maxArchiveBytes: 2 * 1024 ** 2, storageQuotaBytes: null, maxEntries: 200, maxDurationMinutes: 45 })
    expect(opened.native.prepare('SELECT max_archive_bytes AS maxArchiveBytes, storage_quota_bytes AS storageQuotaBytes, max_entries AS maxEntries, max_duration_minutes AS maxDurationMinutes FROM backup_settings WHERE id = 1').get()).toEqual({ maxArchiveBytes: 2 * 1024 ** 2, storageQuotaBytes: null, maxEntries: 200, maxDurationMinutes: 45 })

    const invalid = await app.inject({
      method: 'PATCH', url: '/api/v1/admin/backup-settings', headers: adminHeaders,
      payload: { maxArchiveBytes: 2 * 1024 ** 2, storageQuotaBytes: 1, maxEntries: 200, maxDurationMinutes: 45 },
    })
    expect(invalid.statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/backup-settings', headers: adminHeaders })).json()).toMatchObject({ storageQuotaBytes: null, maxEntries: 200 })

    const ownerToken = /mmsmanager_session=([^;]+)/.exec(admin.cookieHeader)?.[1]
    const owner = ownerToken ? auth.authenticate(ownerToken) : null
    const memberPassword = 'synthetic backup settings member 4M!v8Qz2'
    await auth.createUser(owner!, { username: 'backup-settings-member', displayName: 'Backup Settings Member', password: memberPassword, role: 'member' })
    const member = await signInCreatedAccount('backup-settings-member', memberPassword)
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/backup-settings', headers: member.headers })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: '/api/v1/admin/backup-settings', headers: member.headers, payload: { maxArchiveBytes: 2 * 1024 ** 2, storageQuotaBytes: null, maxEntries: 200, maxDurationMinutes: 45 } })).statusCode).toBe(403)
  })

  it('deletes accounts only with administrator CSRF and username confirmation while retaining anonymous audit history', async () => {
    const adminSession = await bootstrapAdmin()
    const adminCookieToken = /mmsmanager_session=([^;]+)/.exec(adminSession.cookieHeader)?.[1]
    const adminPrincipal = adminCookieToken ? auth.authenticate(adminCookieToken) : null
    expect(adminPrincipal?.role).toBe('administrator')
    const member = await auth.createUser(adminPrincipal!, {
      username: 'fixture-member', displayName: 'Fixture Member', password: 'synthetic member passphrase 8H!long', role: 'member',
    })
    const memberSession = await auth.login('fixture-member', 'synthetic member passphrase 8H!long')
    const memberPrincipal = auth.authenticate(memberSession.sessionToken)!
    const avatarKey = 'a'.repeat(32)
    const avatarPath = join(avatars.directory, `${avatarKey}.webp`)
    await writeFile(avatarPath, Buffer.from('fixture image'), { mode: 0o600 })
    auth.updateAvatarKey(memberPrincipal, avatarKey)
    opened.native.prepare('INSERT INTO user_notification_reads (user_id, event_id, read_at) VALUES (?, ?, ?)').run(member.id, 'fixture-event', '2026-11-23T12:00:00.000Z')

    const denied = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/users/${member.id}`,
      headers: { ...requestHeaders, cookie: `mmsmanager_session=${memberSession.sessionToken}; mmsmanager_csrf=${memberSession.csrfToken}`, 'x-mms-csrf': memberSession.csrfToken, 'content-type': 'application/json' },
      payload: { confirmation: member.username },
    })
    expect(denied.statusCode).toBe(403)
    const mismatch = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/users/${member.id}`,
      headers: { ...requestHeaders, cookie: adminSession.cookieHeader, 'x-mms-csrf': adminSession.csrfToken, 'content-type': 'application/json' },
      payload: { confirmation: 'wrong-name' },
    })
    expect(mismatch.statusCode).toBe(400)
    expect(auth.authenticate(memberSession.sessionToken)).not.toBeNull()

    const deleted = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/users/${member.id}`,
      headers: { ...requestHeaders, cookie: adminSession.cookieHeader, 'x-mms-csrf': adminSession.csrfToken, 'content-type': 'application/json' },
      payload: { confirmation: member.username },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ ok: true, avatarCleanup: 'done' })
    expect(auth.authenticate(memberSession.sessionToken)).toBeNull()
    expect(auth.listUsers().users.some((user) => user.id === member.id)).toBe(false)
    expect(opened.native.prepare('SELECT count(*) AS count FROM user_preferences WHERE user_id = ?').get(member.id)).toEqual({ count: 0 })
    expect(opened.native.prepare('SELECT count(*) AS count FROM user_notification_reads WHERE user_id = ?').get(member.id)).toEqual({ count: 0 })
    expect(opened.native.prepare('SELECT action, actor_user_id AS actor, subject_user_id AS subject FROM security_audit_events ORDER BY id DESC LIMIT 1').get()).toEqual({ action: 'user.deleted', actor: adminPrincipal!.userId, subject: null })
    expect(opened.native.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    await expect(readFile(avatarPath)).rejects.toThrow()

    const selfDelete = await app.inject({
      method: 'DELETE', url: `/api/v1/admin/users/${adminPrincipal!.userId}`,
      headers: { ...requestHeaders, cookie: adminSession.cookieHeader, 'x-mms-csrf': adminSession.csrfToken, 'content-type': 'application/json' },
      payload: { confirmation: 'owner' },
    })
    expect(selfDelete.statusCode).toBe(409)
    expect(auth.getSetupRequired()).toBe(false)
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

  it('keeps the default sign-in limit at five attempts per 15 minutes', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/auth/login',
        headers: { ...requestHeaders, 'content-type': 'application/json' },
        payload: { username: `missing-account-${attempt}`, password: 'not a real account credential' },
      })
      expect(response.statusCode).toBe(401)
    }
    const limited = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { ...requestHeaders, 'content-type': 'application/json' },
      payload: { username: 'another-missing-account', password: 'not a real account credential' },
    })
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
    const storage = await app.inject({ method: 'GET', url: '/api/v1/machine/storage', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    expect(storage.statusCode).toBe(200)
    expect(storage.json()).toEqual({ volumes: [], history: [], historyRetentionDays: 30 })
    const oversizedStorageHistory = await app.inject({ method: 'GET', url: '/api/v1/machine/storage?limit=501', headers: { ...requestHeaders, cookie: session.cookieHeader } })
    expect(oversizedStorageHistory.statusCode).toBe(400)
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
    const memberSession = await signInCreatedAccount('member', 'synthetic member passphrase 3M!k4Pq9')
    const memberCookieHeader = memberSession.cookieHeader
    const memberCsrf = memberSession.csrfToken
    const denied = await app.inject({
      method: 'POST', url: '/api/v1/admin/servers/import/inspect',
      headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' },
      payload: { path: serverDirectory },
    })
    expect(denied.statusCode).toBe(403)
    const memberList = await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { ...requestHeaders, cookie: memberCookieHeader } })
    expect(memberList.statusCode).toBe(200)
    expect(memberList.json().servers).toEqual([])
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
    const cancelMissingCsrf = await app.inject({
      method: 'POST', url: `/api/v1/admin/server-installs/${randomUUID()}/cancel`,
      headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: {},
    })
    expect(cancelMissingCsrf.statusCode).toBe(403)
    const memberCancel = await app.inject({
      method: 'POST', url: `/api/v1/admin/server-installs/${randomUUID()}/cancel`,
      headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' }, payload: {},
    })
    expect(memberCancel.statusCode).toBe(403)
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
    const runtimeSettings = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/runtime-settings`, headers: adminHeaders })
    expect(runtimeSettings.statusCode).toBe(200)
    expect(runtimeSettings.json().settings).toMatchObject({ serverId: id, javaSelectionMode: 'manual', compatibility: 'unknown', startScript: 'untracked', runtimeStatus: 'stopped' })
    const autoRuntimeInput = { javaSelectionMode: 'auto', javaPath: null, confirmCompatibilityOverride: false, minMemoryMb: 512, maxMemoryMb: 1024, jvmOptions: { collector: 'default', maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false } }
    expect((await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/runtime-settings`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: autoRuntimeInput })).statusCode).toBe(403)
    const savedRuntime = await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/runtime-settings`, headers: adminHeaders, payload: autoRuntimeInput })
    expect(savedRuntime.statusCode, savedRuntime.body).toBe(200)
    expect(savedRuntime.json().settings).toMatchObject({ javaSelectionMode: 'auto', javaPath: null, javaSelectionReason: 'automatic-requirement-unknown' })
    const rejectedRuntimeCommand = await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/runtime-settings`, headers: adminHeaders, payload: { ...autoRuntimeInput, command: 'arbitrary-shell' } })
    expect(rejectedRuntimeCommand.statusCode).toBe(400)
    const automation = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/automation`, headers: adminHeaders })
    expect(automation.statusCode).toBe(200)
    expect(automation.json().automation).toMatchObject({ serverId: id, enabled: false, jobs: [], restartSchedule: { enabled: false, onlyWhenEmpty: true, waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30 }, restartJobs: [] })
    const automationWithoutCsrf = await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/automation`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: { enabled: true, frequency: 'daily', localTime: '14:30', weekday: null } })
    expect(automationWithoutCsrf.statusCode).toBe(403)
    const savedAutomation = await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/automation`, headers: adminHeaders, payload: { enabled: true, frequency: 'daily', localTime: '14:30', weekday: null } })
    expect(savedAutomation.statusCode).toBe(200)
    expect(savedAutomation.json().automation).toMatchObject({ enabled: true, frequency: 'daily', localTime: '14:30', timeZone: 'Europe/Paris', nextRunAt: '2026-11-23T13:30:00.000Z' })
    const restartScheduleInput = { enabled: true, frequency: 'weekly', localTime: '03:00', weekday: 1, onlyWhenEmpty: true, waitPolicy: 'retry', retryIntervalMinutes: 5, waitDeadlineMinutes: 30 }
    const restartScheduleWithoutCsrf = await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/automation/restart-schedule`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: restartScheduleInput })
    expect(restartScheduleWithoutCsrf.statusCode).toBe(403)
    const savedRestartSchedule = await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/automation/restart-schedule`, headers: adminHeaders, payload: restartScheduleInput })
    expect(savedRestartSchedule.statusCode).toBe(200)
    expect(savedRestartSchedule.json().automation.restartSchedule).toMatchObject({ enabled: true, frequency: 'weekly', weekday: 1, timeZone: 'Europe/Paris', onlyWhenEmpty: true, waitPolicy: 'retry', retryIntervalMinutes: 5, waitDeadlineMinutes: 30 })
    const restartWithoutRunning = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/restart`, headers: adminHeaders, payload: {} })
    expect(restartWithoutRunning.statusCode).toBe(409)
    expect(restartWithoutRunning.json()).toMatchObject({ error: { code: 'RESTART_NOT_RUNNING' } })
    const restartWithoutCsrf = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/restart`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: {} })
    expect(restartWithoutCsrf.statusCode).toBe(403)
    const properties = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/properties`, headers: adminHeaders })
    expect(properties.statusCode).toBe(200)
    expect(properties.json().properties.settings.motd).toBe('Before')
    expect(properties.json().properties).toMatchObject({ serverVersion: '1.21.4', serverSoftware: 'vanilla', sha256: expect.any(String) })
    expect(properties.json().properties.protectedProperties).toContainEqual(expect.objectContaining({ key: 'server-ip', configured: true }))
    expect(properties.json().properties.unknownKeys).toContain('unknown-option')

    const missingCsrf = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: { motd: 'Blocked' } })
    expect(missingCsrf.statusCode).toBe(403)
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: adminHeaders, payload: { motd: 'After', maxPlayers: 32, expectedSha256: properties.json().properties.sha256 } })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().properties.settings).toMatchObject({ motd: 'After', maxPlayers: 32 })
    expect(updated.json().properties.backups).toHaveLength(1)
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toContain('server-ip=127.0.0.1')
    const advancedUpdate = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: adminHeaders, payload: {
      expectedSha256: updated.json().properties.sha256,
      advancedProperties: { 'allow-flight': 'false', hardcore: 'false', 'rate-limit': '0' },
    } })
    expect(advancedUpdate.statusCode).toBe(200)
    expect(advancedUpdate.json().properties.advancedProperties).toMatchObject({ 'allow-flight': 'false', hardcore: 'false', 'rate-limit': '0' })
    expect(advancedUpdate.json().properties.backups).toHaveLength(2)
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toContain('rate-limit=0')

    const fileInventory = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/files`, headers: adminHeaders })
    expect(fileInventory.statusCode).toBe(200)
    const propertyEntry = fileInventory.json().entries.find((entry: { name: string }) => entry.name === 'server.properties')
    expect(propertyEntry).toMatchObject({ contentState: 'protected', canEdit: false, canDownload: false })
    await mkdir(join(managedDirectory, 'versions', '1.21.4'), { recursive: true })
    await writeFile(join(managedDirectory, 'versions', '1.21.4', 'server.jar'), 'route fixture only')
    const runtimeInventory = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/files`, headers: adminHeaders })
    expect(runtimeInventory.json().entries.find((entry: { name: string }) => entry.name === 'versions')).toMatchObject({ contentState: 'protected', canRename: false, canTrash: false })
    const blockedRuntimeCreate = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/create`, headers: adminHeaders, payload: { path: 'versions/notes.txt', kind: 'file', text: 'blocked' } })
    expect(blockedRuntimeCreate.statusCode).toBe(409)
    expect(blockedRuntimeCreate.json()).toMatchObject({ error: { code: 'FILE_PROTECTED' } })
    await writeFile(join(managedDirectory, 'notes.txt'), 'route file original\n')
    const openedText = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/files/read?path=notes.txt`, headers: adminHeaders })
    expect(openedText.statusCode).toBe(200)
    expect(openedText.json()).toMatchObject({ contentState: 'editable', text: 'route file original\n' })
    const noCsrfWrite = await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/files`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: { path: 'notes.txt', text: 'blocked', expectedSha256: openedText.json().sha256 } })
    expect(noCsrfWrite.statusCode).toBe(403)
    const savedText = await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/files`, headers: adminHeaders, payload: { path: 'notes.txt', text: 'route file edited\n', expectedSha256: openedText.json().sha256 } })
    expect(savedText.statusCode).toBe(200)
    expect(await readFile(join(managedDirectory, 'notes.txt'), 'utf8')).toBe('route file edited\n')
    const createFolder = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/create`, headers: adminHeaders, payload: { path: 'route-folder', kind: 'folder' } })
    expect(createFolder.statusCode).toBe(201)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/files`, headers: adminHeaders })).json().entries.some((entry: { name: string }) => entry.name === 'route-folder')).toBe(true)
    await writeFile(join(managedDirectory, 'file-action.txt'), 'exact file action bytes')
    const renamedFile = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/rename`, headers: adminHeaders, payload: { path: 'file-action.txt', newName: 'renamed-action.txt' } })
    expect(renamedFile.statusCode, renamedFile.body).toBe(200)
    expect(await readFile(join(managedDirectory, 'renamed-action.txt'), 'utf8')).toBe('exact file action bytes')
    const sameDirectoryMove = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/move`, headers: adminHeaders, payload: { sourcePath: 'renamed-action.txt', destinationDirectory: '' } })
    expect(sameDirectoryMove.statusCode, sameDirectoryMove.body).toBe(400)
    const invalidMoveShape = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/move`, headers: adminHeaders, payload: { sourcePath: 'renamed-action.txt', destinationDirectory: 'nested', destinationPath: 'nested/renamed-action.txt' } })
    expect(invalidMoveShape.statusCode).toBe(400)
    const uploadBoundary = '----mmsmanager-real-file-batch'
    const uploadManifest = { files: ['nested/chunk.bin', 'notes/asset.bin'], directories: ['empty/child'] }
    const binaryBytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x41, 0x0a])
    const uploadBody = multipartFiles(uploadBoundary, uploadManifest, [
      { path: uploadManifest.files[0]!, bytes: binaryBytes },
      { path: uploadManifest.files[1]!, bytes: Buffer.from([0x7f, 0x00, 0x25]) },
    ])
    const multipartHeaders = {
      ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken,
      'content-type': `multipart/form-data; boundary=${uploadBoundary}`,
    }
    const uploadedBatch = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/upload-batch?path=`, headers: multipartHeaders, payload: uploadBody })
    expect(uploadedBatch.statusCode, uploadedBatch.body).toBe(201)
    expect(uploadedBatch.json()).toMatchObject({ path: '', entries: expect.arrayContaining([expect.objectContaining({ name: 'empty', kind: 'folder' }), expect.objectContaining({ name: 'nested', kind: 'folder' }), expect.objectContaining({ name: 'notes', kind: 'folder' })]) })
    expect(await readFile(join(managedDirectory, 'nested', 'chunk.bin'))).toEqual(binaryBytes)
    expect(await readFile(join(managedDirectory, 'notes', 'asset.bin'))).toEqual(Buffer.from([0x7f, 0x00, 0x25]))
    expect(await readdir(join(managedDirectory, 'empty', 'child'))).toEqual([])
    const movedFile = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/move`, headers: adminHeaders, payload: { sourcePath: 'renamed-action.txt', destinationDirectory: 'nested' } })
    expect(movedFile.statusCode, movedFile.body).toBe(200)
    expect(await readFile(join(managedDirectory, 'nested', 'renamed-action.txt'), 'utf8')).toBe('exact file action bytes')
    const blockedRuntimeMove = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/move`, headers: adminHeaders, payload: { sourcePath: 'notes.txt', destinationDirectory: 'versions' } })
    expect(blockedRuntimeMove.statusCode).toBe(409)
    expect(blockedRuntimeMove.json()).toMatchObject({ error: { code: 'FILE_PROTECTED' } })
    const blockedRuntimeRename = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/rename`, headers: adminHeaders, payload: { path: 'versions', newName: 'old-versions' } })
    expect(blockedRuntimeRename.statusCode).toBe(409)
    const nestedInventory = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/files?path=nested`, headers: adminHeaders })
    expect(nestedInventory.statusCode).toBe(200)
    expect(nestedInventory.json().entries).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'chunk.bin', sizeBytes: binaryBytes.byteLength })]))
    const overwriteAttempt = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/upload-batch?path=`, headers: multipartHeaders, payload: uploadBody })
    expect(overwriteAttempt.statusCode).toBe(409)
    expect(overwriteAttempt.json()).toMatchObject({ error: { code: 'FILE_ALREADY_EXISTS' } })
    expect(await readFile(join(managedDirectory, 'nested', 'chunk.bin'))).toEqual(binaryBytes)
    const unsafeBody = multipartFiles(uploadBoundary, { files: ['../escape.bin'], directories: [] }, [{ path: '../escape.bin', bytes: Buffer.from('no') }])
    const unsafeUpload = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/upload-batch?path=`, headers: multipartHeaders, payload: unsafeBody })
    expect(unsafeUpload.statusCode).toBe(400)
    expect(unsafeUpload.json()).toMatchObject({ error: { code: 'FILE_PATH_REJECTED' } })
    const noCsrfUpload = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/upload-batch?path=`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': `multipart/form-data; boundary=${uploadBoundary}` }, payload: uploadBody })
    expect(noCsrfUpload.statusCode).toBe(403)

    const backupId = updated.json().properties.backups[0].id as string
    const restorePreview = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/properties/backups/${backupId}/preview`, headers: adminHeaders })
    expect(restorePreview.statusCode).toBe(200)
    expect(restorePreview.json().preview).toMatchObject({ checksumValid: true })
    expect(restorePreview.json().preview.changedSettings).toContainEqual({ key: 'motd', current: 'After', restored: 'Before' })
    const restoredProperties = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/properties/backups/${backupId}/restore`, headers: adminHeaders, payload: { expectedCurrentSha256: restorePreview.json().preview.currentSha256 } })
    expect(restoredProperties.statusCode).toBe(200)
    expect(restoredProperties.json()).toMatchObject({ properties: { settings: { motd: 'Before' } }, recoveryBackupId: expect.any(String) })
    let propertiesHash = restoredProperties.json().properties.sha256 as string
    const onlineModeConfirmationMissing = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: adminHeaders, payload: { onlineMode: false, expectedSha256: propertiesHash } })
    expect(onlineModeConfirmationMissing.statusCode).toBe(409)
    expect(onlineModeConfirmationMissing.json()).toMatchObject({ error: { code: 'ONLINE_MODE_CONFIRMATION_REQUIRED' } })
    await opened.db.update(localServerRuntime).set({ status: 'running', updatedAt: now }).where(eq(localServerRuntime.serverId, id)).run()
    const onlineModeRunning = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: adminHeaders, payload: { onlineMode: false, confirmOnlineModeChange: true, expectedSha256: propertiesHash } })
    expect(onlineModeRunning.statusCode).toBe(409)
    expect(onlineModeRunning.json()).toMatchObject({ error: { code: 'ONLINE_MODE_REQUIRES_STOPPED' } })
    await opened.db.update(localServerRuntime).set({ status: 'stopped', updatedAt: now }).where(eq(localServerRuntime.serverId, id)).run()
    const onlineModeSaved = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: adminHeaders, payload: { onlineMode: false, confirmOnlineModeChange: true, expectedSha256: propertiesHash } })
    expect(onlineModeSaved.statusCode).toBe(200)
    expect(onlineModeSaved.json().properties.settings.onlineMode).toBe(false)
    expect(await readFile(join(managedDirectory, 'server.properties'), 'utf8')).toContain('online-mode=false')
    propertiesHash = onlineModeSaved.json().properties.sha256 as string

    const unauthenticated = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/start`, headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: {} })
    expect(unauthenticated.statusCode).toBe(401)
    const principal = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    await auth.createUser(principal, { username: 'server-member', displayName: 'Server Member', password: 'synthetic member passphrase 6R!d2Hk8', role: 'member' })
    const memberSession = await signInCreatedAccount('server-member', 'synthetic member passphrase 6R!d2Hk8')
    const memberCookieHeader = memberSession.cookieHeader
    const memberCsrf = memberSession.csrfToken
    const memberHeaders = { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' }
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/upload-batch?path=`, headers: { ...memberHeaders, 'content-type': `multipart/form-data; boundary=${uploadBoundary}` }, payload: uploadBody })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/runtime-settings`, headers: memberHeaders })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/automation`, headers: memberHeaders })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/automation`, headers: memberHeaders, payload: { enabled: false, frequency: 'daily', localTime: '14:30', weekday: null } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/automation/restart-schedule`, headers: memberHeaders, payload: { enabled: true, frequency: 'daily', localTime: '03:00', weekday: null, onlyWhenEmpty: true, waitPolicy: 'skip', retryIntervalMinutes: 5, waitDeadlineMinutes: 30 } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/restart`, headers: memberHeaders, payload: {} })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/files`, headers: memberHeaders })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${id}/files/read?path=notes.txt`, headers: memberHeaders })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PUT', url: `/api/v1/admin/servers/${id}/files`, headers: memberHeaders, payload: { path: 'notes.txt', text: 'blocked', expectedSha256: savedText.json().sha256 } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/rename`, headers: memberHeaders, payload: { path: 'renamed-action.txt', newName: 'member-name.txt' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/files/move`, headers: memberHeaders, payload: { sourcePath: 'renamed-action.txt', destinationDirectory: 'nested' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/start`, headers: memberHeaders, payload: {} })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${id}/properties`, headers: memberHeaders, payload: { motd: 'Blocked' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/player-actions`, headers: memberHeaders, payload: { action: 'ban', username: 'Alex_123' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/player-actions`, headers: adminHeaders, payload: { action: 'ban', username: 'Alex_123;stop' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/player-actions`, headers: adminHeaders, payload: { action: 'ban', username: 'Alex_123' } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${id}/console`, headers: memberHeaders })).statusCode).toBe(404)
    const modsRead = await app.inject({ method: 'GET', url: `/api/v1/servers/${id}/mods`, headers: memberHeaders })
    expect(modsRead.statusCode).toBe(404)
    const modsNoCsrf = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/mods/example.jar/disable`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: {} })
    expect(modsNoCsrf.statusCode).toBe(403)
    const modsMemberMutation = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/mods/example.jar/disable`, headers: memberHeaders, payload: {} })
    expect(modsMemberMutation.statusCode).toBe(404)
    const modsUnsupported = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/mods/example.jar/disable`, headers: adminHeaders, payload: {} })
    expect(modsUnsupported.statusCode, JSON.stringify(modsUnsupported.json())).toBe(409)
    expect(modsUnsupported.json()).toMatchObject({ error: { code: 'MODS_UNSUPPORTED' } })
    const boundary = '----mmsmanager-mod-route-fixture'
    const multipartBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.jar"\r\nContent-Type: application/java-archive\r\n\r\nnot-a-jar\r\n--${boundary}--\r\n`
    const multipartResponse = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${id}/mods`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipartBody })
    expect(multipartResponse.statusCode).toBe(409)
    expect(multipartResponse.json()).toMatchObject({ error: { code: 'MODS_UNSUPPORTED' } })
  })

  it('protects server backup inventory, download and typed restore with stopped managed-server gates', async () => {
    const admin = await bootstrapAdmin()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }
    const serverId = randomUUID()
    const createdAt = '2026-11-23T12:00:00.000Z'
    const directory = join(dataDirectory, 'servers', 'backup-fixture')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'server.properties'), 'level-name=world\n')
    await writeFile(join(directory, 'server.jar'), 'synthetic jar data')
    await mkdir(join(directory, 'world'), { recursive: true })
    await writeFile(join(directory, 'world', 'level.dat'), 'fixture world bytes')
    await opened.db.insert(localServers).values({
      id: serverId, name: 'Backup Fixture', directory, source: 'created', software: 'vanilla', version: '1.21.4',
      jarName: 'server.jar', javaPath: '/fixture/java', javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 2048,
      port: 25565, eula: 'accepted', managed: true, worldFolders: JSON.stringify(['world']), createdBy: null, createdAt, updatedAt: createdAt,
    }).run()
    await opened.db.insert(localServerRuntime).values({
      serverId, status: 'stopped', processPid: null, processStartMarker: null, processBootId: null, startedAt: null,
      updatedAt: createdAt, lastExitCode: null, errorMessage: null, restartRequired: false,
    }).run()

    const route = `/api/v1/admin/servers/${serverId}/backups`
    expect((await app.inject({ method: 'GET', url: route })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: route, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'application/json' }, payload: {} })).statusCode).toBe(403)
    const emptyInventory = await app.inject({ method: 'GET', url: route, headers: adminHeaders })
    expect(emptyInventory.statusCode, emptyInventory.body).toBe(200)
    expect(emptyInventory.headers['x-mms-request-id']).toBeTruthy()
    expect(emptyInventory.json()).toMatchObject({
      serverId, items: [], truncated: false, storageUsedBytes: 0, storageLimitBytes: expect.any(Number),
      quotaWarning: false, runtimeStatus: 'stopped',
    })
    const serverArchive = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/export.zip`, headers: adminHeaders })
    expect(serverArchive.statusCode, serverArchive.body).toBe(200)
    expect(serverArchive.headers['content-type']).toContain('application/zip')
    expect(serverArchive.headers['content-disposition']).toContain(`Backup%20Fixture-${serverId.slice(0, 8)}.zip`)
    expect(Buffer.from(serverArchive.rawPayload).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(Buffer.from(serverArchive.rawPayload).includes(Buffer.from('level-name=world'))).toBe(true)
    const created = await app.inject({ method: 'POST', url: route, headers: adminHeaders, payload: {} })
    expect(created.statusCode, created.body).toBe(201)
    const backupId = created.json().backup.id as string
    const inventory = await app.inject({ method: 'GET', url: route, headers: adminHeaders })
    expect(inventory.statusCode).toBe(200)
    expect(inventory.json().items).toMatchObject([{ id: backupId, kind: 'manual', excludedCount: 0 }])
    const worlds = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/worlds`, headers: adminHeaders })
    expect(worlds.json().worlds.entries.find((entry: { path: string }) => entry.path === 'world')).toMatchObject({ backupAvailable: true })
    const preview = await app.inject({ method: 'GET', url: `${route}/${backupId}/preview`, headers: adminHeaders })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().preview).toMatchObject({ integrityValid: true, serverStopped: true, canRestore: true })
    const download = await app.inject({ method: 'GET', url: `${route}/${backupId}/download`, headers: adminHeaders })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain(`${backupId}.mmsbackup`)
    expect(Buffer.from(download.body).subarray(0, 8).toString()).toBe('MMSBACK1')
    const rejectedRestore = await app.inject({ method: 'POST', url: `${route}/${backupId}/restore`, headers: adminHeaders, payload: { confirmation: 'restore Backup Fixture' } })
    expect(rejectedRestore.statusCode).toBe(409)
    expect(rejectedRestore.json()).toMatchObject({ error: { code: 'RESTORE_CONFIRMATION_FAILED' } })
    const restored = await app.inject({ method: 'POST', url: `${route}/${backupId}/restore`, headers: adminHeaders, payload: { confirmation: 'RESTORE Backup Fixture' } })
    expect(restored.statusCode, restored.body).toBe(200)
    expect(restored.json()).toMatchObject({ ok: true, backupId, safetyBackupId: expect.any(String), rollbackCleanupPending: false })
    expect(await readFile(join(directory, 'world', 'level.dat'), 'utf8')).toBe('fixture world bytes')
    const finalInventory = await app.inject({ method: 'GET', url: route, headers: adminHeaders })
    expect(finalInventory.json().items.map((item: { kind: string }) => item.kind).sort()).toEqual(['manual', 'pre-restore'])

    const principal = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    await auth.createUser(principal, { username: 'backup-member', displayName: 'Backup Member', password: 'synthetic member passphrase 3M!v9Ld2', role: 'member' })
    const memberSession = await signInCreatedAccount('backup-member', 'synthetic member passphrase 3M!v9Ld2')
    const memberCookieHeader = memberSession.cookieHeader
    expect((await app.inject({ method: 'GET', url: route, headers: { ...requestHeaders, cookie: memberCookieHeader } })).statusCode).toBe(404)
  })

  it('protects managed world and server-history endpoints and returns only scoped persisted records', async () => {
    const serverId = randomUUID()
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/worlds` })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/server-history/day?scope=${serverId}&date=2026-11-23` })).statusCode).toBe(401)
    const admin = await bootstrapAdmin()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader }
    const directory = join(dataDirectory, 'servers', 'history-fixture')
    await mkdir(join(directory, 'world'), { recursive: true })
    await writeFile(join(directory, 'server.properties'), 'level-name=world\nserver-port=25565\n')
    await writeFile(join(directory, 'world', 'level.dat'), 'fixture world bytes')
    const at = '2026-11-23T11:30:00.000Z'
    await opened.db.insert(localServers).values({
      id: serverId, name: 'History Fixture', directory, source: 'created', software: 'vanilla', version: '1.21.4',
      jarName: 'server.jar', javaPath: null, javaMajor: 21, minMemoryMb: 512, maxMemoryMb: 2048,
      port: 25565, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: null, createdAt: at, updatedAt: at,
    }).run()
    const fixedNow = () => Date.parse('2026-11-23T12:00:00.000Z')
    recordServerResourceSample(opened.db, serverId, at, { cpuPercent: 12.5, memoryRssBytes: 4096, uptimeSeconds: 900 }, fixedNow)
    recordStructuredServerEvent(opened.db, {
      serverId, occurredAt: at, category: 'player', eventType: 'player_joined', description: 'MiraWoods joined the server.',
      rawMessage: '[Server thread/INFO]: MiraWoods joined the game', confidence: 'high', source: 'owned-log',
    }, fixedNow)

    const worlds = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/worlds`, headers: adminHeaders })
    expect(worlds.statusCode).toBe(200)
    expect(worlds.json().worlds).toMatchObject({ status: 'available', levelName: 'world' })
    expect(worlds.json().worlds.entries[0]).toMatchObject({ path: 'world', sizeBytes: 19, sizeComplete: true })
    const calendar = await app.inject({ method: 'GET', url: `/api/v1/admin/server-history/calendar?scope=${serverId}&year=2026&month=11`, headers: adminHeaders })
    expect(calendar.statusCode).toBe(200)
    expect(calendar.json().calendar.days.find((item: { date: string }) => item.date === '2026-11-23')).toMatchObject({ status: 'partial', sampleCount: 1, eventCount: 1 })
    const day = await app.inject({ method: 'GET', url: `/api/v1/admin/server-history/day?scope=${serverId}&date=2026-11-23`, headers: adminHeaders })
    expect(day.statusCode).toBe(200)
    expect(day.json().day).toMatchObject({ status: 'partial', summary: { sampleCount: 1, cpuAveragePercent: 12.5 }, events: [{ eventType: 'player_joined', rawMessage: expect.stringContaining('joined the game') }] })
    expect(day.json().day).toMatchObject({ eventsTruncated: false, sessionsTruncated: false })
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/server-history/day?scope=${serverId}&date=2026-02-30`, headers: adminHeaders })).statusCode).toBe(400)

    const principal = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    await auth.createUser(principal, { username: 'history-member', displayName: 'History Member', password: 'synthetic member passphrase 4T!s8Cq2', role: 'member' })
    const historySession = await signInCreatedAccount('history-member', 'synthetic member passphrase 4T!s8Cq2')
    const cookieHeader = historySession.cookieHeader
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/worlds`, headers: { ...requestHeaders, cookie: cookieHeader } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/server-history/day?scope=${serverId}&date=2026-11-23`, headers: { ...requestHeaders, cookie: cookieHeader } })).statusCode).toBe(404)
  })

  it('serves persisted activity and safe templates with role-checked mutations', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/activity' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/notifications' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/templates' })).statusCode).toBe(401)
    const admin = await bootstrapAdmin()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader }
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/templates', headers: { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }, payload: {
      name: 'Local Paper', software: 'paper', version: '1.21.4', minMemoryMb: 1024, maxMemoryMb: 4096,
    } })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().template).not.toHaveProperty('directory')
    expect(created.json().template).not.toHaveProperty('javaPath')
    expect(created.json().template).not.toHaveProperty('eulaAccepted')
    expect((await app.inject({ method: 'GET', url: '/api/v1/templates', headers: adminHeaders })).json().templates).toHaveLength(1)
    const serverId = randomUUID()
    const at = '2026-11-23T12:00:00.000Z'
    await opened.db.insert(localServers).values({ id: serverId, name: 'Imported fixture', directory: join(dataDirectory, 'unused-import-fixture'), source: 'imported', software: 'unknown', version: null, jarName: null, javaPath: null, javaMajor: null, requiredJavaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024, jvmOptionsJson: '{"collector":"default","maxGCPauseMs":null,"parallelGcThreads":null,"alwaysPreTouch":false,"disableExplicitGc":false}', startScriptSha256: null, port: null, eula: 'unknown', managed: false, worldFolders: '[]', createdBy: null, createdAt: at, updatedAt: at })
    await opened.db.insert(localServerEvents).values({ serverId, action: 'server-backup-schedule-failed', outcome: 'failure', occurredAt: at, detail: '/private/fixture/path' })
    await opened.db.insert(localServerStructuredEvents).values({ serverId, occurredAt: at, category: 'server', eventType: 'server_crashed', description: 'The owned server process exited unexpectedly.', confidence: 'high', source: 'panel-process' })
    await opened.db.insert(localServerRuntime).values({ serverId, status: 'crashed', updatedAt: at, restartRequired: true })
    await opened.db.insert(auditEvents).values({ action: 'login.failed', outcome: 'failure', occurredAt: at })
    const metadata = await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${serverId}/metadata`, headers: { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }, payload: { name: 'Renamed fixture' } })
    expect(metadata.statusCode).toBe(200)
    expect(metadata.json().server).toMatchObject({ id: serverId, name: 'Renamed fixture', source: 'imported', managed: false })
    const adminActivity = await app.inject({ method: 'GET', url: '/api/v1/activity?category=security', headers: adminHeaders })
    expect(adminActivity.statusCode).toBe(200)
    expect(adminActivity.json().events).toContainEqual(expect.objectContaining({ title: 'Administrator setup completed', source: 'audit' }))
    expect((await app.inject({ method: 'GET', url: '/api/v1/activity?limit=101', headers: adminHeaders })).statusCode).toBe(400)
    const adminNotificationsResponse = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: adminHeaders })
    expect(adminNotificationsResponse.statusCode).toBe(200)
    expect(adminNotificationsResponse.json().items.map((item: { event: { title: string } }) => item.event.title)).toEqual(expect.arrayContaining(['Scheduled backup failed', 'Server process crash observed', 'Server restart required', 'Sign-in attempt failed']))
    expect(JSON.stringify(adminNotificationsResponse.json())).not.toContain('/private/fixture/path')

    const principal = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    await auth.createUser(principal, { username: 'activity-reader', displayName: 'Activity Reader', password: 'synthetic member passphrase 8P!m4Rd3', role: 'member' })
    await opened.db.insert(serverAccessGrants).values({
      serverId, userId: auth.listUsers().users.find((user) => user.username === 'activity-reader')!.id,
      viewServer: true, viewLogs: true, viewBackups: true, createdAt: at, updatedAt: at, updatedBy: principal.userId,
    }).run()
    const activitySession = await signInCreatedAccount('activity-reader', 'synthetic member passphrase 8P!m4Rd3')
    const memberCookieHeader = activitySession.cookieHeader
    const memberCsrf = activitySession.csrfToken
    const memberTemplates = await app.inject({ method: 'GET', url: '/api/v1/templates', headers: { ...requestHeaders, cookie: memberCookieHeader } })
    expect(memberTemplates.statusCode).toBe(200)
    expect(memberTemplates.json().templates).toHaveLength(1)
    const memberActivity = await app.inject({ method: 'GET', url: '/api/v1/activity?category=security', headers: { ...requestHeaders, cookie: memberCookieHeader } })
    expect(memberActivity.statusCode).toBe(200)
    expect(memberActivity.json().events).toEqual([])
    const memberNotificationsResponse = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: { ...requestHeaders, cookie: memberCookieHeader } })
    expect(memberNotificationsResponse.statusCode).toBe(200)
    expect(memberNotificationsResponse.json().items.map((item: { event: { title: string } }) => item.event.title)).toEqual(expect.arrayContaining(['Server process crash observed', 'Server restart required']))
    expect(memberNotificationsResponse.json().items.map((item: { event: { title: string } }) => item.event.title)).not.toContain('Scheduled backup failed')
    expect(JSON.stringify(memberNotificationsResponse.json())).not.toContain('Sign-in attempt failed')
    expect(JSON.stringify(memberNotificationsResponse.json())).not.toContain('/private/fixture/path')
    const memberFailure = memberNotificationsResponse.json().items.find((item: { event: { title: string } }) => item.event.title === 'Server process crash observed')
    const missingCsrf = await app.inject({ method: 'PATCH', url: `/api/v1/notifications/${encodeURIComponent(memberFailure.eventId)}/read`, headers: { ...requestHeaders, cookie: memberCookieHeader, 'content-type': 'application/json' }, payload: {} })
    expect(missingCsrf.statusCode).toBe(403)
    const memberRead = await app.inject({ method: 'PATCH', url: `/api/v1/notifications/${encodeURIComponent(memberFailure.eventId)}/read`, headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' }, payload: {} })
    expect(memberRead.statusCode).toBe(200)
    expect(memberRead.json().items.find((item: { eventId: string }) => item.eventId === memberFailure.eventId).readAt).toBeTruthy()
    const adminSecurityId = adminNotificationsResponse.json().items.find((item: { event: { title: string } }) => item.event.title === 'Sign-in attempt failed').eventId
    const deniedRead = await app.inject({ method: 'PATCH', url: `/api/v1/notifications/${encodeURIComponent(adminSecurityId)}/read`, headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' }, payload: {} })
    expect(deniedRead.statusCode).toBe(404)
    const memberMutation = await app.inject({ method: 'POST', url: '/api/v1/admin/templates', headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' }, payload: {
      name: 'Unauthorized copy', software: 'vanilla', version: '1.21.4', minMemoryMb: 1024, maxMemoryMb: 2048,
    } })
    expect(memberMutation.statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/admin/servers/${serverId}/metadata`, headers: { ...requestHeaders, cookie: memberCookieHeader, 'x-mms-csrf': memberCsrf, 'content-type': 'application/json' }, payload: { name: 'Member rename' } })).statusCode).toBe(403)
  })

  it('runs a provider-fixture install through real routes, filesystem and a fake owned process', async () => {
    const fakeServerScript = join(dataDirectory, 'fixture-server.cjs')
    const fakeJavaPath = join(dataDirectory, 'fixture-java')
    await writeFile(fakeServerScript, [
      "console.log('Starting fixture Minecraft server')",
      "console.log('Done (0.12s)! For help, type \\\"help\\\"')",
      "let pending = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', chunk => {",
      "  pending += chunk",
      "  const lines = pending.split('\\n')",
      "  pending = lines.pop() ?? ''",
      "  for (const line of lines) {",
      "    if (line === 'list') console.log('There are 2 of a max of 20 players online: Alex_123, MiraWoods')",
      "    else if (line === 'stop') { console.log('Stopping server'); setTimeout(() => process.exit(0), 20) }",
      "    else if (line.startsWith('say ')) console.log('[Server] ' + line.slice(4))",
      "  }",
      "})",
    ].join('\n'))
    await writeFile(fakeJavaPath, `#!/bin/sh\nif [ "$1" = "-version" ]; then printf 'openjdk version "21.0.0-fixture"\\n' >&2; exit 0; fi\nexec '${process.execPath}' '${fakeServerScript}'\n`)
    await chmod(fakeJavaPath, 0o700)
    availableJavaRuntimes = [{ path: fakeJavaPath, version: '21.0.0-fixture', major: 21, vendor: 'Fixture', source: 'discovered' }]
    await javaRuntimes.scan()

    const artifact = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('synthetic Paper artifact for integration coverage')])
    const sha256 = createHash('sha256').update(artifact).digest('hex')
    const artifactUrl = 'https://fill-data.papermc.io/v3/objects/fixture/paper.jar'
    const versionMetadataUrl = 'https://piston-meta.mojang.com/v1/packages/fixture/1.21.4.json'
    const fixtureFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('version_manifest_v2.json')) {
        return new Response(JSON.stringify({ versions: [{ id: '1.21.4', type: 'release', url: versionMetadataUrl }] }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === versionMetadataUrl) {
        return new Response(JSON.stringify({ javaVersion: { majorVersion: 21 } }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/projects/paper/versions/1.21.4/builds')) {
        return new Response(JSON.stringify([{
          channel: 'STABLE', id: 123,
          downloads: { 'server:default': { url: artifactUrl, size: artifact.byteLength, checksums: { sha256 } } },
        }]), { headers: { 'content-type': 'application/json' } })
      }
      if (url === artifactUrl) {
        return new Response(artifact, { headers: { 'content-type': 'application/java-archive', 'content-length': String(artifact.byteLength) } })
      }
      throw new Error(`Unexpected fixture provider request: ${url}`)
    }

    await app.close()
    processManager = new ServerProcessManager(opened.db, servers, Date.now, {
      stopTimeoutMs: 1_000, readinessTimeoutMs: 2_000, shutdownTimeoutMs: 1_000,
    }, javaRuntimes)
    app = await createApiApp({
      db: opened.db, collector, timeZone: 'Europe/Paris', auth, avatars, servers, javaRuntimes,
      processes: processManager, installFetch: fixtureFetch, webOrigin: WEB_ORIGIN, apiPort: 4174,
      now: () => Date.parse('2026-11-23T12:00:00.000Z'),
    })

    const setup = await bootstrapAdmin()
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...requestHeaders, cookie: setup.cookieHeader, 'x-mms-csrf': setup.csrfToken, 'content-type': 'application/json' }, payload: {} })
    expect(logout.statusCode).toBe(200)
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...requestHeaders, 'content-type': 'application/json' }, payload: { username: 'owner', password: ADMIN_PASSWORD } })
    expect(login.statusCode).toBe(200)
    const setCookies = login.headers['set-cookie']
    const cookieList = (Array.isArray(setCookies) ? setCookies : [setCookies]).filter((item): item is string => typeof item === 'string')
    const cookieHeader = cookieList.map((item) => item.split(';')[0]).join('; ')
    const csrfToken = cookieList.find((item) => item.startsWith('mmsmanager_csrf='))?.split(';')[0]?.split('=')[1] ?? ''
    const adminHeaders = { ...requestHeaders, cookie: cookieHeader, 'x-mms-csrf': csrfToken, 'content-type': 'application/json' }

    const portServer = createServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      portServer.once('error', rejectListen)
      portServer.listen(0, '127.0.0.1', resolveListen)
    })
    const port = (portServer.address() as { port: number }).port
    await new Promise<void>((resolveClose, rejectClose) => portServer.close((error) => error ? rejectClose(error) : resolveClose()))
    const install = await app.inject({ method: 'POST', url: '/api/v1/admin/server-installs', headers: adminHeaders, payload: {
      name: 'Fixture Paper', directoryName: 'fixture-paper', software: 'paper', version: '1.21.4', paperBuild: 123,
      javaPath: fakeJavaPath, minMemoryMb: 512, maxMemoryMb: 1024, port, eulaAccepted: true,
    } })
    expect(install.statusCode).toBe(202)
    const operationId = install.json().operation.id as string
    let operation: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await app.inject({ method: 'GET', url: `/api/v1/admin/server-installs/${operationId}`, headers: { ...requestHeaders, cookie: cookieHeader } })
      operation = current.json().operation as Record<string, unknown>
      if (operation['status'] === 'completed' || operation['status'] === 'failed') break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    expect(operation, JSON.stringify(operation)).toMatchObject({ status: 'completed', serverId: expect.any(String) })
    const serverId = operation?.['serverId'] as string
    const serverDirectory = join(dataDirectory, 'servers', 'fixture-paper')
    expect(await readFile(join(serverDirectory, 'server.jar'))).toEqual(artifact)
    expect(await readFile(join(serverDirectory, 'eula.txt'), 'utf8')).toContain('eula=true')
    expect(opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get()).toMatchObject({ source: 'created', managed: true, eula: 'accepted', javaSelectionMode: 'auto' })
    expect((await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/console/sessions`, headers: requestHeaders })).statusCode).toBe(401)

    const ownerToken = /mmsmanager_session=([^;]+)/.exec(cookieHeader)?.[1]
    const ownerPrincipal = ownerToken ? auth.authenticate(ownerToken) : null
    const memberPassword = 'synthetic lifecycle member 7M!a9Vq3'
    const lifecycleMember = await auth.createUser(ownerPrincipal!, { username: 'lifecycle-member', displayName: 'Lifecycle Member', password: memberPassword, role: 'member' })
    const lifecycleMemberSession = await signInCreatedAccount('lifecycle-member', memberPassword)
    const lifecycleMemberCookie = lifecycleMemberSession.cookieHeader
    const lifecycleMemberCsrf = lifecycleMemberSession.csrfToken
    const lifecycleMemberHeaders = { ...requestHeaders, cookie: lifecycleMemberCookie, 'x-mms-csrf': lifecycleMemberCsrf, 'content-type': 'application/json' }
    const lifecyclePermissions = (grant: Partial<import('@mmsmanager/shared').ServerAccessPermissions>) => ({
      viewServer: true, viewLogs: false, sendConsoleCommands: false, controlLifecycle: false,
      startServer: false, stopServer: false, restartServer: false, viewPlayers: false, moderatePlayers: false,
      viewMods: false, manageMods: false, viewFiles: false, manageFiles: false, viewSettings: false, manageSettings: false,
      viewWorlds: false, viewBackups: false, createBackups: false, ...grant,
    })
    const saveLifecyclePermissions = (permissions: ReturnType<typeof lifecyclePermissions>) => app.inject({
      method: 'PUT', url: `/api/v1/admin/servers/${serverId}/access`, headers: adminHeaders,
      payload: { userId: lifecycleMember.id, permissions },
    })
    const readLifecycleRuntime = async (expected: 'running' | 'stopped') => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/runtime`, headers: { ...requestHeaders, cookie: lifecycleMemberCookie } })
        const runtime = response.json().runtime as { status: string }
        if (runtime.status === expected) return runtime
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
      }
      throw new Error(`Fake server did not reach ${expected}.`)
    }

    expect((await saveLifecyclePermissions(lifecyclePermissions({ startServer: true }))).statusCode).toBe(200)
    const memberStart = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/start`, headers: lifecycleMemberHeaders, payload: {} })
    expect(memberStart.statusCode, memberStart.body).toBe(202)
    expect(await readLifecycleRuntime('running')).toMatchObject({ status: 'running' })
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/stop`, headers: lifecycleMemberHeaders, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/restart`, headers: lifecycleMemberHeaders, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/stop`, headers: adminHeaders, payload: {} })).statusCode).toBe(200)
    await readLifecycleRuntime('stopped')

    expect((await saveLifecyclePermissions(lifecyclePermissions({ stopServer: true }))).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/start`, headers: adminHeaders, payload: {} })).statusCode).toBe(202)
    await readLifecycleRuntime('running')
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/start`, headers: lifecycleMemberHeaders, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/restart`, headers: lifecycleMemberHeaders, payload: {} })).statusCode).toBe(403)
    const memberStop = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/stop`, headers: lifecycleMemberHeaders, payload: {} })
    expect(memberStop.statusCode, memberStop.body).toBe(200)
    await readLifecycleRuntime('stopped')

    expect((await saveLifecyclePermissions(lifecyclePermissions({ restartServer: true }))).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/start`, headers: adminHeaders, payload: {} })).statusCode).toBe(202)
    await readLifecycleRuntime('running')
    const memberRestart = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/restart`, headers: lifecycleMemberHeaders, payload: {} })
    expect(memberRestart.statusCode, memberRestart.body).toBe(200)
    expect(memberRestart.json().runtime).toMatchObject({ status: 'running', ready: true })
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/start`, headers: lifecycleMemberHeaders, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/stop`, headers: lifecycleMemberHeaders, payload: {} })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/stop`, headers: adminHeaders, payload: {} })).statusCode).toBe(200)
    await readLifecycleRuntime('stopped')

    const started = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/start`, headers: adminHeaders, payload: {} })
    expect(started.statusCode).toBe(202)
    let runtime: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/runtime`, headers: { ...requestHeaders, cookie: cookieHeader } })
      runtime = current.json().runtime as Record<string, unknown>
      if (runtime['status'] === 'running' || runtime['status'] === 'failed') break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    expect(runtime).toMatchObject({ status: 'running', ready: true })
    const firstSessionsResponse = await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/console/sessions`, headers: { ...requestHeaders, cookie: cookieHeader } })
    expect(firstSessionsResponse.statusCode).toBe(200)
    const firstSession = firstSessionsResponse.json().sessions[0] as { id: string; outcome: string; live: boolean }
    expect(firstSession).toMatchObject({ id: expect.any(String), outcome: 'running', live: true })
    const scopedConsole = await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/console?sessionId=${firstSession.id}&after=0`, headers: { ...requestHeaders, cookie: cookieHeader } })
    expect(scopedConsole.json()).toMatchObject({ sessionId: firstSession.id, entries: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('Done') })]) })
    const players = await app.inject({ method: 'GET', url: `/api/v1/admin/servers/${serverId}/players`, headers: { ...requestHeaders, cookie: cookieHeader } })
    expect(players.json().players).toMatchObject({ state: 'authoritative', names: ['Alex_123', 'MiraWoods'] })
    const command = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/console`, headers: adminHeaders, payload: { command: 'say integration fixture' } })
    expect(command.statusCode).toBe(202)
    let consoleText = ''
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/console`, headers: { ...requestHeaders, cookie: cookieHeader } })
      consoleText = JSON.stringify(current.json())
      if (consoleText.includes('integration fixture')) break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    expect(consoleText).toContain('integration fixture')

    const restarted = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/restart`, headers: adminHeaders, payload: {} })
    expect(restarted.statusCode).toBe(200)
    expect(restarted.json().runtime).toMatchObject({ status: 'running', ready: true })
    const restartedSessions = (await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/console/sessions`, headers: { ...requestHeaders, cookie: cookieHeader } })).json().sessions as Array<{ id: string; outcome: string; live: boolean }>
    expect(restartedSessions, JSON.stringify(restartedSessions)).toHaveLength(6)
    expect(restartedSessions[0]).toMatchObject({ outcome: 'running', live: true })
    expect(restartedSessions[0]?.id).not.toBe(firstSession.id)
    expect(restartedSessions.find((session) => session.id === firstSession.id)).toMatchObject({ outcome: 'stopped', live: false })
    const stopped = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/stop`, headers: adminHeaders, payload: {} })
    expect(stopped.statusCode).toBe(200)
    runtime = undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/runtime`, headers: { ...requestHeaders, cookie: cookieHeader } })
      runtime = current.json().runtime as Record<string, unknown>
      if (runtime['status'] === 'stopped' || runtime['status'] === 'crashed') break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    }
    expect(runtime).toMatchObject({ status: 'stopped' })
    const endedSessions = (await app.inject({ method: 'GET', url: `/api/v1/servers/${serverId}/console/sessions`, headers: { ...requestHeaders, cookie: cookieHeader } })).json().sessions as Array<{ outcome: string; live: boolean }>
    expect(endedSessions.every((session) => !session.live)).toBe(true)
    expect(endedSessions[0]).toMatchObject({ outcome: 'stopped', live: false })
    const activity = await app.inject({ method: 'GET', url: '/api/v1/activity?limit=100', headers: { ...requestHeaders, cookie: cookieHeader } })
    expect(activity.statusCode).toBe(200)
    expect(activity.json().events.some((item: { title?: string }) => item.title === 'Server readiness observed')).toBe(true)
  }, 20_000)

  it('previews ZIP64 and flat archives, requires import trust choices, and publishes exact safe bytes', async () => {
    const admin = await bootstrapAdmin()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }
    await javaRuntimes.scan()
    const serverJar = Buffer.from('synthetic server JAR bytes')
    const worldData = Buffer.from([0, 1, 2, 255, 10, 13])
    const archive = storedZip([
      { path: 'bundle/server-1.20.4.jar', bytes: serverJar },
      { path: 'bundle/server.properties', bytes: Buffer.from('# server-port=24444\nserver-port : 25569\nserver-port=25570\nmotd=ZIP fixture\n') },
      { path: 'bundle/eula.txt', bytes: Buffer.from('eula=false\n') },
      { path: 'bundle/world/level.dat', bytes: worldData },
    ], true)
    const boundary = 'mms-zip64-fixture'
    const upload = await app.inject({
      method: 'POST', url: '/api/v1/admin/server-imports/zip',
      headers: { ...adminHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartArchive(boundary, 'survival-world.zip', archive),
    })
    expect(upload.statusCode, upload.body).toBe(201)
    const preview = upload.json().preview as Record<string, unknown>
    expect(preview).toMatchObject({
      uploadName: 'survival-world.zip', rootFolder: 'bundle', software: 'vanilla', version: '1.20.4',
      requiredJavaMajor: 17, jarName: 'server-1.20.4.jar', port: 25570, eula: 'not-accepted',
      worldFolders: ['world'], supported: true,
    })
    const publish = await app.inject({
      method: 'POST', url: `/api/v1/admin/server-imports/${String(preview['token'])}/publish`, headers: adminHeaders,
      payload: {
        name: 'ZIP fixture world', javaPath: '/test/java-21/bin/java', minMemoryMb: 1024, maxMemoryMb: 4096,
        acceptEula: false, trustExecutable: true, startAfterImport: false,
      },
    })
    expect(publish.statusCode, publish.body).toBe(201)
    expect(publish.json()).toMatchObject({ importState: 'published', started: false, startError: null, server: { name: 'ZIP fixture world', source: 'created', managed: true, javaMajor: 21, eula: 'not-accepted' } })
    expect(publish.json().server).toMatchObject({ port: 25570, portStatus: 'valid', portErrorCode: null })
    const serverId = publish.json().server.id as string
    const row = await opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get()
    expect(row).toMatchObject({ javaSelectionMode: 'auto', javaMajor: 21, requiredJavaMajor: 17 })
    expect(await readFile(join(row!.directory, 'server-1.20.4.jar'))).toEqual(serverJar)
    expect(await readFile(join(row!.directory, 'world', 'level.dat'))).toEqual(worldData)
    expect(await readFile(join(row!.directory, 'server.properties'), 'utf8')).toContain('server-port=25570')
    expect(await readFile(join(row!.directory, 'eula.txt'), 'utf8')).toContain('eula=false')
    const repeated = await app.inject({
      method: 'POST', url: `/api/v1/admin/server-imports/${String(preview['token'])}/publish`, headers: adminHeaders,
      payload: { name: 'second use', javaPath: '/test/java-21/bin/java', minMemoryMb: 1024, maxMemoryMb: 4096, acceptEula: true, trustExecutable: true, startAfterImport: false },
    })
    expect(repeated.statusCode).toBe(409)
  }, 20_000)

  it('rejects unsafe and colliding ZIP paths and keeps destructive server removal explicit and journaled', async () => {
    const admin = await bootstrapAdmin()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }
    const missingCsrf = await app.inject({
      method: 'POST', url: '/api/v1/admin/server-imports/zip',
      headers: { ...requestHeaders, cookie: admin.cookieHeader, 'content-type': 'multipart/form-data; boundary=no-csrf' },
      payload: multipartArchive('no-csrf', 'unsafe.zip', storedZip([{ path: '../escape.txt', bytes: Buffer.from('no') }])),
    })
    expect(missingCsrf.statusCode).toBe(403)
    for (const [filename, bytes, expectedStatus] of [
      ['traversal.zip', storedZip([{ path: '../escape.txt', bytes: Buffer.from('no') }]), 400],
      ['collision.zip', storedZip([{ path: 'Mods/A.jar', bytes: Buffer.from('a') }, { path: 'mods/a.jar', bytes: Buffer.from('b') }]), 409],
    ] as const) {
      const boundary = `mms-${filename}`
      const response = await app.inject({ method: 'POST', url: '/api/v1/admin/server-imports/zip', headers: { ...adminHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipartArchive(boundary, filename, bytes) })
      expect(response.statusCode).toBe(expectedStatus)
    }

    const principal = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    const at = '2026-11-23T12:00:00.000Z'
    const managedId = randomUUID()
    const managedDirectory = join(servers.managedRoot, 'remove-fixture')
    await mkdir(managedDirectory, { recursive: true })
    await writeFile(join(managedDirectory, 'world.txt'), 'isolated disposable fixture')
    await opened.db.insert(localServers).values({
      id: managedId, name: 'Delete fixture', directory: managedDirectory, source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar',
      javaPath: '/test/java-21/bin/java', javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: null,
      eula: 'accepted', managed: true, worldFolders: '[]', createdBy: principal.userId, createdAt: at, updatedAt: at,
    }).run()
    await opened.db.insert(localServerEvents).values({ serverId: managedId, actorUserId: principal.userId, action: 'history-fixture', outcome: 'success', occurredAt: at, detail: 'kept by tombstone' }).run()
    const wrongName = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${managedId}/remove`, headers: adminHeaders, payload: { mode: 'permanent', confirmation: 'Delete fixture typo' } })
    expect(wrongName.statusCode).toBe(400)
    expect(await readFile(join(managedDirectory, 'world.txt'), 'utf8')).toBe('isolated disposable fixture')
    const staleProcess = { serverId: managedId, pid: 65530, processStartMarker: 'stale', processBootId: 'stale', status: 'running' as const, startedAt: at, stoppedAt: null, lastExitCode: null, errorMessage: null, updatedAt: at }
    await opened.db.insert(localServerRuntime).values(staleProcess).run()
    const running = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${managedId}/remove`, headers: adminHeaders, payload: { mode: 'permanent', confirmation: 'Delete fixture' } })
    expect(running.statusCode).toBe(409)
    await opened.db.update(localServerRuntime).set({ status: 'stopped', processPid: null, processStartMarker: null, processBootId: null }).where(eq(localServerRuntime.serverId, managedId)).run()
    const deletion = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${managedId}/remove`, headers: adminHeaders, payload: { mode: 'permanent', confirmation: 'Delete fixture' } })
    expect(deletion.statusCode, deletion.body).toBe(200)
    expect(deletion.json().operation).toMatchObject({ state: 'purged', mode: 'permanent', serverName: 'Delete fixture' })
    await expect(readFile(managedDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await opened.db.select().from(localServers).where(eq(localServers.id, managedId)).get()).toMatchObject({ removedAt: at })
    expect(await opened.db.select().from(localServerEvents).where(eq(localServerEvents.serverId, managedId)).all()).toHaveLength(3)
    expect((await app.inject({ method: 'GET', url: '/api/v1/servers', headers: { ...requestHeaders, cookie: admin.cookieHeader } })).json().servers).toEqual([])
    const removalList = await app.inject({ method: 'GET', url: '/api/v1/admin/server-removals', headers: { ...requestHeaders, cookie: admin.cookieHeader } })
    expect(removalList.statusCode).toBe(200)
    expect(removalList.json().operations).toContainEqual(expect.objectContaining({ serverId: managedId, state: 'purged' }))

    const importedId = randomUUID()
    const externalDirectory = join(dataDirectory, 'imported-outside-root')
    await mkdir(externalDirectory, { recursive: true })
    await writeFile(join(externalDirectory, 'keep.txt'), 'external data remains')
    await opened.db.insert(localServers).values({
      id: importedId, name: 'Imported outside fixture', directory: externalDirectory, source: 'imported', software: 'unknown', version: null, jarName: null,
      javaPath: null, javaMajor: null, requiredJavaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024, port: null,
      eula: 'unknown', managed: false, worldFolders: '[]', createdBy: null, createdAt: at, updatedAt: at,
    }).run()
    const prohibited = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${importedId}/remove`, headers: adminHeaders, payload: { mode: 'permanent', confirmation: 'Imported outside fixture' } })
    expect(prohibited.statusCode).toBe(409)
    const unregister = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${importedId}/remove`, headers: adminHeaders, payload: { mode: 'unregister', confirmation: 'Imported outside fixture' } })
    expect(unregister.statusCode, unregister.body).toBe(200)
    expect(unregister.json().operation).toMatchObject({ state: 'unregistered', mode: 'unregister' })
    expect(await readFile(join(externalDirectory, 'keep.txt'), 'utf8')).toBe('external data remains')
  })

  it('restores an unregistered server record without changing its folder, history, identity, or stopped state', async () => {
    const admin = await bootstrapAdmin()
    const adminHeaders = { ...requestHeaders, cookie: admin.cookieHeader, 'x-mms-csrf': admin.csrfToken, 'content-type': 'application/json' }
    const owner = auth.authenticate(admin.cookieHeader.match(/mmsmanager_session=([^;]+)/)?.[1] ?? '')!
    const at = '2026-11-23T12:00:00.000Z'
    const serverId = randomUUID()
    const directory = join(servers.managedRoot, 'retained-server-fixture')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'server.properties'), 'level-name=kept-world\n')
    await writeFile(join(directory, 'world.bin'), 'untouched world bytes')
    await opened.db.insert(localServers).values({
      id: serverId, name: 'Retained Fixture', directory, source: 'created', software: 'paper', version: '1.21.4', jarName: 'server.jar',
      javaPath: '/fixture/java', javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: 25565,
      eula: 'accepted', managed: true, worldFolders: '["kept-world"]', createdBy: owner.userId, createdAt: at, updatedAt: at,
    }).run()
    await opened.db.insert(localServerRuntime).values({
      serverId, status: 'stopped', processPid: null, processStartMarker: null, processBootId: null,
      startedAt: null, updatedAt: at, lastExitCode: null, errorMessage: null, restartRequired: true,
    }).run()
    await opened.db.insert(localServerEvents).values({ serverId, actorUserId: owner.userId, action: 'retained-history-fixture', outcome: 'success', occurredAt: at, detail: 'preserve history' }).run()
    const unregister = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/remove`, headers: adminHeaders, payload: { mode: 'unregister', confirmation: 'Retained Fixture' } })
    expect(unregister.statusCode, unregister.body).toBe(200)
    const listUrl = '/api/v1/admin/servers/unregistered'
    const listed = await app.inject({ method: 'GET', url: listUrl, headers: adminHeaders })
    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json().servers).toContainEqual(expect.objectContaining({ id: serverId, name: 'Retained Fixture', version: '1.21.4', folderAvailable: true }))

    const memberPassword = 'synthetic registration restore member 4H!u2Jp7'
    await auth.createUser(owner, { username: 'restore-list-member', displayName: 'Restore List Member', password: memberPassword, role: 'member' })
    const member = await signInCreatedAccount('restore-list-member', memberPassword)
    expect((await app.inject({ method: 'GET', url: listUrl, headers: member.headers })).statusCode).toBe(403)
    expect((await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/restore-registration`, headers: member.headers, payload: {} })).statusCode).toBe(403)

    const conflictId = randomUUID()
    await opened.db.insert(localServers).values({
      id: conflictId, name: 'Conflicting Fixture', directory, source: 'imported', software: 'unknown', version: null, jarName: null,
      javaPath: null, javaMajor: null, requiredJavaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024, port: null,
      eula: 'unknown', managed: false, worldFolders: '[]', createdBy: null, createdAt: at, updatedAt: at,
    }).run()
    const conflicted = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/restore-registration`, headers: adminHeaders, payload: {} })
    expect(conflicted.statusCode).toBe(409)
    expect(conflicted.json()).toMatchObject({ error: { code: 'SERVER_RESTORE_CONFLICT' } })
    expect((await opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get())?.removedAt).not.toBeNull()
    await opened.db.delete(localServers).where(eq(localServers.id, conflictId)).run()

    const restored = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${serverId}/restore-registration`, headers: adminHeaders, payload: {} })
    expect(restored.statusCode, restored.body).toBe(200)
    expect(restored.json()).toEqual({ ok: true, serverId })
    expect(await opened.db.select().from(localServers).where(eq(localServers.id, serverId)).get()).toMatchObject({ id: serverId, name: 'Retained Fixture', version: '1.21.4', removedAt: null })
    expect(await opened.db.select().from(localServerRuntime).where(eq(localServerRuntime.serverId, serverId)).get()?.status).toBe('stopped')
    const restoredEvents = await opened.db.select().from(localServerEvents).where(eq(localServerEvents.serverId, serverId)).all()
    expect(restoredEvents).toHaveLength(3)
    expect(restoredEvents.map((event) => event.action)).toEqual(expect.arrayContaining(['retained-history-fixture', 'server-unregistered', 'server-unregistered-restored']))
    expect(await readFile(join(directory, 'world.bin'), 'utf8')).toBe('untouched world bytes')
    expect((await app.inject({ method: 'GET', url: '/api/v1/servers', headers: adminHeaders })).json().servers).toContainEqual(expect.objectContaining({ id: serverId, name: 'Retained Fixture' }))
    expect((await app.inject({ method: 'GET', url: listUrl, headers: adminHeaders })).json().servers).not.toContainEqual(expect.objectContaining({ id: serverId }))

    const permanentId = randomUUID()
    const permanentDirectory = join(servers.managedRoot, 'permanently-removed-fixture')
    await opened.db.insert(localServers).values({
      id: permanentId, name: 'Permanently removed fixture', directory: permanentDirectory, source: 'created', software: 'paper', version: '1.21.4', jarName: 'server.jar',
      javaPath: '/fixture/java', javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 512, maxMemoryMb: 1024, port: 25566,
      eula: 'accepted', managed: true, worldFolders: '[]', createdBy: owner.userId, createdAt: at, updatedAt: at, removedAt: at,
    }).run()
    await opened.db.insert(localServerRuntime).values({
      serverId: permanentId, status: 'stopped', processPid: null, processStartMarker: null, processBootId: null,
      startedAt: null, updatedAt: at, lastExitCode: null, errorMessage: null, restartRequired: false,
    }).run()
    await opened.db.insert(localServerRemovalOperations).values({
      id: randomUUID(), serverId: permanentId, mode: 'permanent', state: 'purged', actorUserId: owner.userId,
      serverName: 'Permanently removed fixture', directory: permanentDirectory, source: 'created', errorCode: null,
      errorMessage: null, createdAt: at, updatedAt: at,
    }).run()
    expect((await app.inject({ method: 'GET', url: listUrl, headers: adminHeaders })).json().servers).not.toContainEqual(expect.objectContaining({ id: permanentId }))
    const permanentRestore = await app.inject({ method: 'POST', url: `/api/v1/admin/servers/${permanentId}/restore-registration`, headers: adminHeaders, payload: {} })
    expect(permanentRestore.statusCode).toBe(409)
    expect(permanentRestore.json()).toMatchObject({ error: { code: 'SERVER_NOT_UNREGISTERED' } })
  })

})
