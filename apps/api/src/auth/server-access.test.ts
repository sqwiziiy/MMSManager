import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { ServerAccessPermissions } from '@mmsmanager/shared'
import type { SessionPrincipal } from './service.js'
import { openDatabase } from '../db/client.js'
import { auditEvents, localServerEvents, localServers, users } from '../db/schema.js'
import { ServerAccessService } from './server-access.js'

describe('per-server access grants', () => {
  let directory: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  const now = () => Date.parse('2026-11-25T10:00:00.000Z')
  const at = '2026-11-25T10:00:00.000Z'
  const ids = { admin: randomUUID(), member: randomUUID(), one: randomUUID(), two: randomUUID() }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-access-'))
    opened = await openDatabase({ path: join(directory, 'state.sqlite') })
    await opened.db.insert(users).values([
      { id: ids.admin, username: 'owner', usernameKey: 'owner', displayName: 'Owner', role: 'administrator', passwordHash: 'fixture-admin-hash', createdAt: at, updatedAt: at, passwordChangedAt: at },
      { id: ids.member, username: 'member', usernameKey: 'member', displayName: 'Member', role: 'member', passwordHash: 'fixture-member-hash', createdAt: at, updatedAt: at, passwordChangedAt: at },
    ])
    await opened.db.insert(localServers).values([ids.one, ids.two].map((id) => ({
      id, name: id === ids.one ? 'One' : 'Two', directory: `/fixture/${id}`, source: 'created' as const, software: 'vanilla' as const,
      version: '1.21.4', jarName: 'server.jar', javaPath: '/fixture/java', javaMajor: 21, requiredJavaMajor: 21,
      minMemoryMb: 512, maxMemoryMb: 1024, eula: 'accepted' as const, managed: true, worldFolders: '[]',
      createdBy: ids.admin, createdAt: at, updatedAt: at,
    })))
  })

  afterEach(async () => {
    opened.native.close()
    await rm(directory, { recursive: true, force: true })
  })

  const principal = (userId: string, role: 'administrator' | 'member') => ({
    userId, username: role === 'administrator' ? 'owner' : 'member', displayName: role === 'administrator' ? 'Owner' : 'Member',
    role, enabled: true, avatarKey: null, tokenHash: `session-${userId}`, csrfHash: 'csrf',
    createdAt: at, lastLoginAt: null, compactNavigation: false, defaultLanding: 'dashboard',
  }) as SessionPrincipal

  const fullSet = (): ServerAccessPermissions => ({
    viewServer: true, viewLogs: true, sendConsoleCommands: false, controlLifecycle: false,
    startServer: true, stopServer: true, restartServer: true, viewPlayers: true,
    moderatePlayers: true, viewMods: true, manageMods: true, viewFiles: true, manageFiles: true,
    viewSettings: true, manageSettings: true, viewWorlds: true, viewBackups: true, createBackups: true,
  })

  it('defaults new members to no access, checks each capability, and applies revocation to the existing principal', () => {
    const access = new ServerAccessService(opened.db, now)
    const member = principal(ids.member, 'member')
    expect(access.authorize(member, ids.one, 'viewServer')).toBe('not-found')
    expect(access.serverIds(member, 'viewServer')).toEqual([])
    access.update(principal(ids.admin, 'administrator'), ids.one, ids.member, {
      ...fullSet(), viewLogs: false, sendConsoleCommands: false, controlLifecycle: false, startServer: false, stopServer: false, restartServer: false, viewPlayers: false,
      moderatePlayers: false, viewMods: false, manageMods: false, viewFiles: false, manageFiles: false,
      viewSettings: false, manageSettings: false, viewWorlds: false, viewBackups: false, createBackups: false,
    })
    expect(access.authorize(member, ids.one, 'viewServer')).toBe('allowed')
    expect(access.authorize(member, ids.one, 'viewLogs')).toBe('forbidden')
    expect(access.authorize(member, ids.two, 'viewServer')).toBe('not-found')
    expect(access.serverIds(member, 'viewServer')).toEqual([ids.one])
    expect(access.permissions(ids.one, ids.member).viewServer).toBe(true)
    expect(access.permissions(ids.one, ids.member).manageFiles).toBe(false)

    access.update(principal(ids.admin, 'administrator'), ids.one, ids.member, Object.fromEntries(Object.keys(fullSet()).map((key) => [key, false])) as ServerAccessPermissions)
    expect(access.authorize(member, ids.one, 'viewServer')).toBe('not-found')
    expect(access.serverIds(member, 'viewServer')).toEqual([])
    const accessEvents = opened.db.select().from(localServerEvents).all()
    expect(accessEvents).toHaveLength(2)
    expect(accessEvents).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'server-access-grant-updated', outcome: 'success' })]))
    expect(opened.db.select().from(auditEvents).all()).toHaveLength(2)
    expect(opened.db.select().from(auditEvents).all()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'server.access.updated', outcome: 'success' })]))
    const changed = JSON.parse(opened.db.select().from(localServerEvents).all()[1]!.detail!) as { changed: string[] }
    expect(changed.changed).toContain('viewServer')
  })

  it('uses the current stored role instead of a stale administrator session claim', () => {
    const access = new ServerAccessService(opened.db, now)
    const staleAdmin = principal(ids.admin, 'administrator')
    opened.db.update(users).set({ role: 'member' }).where(eq(users.id, ids.admin)).run()
    expect(access.serverIds(staleAdmin, 'viewServer')).toEqual([])
    expect(access.authorize(staleAdmin, ids.one, 'viewServer')).toBe('not-found')
  })

  it('keeps Administrator access implicit and blocks disabled accounts', () => {
    const access = new ServerAccessService(opened.db, now)
    const admin = principal(ids.admin, 'administrator')
    expect(access.authorize(admin, ids.one, 'manageFiles')).toBe('allowed')
    expect(access.permissions(ids.one, ids.admin).manageFiles).toBe(true)
    opened.db.update(users).set({ enabled: false }).where(eq(users.id, ids.admin)).run()
    expect(access.serverIds(admin, 'viewServer')).toEqual([])
    expect(access.authorize(admin, ids.one, 'viewServer')).toBe('not-found')
  })
})
