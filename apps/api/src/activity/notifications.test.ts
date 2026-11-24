import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../db/client.js'
import { auditEvents, localServerEvents, localServerRuntime, localServerStructuredEvents, localServers, userNotificationReads, users } from '../db/schema.js'
import { ActivityFeedService } from './feed.js'
import { NotificationError, NotificationService } from './notifications.js'

describe('persisted operational notifications', () => {
  let directory: string
  let databasePath: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let notifications: NotificationService
  let adminId: string
  let memberId: string
  let serverId: string
  const at = '2026-11-24T10:00:00.000Z'

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-notifications-'))
    databasePath = join(directory, 'mmsmanager.sqlite')
    opened = await openDatabase({ path: databasePath })
    notifications = new NotificationService(opened.db, new ActivityFeedService(opened.db), () => Date.parse(at))
    adminId = randomUUID()
    memberId = randomUUID()
    serverId = randomUUID()
    await opened.db.insert(users).values([
      { id: adminId, username: 'notify-admin', usernameKey: 'notify-admin', displayName: 'Notify Admin', role: 'administrator', passwordHash: 'fixture-only-hash', createdAt: at, updatedAt: at, passwordChangedAt: at },
      { id: memberId, username: 'notify-member', usernameKey: 'notify-member', displayName: 'Notify Member', role: 'member', passwordHash: 'fixture-only-hash', createdAt: at, updatedAt: at, passwordChangedAt: at },
    ])
    await opened.db.insert(localServers).values({ id: serverId, name: 'Notification Fixture', directory: join(directory, 'server'), source: 'created', software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath: null, javaMajor: 21, minMemoryMb: 1024, maxMemoryMb: 2048, port: 25565, eula: 'accepted', managed: true, worldFolders: '[]', createdBy: adminId, createdAt: at, updatedAt: at })
  })

  afterEach(async () => {
    opened.native.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('shows only persisted failures and pending restart states with member-safe details', async () => {
    expect(notifications.list(memberId, 'member')).toEqual({ items: [], unreadCount: 0 })
    await opened.db.insert(localServerEvents).values({ serverId, actorUserId: adminId, action: 'server-backup-schedule-missed', outcome: 'failure', occurredAt: at, detail: '/private/fixture/world' })
    await opened.db.insert(localServerStructuredEvents).values({ serverId, occurredAt: at, category: 'server', eventType: 'server_crashed', description: 'The owned server process exited unexpectedly.', confidence: 'high', source: 'panel-process' })
    await opened.db.insert(localServerRuntime).values({ serverId, status: 'crashed', updatedAt: at, restartRequired: true })
    await opened.db.insert(auditEvents).values({ actorUserId: adminId, subjectUserId: adminId, action: 'login.failed', outcome: 'failure', occurredAt: at })

    const admin = notifications.list(adminId, 'administrator')
    const member = notifications.list(memberId, 'member')
    expect(admin.items.map((item) => item.event.title).sort()).toEqual(['Sign-in attempt failed', 'Scheduled backup was missed', 'Server process crash observed', 'Server restart required'].sort())
    expect(member.items.map((item) => item.event.title).sort()).toEqual(['Scheduled backup was missed', 'Server process crash observed', 'Server restart required'].sort())
    expect(admin.items.filter((item) => item.event.source === 'server-log')).toHaveLength(1)
    expect(JSON.stringify(member)).not.toContain('/private/fixture')
    expect(JSON.stringify(member)).not.toContain('Notify Admin')
    expect(JSON.stringify(member)).not.toContain('Sign-in attempt failed')
    expect(member.items.find((item) => item.event.title === 'Server process crash observed')?.event).toMatchObject({ outcome: 'failure', redacted: true, description: 'The managed server process exited unexpectedly.' })
  })

  it('keeps read state per-user across database reopen and rejects invisible events', async () => {
    await opened.db.insert(localServerEvents).values({ serverId, actorUserId: adminId, action: 'server-install-failed', outcome: 'failure', occurredAt: at, detail: 'private message' })
    const memberBefore = notifications.list(memberId, 'member')
    const eventId = memberBefore.items[0]!.eventId
    const memberAfter = notifications.markRead(memberId, 'member', eventId)
    expect(memberAfter.unreadCount).toBe(0)
    expect(notifications.list(adminId, 'administrator').unreadCount).toBe(1)
    await expect(Promise.resolve().then(() => notifications.markRead(memberId, 'member', 'audit:999'))).rejects.toBeInstanceOf(NotificationError)
    expect(opened.db.select().from(userNotificationReads).all()).toHaveLength(1)

    opened.native.close()
    opened = await openDatabase({ path: databasePath })
    notifications = new NotificationService(opened.db, new ActivityFeedService(opened.db), () => Date.parse(at))
    expect(notifications.list(memberId, 'member').items[0]?.readAt).toBe(at)
    expect(notifications.list(adminId, 'administrator').items[0]?.readAt).toBeNull()
    expect(opened.db.select().from(localServerEvents).where(eq(localServerEvents.serverId, serverId)).all()).toHaveLength(1)
  })
})
