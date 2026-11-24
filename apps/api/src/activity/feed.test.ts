import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { activityQuerySchema } from '@mmsmanager/shared'
import { openDatabase } from '../db/client.js'
import { auditEvents, localServerEvents, localServerStructuredEvents, localServers, machineEvents, users } from '../db/schema.js'
import { ActivityFeedService } from './feed.js'

describe('persisted activity feed', () => {
  let directory: string
  let databasePath: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let feed: ActivityFeedService
  let adminId: string
  let serverId: string
  const at = '2026-11-24T10:00:00.000Z'

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-activity-'))
    databasePath = join(directory, 'mmsmanager.sqlite')
    opened = await openDatabase({ path: databasePath })
    feed = new ActivityFeedService(opened.db)
    adminId = randomUUID()
    serverId = randomUUID()
    await opened.db.insert(users).values({ id: adminId, username: 'feed-admin', usernameKey: 'feed-admin', displayName: 'Feed Admin', role: 'administrator', passwordHash: 'fixture-only-password-hash', createdAt: at, updatedAt: at, passwordChangedAt: at })
    await opened.db.insert(localServers).values({ id: serverId, name: 'Fixture Realm', directory: join(directory, 'server'), source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath: '/fixture/java', javaMajor: 21, requiredJavaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 2048, port: 25565, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: adminId, createdAt: at, updatedAt: at })
  })

  afterEach(async () => {
    opened.native.close()
    await rm(directory, { recursive: true, force: true })
  })

  function query(input: Record<string, unknown> = {}) { return activityQuerySchema.parse(input) }

  it('merges persisted sources in stable keyset order without gaps or duplicates', async () => {
    await opened.db.insert(machineEvents).values({ machineId: 'local', occurredAt: at, timeZone: 'Europe/Paris', localDate: '2026-11-24', category: 'collector', severity: 'info', message: 'A real fixture collector event.', source: 'local-backend' })
    await opened.db.insert(localServerEvents).values({ serverId, actorUserId: adminId, action: 'server-start-requested', outcome: 'success', occurredAt: at, detail: JSON.stringify({ secretPath: '/private/fixture' }) })
    await opened.db.insert(localServerStructuredEvents).values({ serverId, consoleEntryId: 8, occurredAt: at, category: 'player', eventType: 'player_joined', description: 'Alex joined the server.', rawMessage: '[10:00:00] Alex joined the game', confidence: 'high', source: 'owned-log' })
    await opened.db.insert(auditEvents).values({ actorUserId: adminId, subjectUserId: adminId, action: 'login.succeeded', outcome: 'success', occurredAt: at })

    const adminPages = []
    let cursor: string | undefined
    do {
      const page = feed.list(query({ limit: 2, cursor }), 'administrator')
      adminPages.push(...page.events)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(adminPages.map((event) => event.source)).toEqual(['audit', 'server-log', 'server-action', 'machine'])
    expect(new Set(adminPages.map((event) => event.id)).size).toBe(4)
    expect(JSON.stringify(adminPages)).not.toContain('/private/fixture')
    expect(JSON.stringify(adminPages)).not.toContain('Alex joined the game')
    expect(adminPages[1]).toMatchObject({ description: 'Alex joined the server.', redacted: false })
  })

  it('filters dates, categories and server identity while redacting member details', async () => {
    await opened.db.insert(localServerEvents).values({ serverId, actorUserId: adminId, action: 'server-backup-create', outcome: 'success', occurredAt: at, detail: '/private/fixture' })
    await opened.db.insert(localServerStructuredEvents).values({ serverId, consoleEntryId: 9, occurredAt: at, category: 'player', eventType: 'player_joined', description: 'Alex joined the server.', rawMessage: 'Alex joined the game', confidence: 'high', source: 'owned-log' })
    await opened.db.insert(auditEvents).values({ actorUserId: adminId, subjectUserId: adminId, action: 'login.succeeded', outcome: 'success', occurredAt: at })

    const memberRows = feed.list(query({ category: 'player', serverId, from: at, to: at }), 'member').events
    expect(memberRows).toHaveLength(1)
    expect(memberRows[0]).toMatchObject({ description: 'A player joined the server.', actor: null, redacted: true, serverName: 'Fixture Realm' })
    expect(feed.list(query({ category: 'security' }), 'member').events).toEqual([])
    expect(feed.list(query({ category: 'backup', serverId }), 'administrator').events[0]).toMatchObject({ category: 'backup', title: 'Backup created' })
    expect(feed.list(query({ serverId: randomUUID() }), 'administrator').events).toEqual([])
    expect(() => feed.list(query({ limit: 1, cursor: 'malformed' }), 'administrator')).toThrow('cursor is invalid')
  })

  it('deduplicates repeated parsed log lines and survives a database reopen', async () => {
    await opened.db.insert(localServerStructuredEvents).values([
      { serverId, consoleEntryId: 12, occurredAt: at, category: 'player', eventType: 'player_joined', description: 'Alex joined the server.', rawMessage: null, confidence: 'high', source: 'owned-log' },
      { serverId, consoleEntryId: 12, occurredAt: at, category: 'player', eventType: 'player_joined', description: 'Alex joined the server.', rawMessage: null, confidence: 'high', source: 'owned-log' },
    ])
    expect(feed.list(query(), 'member').events).toHaveLength(1)
    opened.native.close()
    opened = await openDatabase({ path: databasePath })
    feed = new ActivityFeedService(opened.db)
    expect(feed.list(query(), 'member').events).toHaveLength(1)
  })
})
