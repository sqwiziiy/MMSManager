import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOptions } from '@node-rs/argon2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client.js'
import { AuthFailure, AuthService } from './service.js'
import { hashPassword, verifyPassword } from './password.js'

const PASSWORD = 'sample administrator passphrase 45!long'
let opened: Awaited<ReturnType<typeof openDatabase>>
let auth: AuthService
let dataDirectory: string
let clock = Date.parse('2026-11-23T12:00:00.000Z')

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'mmsmanager-auth-'))
  opened = await openDatabase({ path: join(dataDirectory, 'mmsmanager.sqlite') })
  clock = Date.parse('2026-11-23T12:00:00.000Z')
  auth = new AuthService(opened.native, dataDirectory, () => clock)
  await auth.prepare()
})

afterEach(async () => {
  opened.native.close()
  await rm(dataDirectory, { recursive: true, force: true })
})

async function bootstrap(username = 'owner') {
  const token = (await readFile(auth.bootstrapPath, 'utf8')).trim()
  const session = await auth.bootstrap({ token, username, displayName: 'Local Owner', password: PASSWORD })
  const principal = auth.authenticate(session.sessionToken)
  if (!principal) throw new Error('Synthetic test session failed to authenticate')
  return { session, principal }
}

describe('Argon2id authentication and bootstrap', () => {
  it('uses independent Argon2id v=19 salts and OWASP-aligned parameters', async () => {
    const first = await hashPassword(PASSWORD)
    const second = await hashPassword(PASSWORD)
    expect(first).not.toBe(second)
    expect(first.startsWith('$argon2id$v=19$')).toBe(true)
    expect(parseOptions(first)).toMatchObject({ algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32, saltLen: 16 })
    expect(await verifyPassword(first, PASSWORD)).toBe(true)
    expect(await verifyPassword(first, 'a different synthetic passphrase')).toBe(false)
  })

  it('creates a private expiring bootstrap file and rotates it after expiry', async () => {
    const file = await stat(auth.bootstrapPath)
    const directory = await stat(dataDirectory)
    expect(file.mode & 0o777).toBe(0o600)
    expect(directory.mode & 0o777).toBe(0o700)
    const first = (await readFile(auth.bootstrapPath, 'utf8')).trim()
    expect(first).toMatch(/^[A-Za-z0-9_-]{40,80}$/)
    await expect(auth.bootstrap({ token: 'wrong-token-value-that-is-not-valid-0000000000', username: 'owner', displayName: 'Owner', password: PASSWORD })).rejects.toBeInstanceOf(AuthFailure)

    clock += 31 * 60 * 1000
    await auth.prepare()
    const rotated = (await readFile(auth.bootstrapPath, 'utf8')).trim()
    expect(rotated).not.toBe(first)
    await expect(auth.bootstrap({ token: first, username: 'old', displayName: 'Old', password: PASSWORD })).rejects.toBeInstanceOf(AuthFailure)
  })

  it('serializes concurrent first-admin claims and consumes the credential once', async () => {
    const token = (await readFile(auth.bootstrapPath, 'utf8')).trim()
    const attempts = await Promise.allSettled([
      auth.bootstrap({ token, username: 'first-admin', displayName: 'First Admin', password: PASSWORD }),
      auth.bootstrap({ token, username: 'second-admin', displayName: 'Second Admin', password: PASSWORD }),
    ])
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(opened.native.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })
    expect(opened.native.prepare("SELECT count(*) AS count FROM users WHERE enabled = 1 AND role = 'administrator'").get()).toEqual({ count: 1 })
    expect(opened.native.prepare('SELECT bootstrap_hash AS token FROM auth_state WHERE id = 1').get()).toEqual({ token: null })
    await expect(readFile(auth.bootstrapPath, 'utf8')).rejects.toThrow()
  })

  it('stores only hashed session identifiers and supports login, logout, password change and expiry', async () => {
    const { session, principal } = await bootstrap()
    const sessionRow = opened.native.prepare('SELECT token_hash AS tokenHash, csrf_hash AS csrfHash FROM sessions WHERE user_id = ?').get(principal.userId) as { tokenHash: string; csrfHash: string }
    expect(sessionRow.tokenHash).toBe(createHash('sha256').update(session.sessionToken).digest('hex'))
    expect(sessionRow.tokenHash).not.toContain(session.sessionToken)
    expect(sessionRow.csrfHash).toBe(createHash('sha256').update(session.csrfToken).digest('hex'))
    expect(auth.authenticate(session.sessionToken)?.role).toBe('administrator')
    expect(auth.authenticate(session.sessionToken)?.mustChangePassword).toBe(false)

    await expect(auth.login('owner', 'incorrect synthetic phrase')).rejects.toMatchObject({ code: 'unauthorized' })
    const loggedIn = await auth.login('OWNER', PASSWORD)
    const loggedPrincipal = auth.authenticate(loggedIn.sessionToken)
    expect(loggedPrincipal?.userId).toBe(principal.userId)
    auth.logout(loggedPrincipal!)
    expect(auth.authenticate(loggedIn.sessionToken)).toBeNull()

    const fresh = await auth.login('owner', PASSWORD)
    const freshPrincipal = auth.authenticate(fresh.sessionToken)!
    await auth.changePassword(freshPrincipal, PASSWORD, 'a new synthetic passphrase 46?strong')
    expect(auth.authenticate(fresh.sessionToken)).toBeNull()
    await expect(auth.login('owner', PASSWORD)).rejects.toMatchObject({ code: 'unauthorized' })
    expect((await auth.login('owner', 'a new synthetic passphrase 46?strong')).sessionToken).toBeTruthy()

    const afterBootstrap = auth.authenticate(session.sessionToken)
    expect(afterBootstrap).toBeNull()
    const later = await auth.login('owner', 'a new synthetic passphrase 46?strong')
    clock += 8 * 24 * 60 * 60 * 1000
    expect(auth.authenticate(later.sessionToken)).toBeNull()
  })

  it('requires both created roles and administrator resets to change temporary passwords', async () => {
    const { principal: administrator } = await bootstrap()
    const memberPassword = 'temporary member credential 47!strong'
    const adminPassword = 'temporary admin credential 48!strong'
    const member = await auth.createUser(administrator, { username: 'temporary-member', displayName: 'Temporary Member', password: memberPassword, role: 'member' })
    const createdAdmin = await auth.createUser(administrator, { username: 'temporary-admin', displayName: 'Temporary Admin', password: adminPassword, role: 'administrator' })
    expect(member.mustChangePassword).toBe(true)
    expect(createdAdmin.mustChangePassword).toBe(true)
    expect(opened.native.prepare('SELECT password_hash AS passwordHash FROM users WHERE id = ?').get(member.id)).not.toMatchObject({ passwordHash: memberPassword })

    const login = await auth.login('temporary-member', memberPassword)
    const restricted = auth.authenticate(login.sessionToken)!
    expect(restricted.mustChangePassword).toBe(true)
    const storedSession = opened.native.prepare('SELECT expires_at AS expiresAt FROM sessions WHERE token_hash = ?').get(restricted.tokenHash) as { expiresAt: string }
    expect(Date.parse(storedSession.expiresAt) - clock).toBe(15 * 60 * 1000)
    await expect(auth.changePassword(restricted, 'incorrect temporary credential', 'a replacement credential 49!strong')).rejects.toMatchObject({ code: 'current-password' })
    await expect(auth.changePassword(restricted, memberPassword, memberPassword)).rejects.toMatchObject({ code: 'same-password' })
    const rotated = await auth.changePassword(restricted, memberPassword, 'a replacement credential 49!strong')
    expect(rotated).toMatchObject({ sessionToken: expect.any(String), csrfToken: expect.any(String) })
    expect(auth.authenticate(login.sessionToken)).toBeNull()
    const normal = auth.authenticate(rotated!.sessionToken)!
    expect(normal.mustChangePassword).toBe(false)
    expect(Date.parse((opened.native.prepare('SELECT expires_at AS expiresAt FROM sessions WHERE token_hash = ?').get(normal.tokenHash) as { expiresAt: string }).expiresAt) - clock).toBe(7 * 24 * 60 * 60 * 1000)

    const prior = await auth.login('temporary-admin', adminPassword)
    const priorPrincipal = auth.authenticate(prior.sessionToken)!
    await auth.resetUserPassword(administrator, createdAdmin.id, 'temporary reset credential 50!strong')
    expect(auth.authenticate(prior.sessionToken)).toBeNull()
    const resetLogin = await auth.login('temporary-admin', 'temporary reset credential 50!strong')
    expect(auth.authenticate(resetLogin.sessionToken)?.mustChangePassword).toBe(true)
    expect(auth.authenticate(priorPrincipal.tokenHash)).toBeNull()

    await auth.recoverAdministrator('owner', 'temporary recovery credential 51!strong')
    expect(auth.authenticate(administrator.tokenHash)).toBeNull()
    const recoveredLogin = await auth.login('owner', 'temporary recovery credential 51!strong')
    expect(auth.authenticate(recoveredLogin.sessionToken)?.mustChangePassword).toBe(true)
    const audit = opened.native.prepare('SELECT action, outcome FROM security_audit_events ORDER BY id').all() as Array<{ action: string; outcome: string }>
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining(['user.created', 'user.password.reset', 'admin.recovered']))
    expect(JSON.stringify(audit)).not.toContain('temporary reset credential')
    expect(JSON.stringify(audit)).not.toContain('temporary recovery credential')
  })

  it('persists language and appearance per account while partial navigation updates preserve them', async () => {
    const { principal } = await bootstrap()
    auth.updateUserPreferences(principal, { language: 'ru', theme: 'light', accent: 'blue', density: 'compact', reducedMotion: true })
    expect(auth.getMe(principal).user.preferences).toMatchObject({ language: 'ru', theme: 'light', accent: 'blue', density: 'compact', reducedMotion: true })

    auth.updateUserPreferences(principal, { compactNavigation: true, defaultLanding: 'machine' })
    expect(auth.getMe(principal).user.preferences).toEqual({
      compactNavigation: true, defaultLanding: 'machine', language: 'ru', theme: 'light', accent: 'blue', density: 'compact', reducedMotion: true,
    })
    expect(opened.native.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok')
  })
})

describe('additive Stage 2 database migration', () => {
  it('preserves sample, rollup and event rows in a Stage 2 schema fixture through migration and restart', async () => {
    const legacyDirectory = join(dataDirectory, 'stage2-migrations')
    const metadataDirectory = join(legacyDirectory, 'meta')
    await mkdir(metadataDirectory, { recursive: true, mode: 0o700 })
    const stage2Migration = fileURLToPath(new URL('../../drizzle/0000_stage_02_machine_history.sql', import.meta.url))
    await copyFile(stage2Migration, join(legacyDirectory, '0000_stage_02_machine_history.sql'))
    await writeFile(join(metadataDirectory, '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite', entries: [{ idx: 0, version: '6', when: 1795432805424, tag: '0000_stage_02_machine_history', breakpoints: true }],
    }), { mode: 0o600 })

    const databasePath = join(dataDirectory, 'legacy.sqlite')
    const legacy = await openDatabase({ path: databasePath, migrationsFolder: legacyDirectory })
    const time = '2026-11-23T12:00:00.000Z'
    legacy.native.prepare('INSERT INTO machines (id, hostname, platform, architecture, source, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('local', 'fixture-host', 'linux', 'x64', 'systeminformation', time, time)
    legacy.native.prepare(`INSERT INTO machine_samples (machine_id, collected_at, minute_start, local_date, time_zone, cpu_percent, sample_status, unavailable_fields, source)
      VALUES ('local', ?, '2026-11-23T12:00:00.000Z', '2026-11-23', 'Europe/Paris', 25.5, 'ok', '[]', 'systeminformation')`).run(time)
    legacy.native.prepare(`INSERT INTO machine_minute_rollups (machine_id, time_zone, local_date, minute_start, sample_count, cpu_sum, cpu_count, network_rate_count, first_sample_at, last_sample_at)
      VALUES ('local', 'Europe/Paris', '2026-11-23', '2026-11-23T12:00:00.000Z', 1, 25.5, 1, 0, ?, ?)`).run(time, time)
    legacy.native.prepare(`INSERT INTO machine_day_rollups (machine_id, time_zone, local_date, sample_count, cpu_sum, cpu_count, first_sample_at, last_sample_at)
      VALUES ('local', 'Europe/Paris', '2026-11-23', 1, 25.5, 1, ?, ?)`).run(time, time)
    legacy.native.prepare(`INSERT INTO machine_events (machine_id, occurred_at, time_zone, local_date, category, severity, message, source)
      VALUES ('local', ?, 'Europe/Paris', '2026-11-23', 'sample', 'info', 'Fixture sample saved', 'local-backend')`).run(time)
    const before = Object.fromEntries(['machine_samples', 'machine_minute_rollups', 'machine_day_rollups', 'machine_events'].map((table) => [table, (legacy.native.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count]))
    legacy.native.close()

    let migrated = await openDatabase({ path: databasePath })
    expect(Object.fromEntries(Object.keys(before).map((table) => [table, (migrated.native.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count]))).toEqual(before)
    expect(migrated.native.prepare('SELECT cpu_percent AS cpu FROM machine_samples WHERE machine_id = ?').get('local')).toEqual({ cpu: 25.5 })
    const migratedAuth = new AuthService(migrated.native, dataDirectory, () => clock)
    await migratedAuth.prepare()
    expect(migratedAuth.getSetupRequired()).toBe(true)
    migrated.native.close()

    migrated = await openDatabase({ path: databasePath })
    expect((migrated.native.prepare('SELECT message FROM machine_events WHERE machine_id = ?').get('local') as { message: string }).message).toBe('Fixture sample saved')
    expect(migrated.native.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('users','sessions','security_audit_events')").get()).toEqual({ count: 3 })
    const databaseMode = await stat(databasePath)
    const stateMode = await stat(dataDirectory)
    expect(databaseMode.mode & 0o777).toBe(0o600)
    expect(stateMode.mode & 0o777).toBe(0o700)
    migrated.native.close()
  })
})
