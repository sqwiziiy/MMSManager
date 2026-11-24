import { and, eq, inArray } from 'drizzle-orm'
import { activityQuerySchema, type ActivityItem, type ActivityQuery, type NotificationsResponse, type UserRole } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { localServerRuntime, localServers, userNotificationReads } from '../db/schema.js'
import { ActivityFeedService } from './feed.js'

export class NotificationError extends Error {
  constructor(readonly code: 'NOTIFICATION_NOT_FOUND', message: string) { super(message) }
}

export class NotificationService {
  constructor(private readonly db: AppDatabase, private readonly activity: ActivityFeedService, private readonly now: () => number = Date.now) {}

  list(userId: string, role: UserRole): NotificationsResponse {
    const events: ActivityItem[] = []
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < 10 && events.length < 100; pageNumber += 1) {
      const query = activityQuerySchema.parse({ category: 'all', limit: 100, cursor } satisfies Partial<ActivityQuery>)
      const page = this.activity.list(query, role)
      events.push(...page.events.filter((event) => event.outcome === 'failure'))
      if (!page.hasMore || !page.nextCursor) break
      cursor = page.nextCursor
    }
    const pendingRestarts = this.db.select({ serverId: localServerRuntime.serverId, updatedAt: localServerRuntime.updatedAt, name: localServers.name })
      .from(localServerRuntime).innerJoin(localServers, eq(localServers.id, localServerRuntime.serverId))
      .where(eq(localServerRuntime.restartRequired, true)).all()
    for (const runtime of pendingRestarts) {
      const eventId = `restart:${runtime.serverId}:${runtime.updatedAt}`
      events.push({ id: eventId, occurredAt: runtime.updatedAt, category: 'server', title: 'Server restart required',
        description: 'Saved changes are pending a server restart.', outcome: 'info', source: 'server-action',
        serverId: runtime.serverId, serverName: runtime.name, actor: null, redacted: true })
    }
    const orderedEvents = [...new Map(events.map((event) => [event.id, event])).values()]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id))
    const seenOperationalPairs = new Set<string>()
    const uniqueEvents = orderedEvents.filter((event) => {
      if (!event.serverId || !['server-action', 'server-log'].includes(event.source)) return true
      const key = `${event.serverId}:${event.occurredAt}:${event.title}`
      if (seenOperationalPairs.has(key)) return false
      if (event.source === 'server-log') seenOperationalPairs.add(key)
      return true
    })
    const visible = uniqueEvents.slice(0, 100)
    const readRows = visible.length ? this.db.select({ eventId: userNotificationReads.eventId, readAt: userNotificationReads.readAt })
      .from(userNotificationReads).where(and(eq(userNotificationReads.userId, userId), inArray(userNotificationReads.eventId, visible.map((event) => event.id)))).all() : []
    const reads = new Map(readRows.map((row) => [row.eventId, row.readAt]))
    const items = visible.map((event) => ({ eventId: event.id, event, readAt: reads.get(event.id) ?? null }))
    return { items, unreadCount: items.filter((item) => item.readAt === null).length }
  }

  markRead(userId: string, role: UserRole, eventId: string): NotificationsResponse {
    if (!this.list(userId, role).items.some((item) => item.eventId === eventId)) {
      throw new NotificationError('NOTIFICATION_NOT_FOUND', 'This notification is not available in your local workspace view.')
    }
    this.db.insert(userNotificationReads).values({ userId, eventId, readAt: new Date(this.now()).toISOString() })
      .onConflictDoUpdate({ target: [userNotificationReads.userId, userNotificationReads.eventId], set: { readAt: new Date(this.now()).toISOString() } }).run()
    return this.list(userId, role)
  }
}
