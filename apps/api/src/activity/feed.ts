import { and, desc, eq, gte, inArray, isNull, like, lte, lt, notLike, or, type SQL } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { ActivityCategory, ActivityItem, ActivityQuery, ActivityResponse, UserRole } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { auditEvents, localServerEvents, localServerStructuredEvents, localServers, machineEvents, users } from '../db/schema.js'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

type Cursor = { at: string; source: number; id: number; filter: string }
type Row = ActivityItem & { rank: number; rowId: number; dedupeKey?: string }
export type ActivityAccessScope = { serverIds?: string[]; playerServerIds?: string[]; backupServerIds?: string[]; automationServerIds?: string[] }

const EVENT_TITLES: Record<string, string> = {
  'server-installed': 'Server installation completed',
  'server-install-failed': 'Server installation failed',
  'server-install-cancelled': 'Server installation cancelled',
  'server-imported': 'Server added to local inventory',
  'server-start-requested': 'Server start requested',
  'server-stop-requested': 'Graceful server stop requested',
  'server-restart-requested': 'Server restart requested',
  'server-restart-completed': 'Server restart completed',
  'server-crashed': 'Server process crash observed',
  'server-restart-failed': 'Server restart failed',
  'JAVA_SPAWN_FAILED': 'Server start failed',
  'server-properties-updated': 'Server properties updated',
  'server-properties-restored': 'Server properties restored',
  'server-backup-create': 'Backup created',
  'server-backup-scheduled': 'Scheduled backup created',
  'server-backup-safety-copy': 'Recovery snapshot created',
  'server-backup-restore': 'Backup restore completed',
  'server-backup-restore-recovery': 'Backup recovery action recorded',
  'server-backup-schedule-updated': 'Backup schedule updated',
  'server-backup-schedule-completed': 'Scheduled backup completed',
  'server-backup-schedule-failed': 'Scheduled backup failed',
  'server-backup-schedule-missed': 'Scheduled backup was missed',
  'server-backup-schedule-missed-acknowledged': 'Missed backup acknowledged',
  'server-backup-schedule-interrupted': 'Scheduled backup interrupted',
  'server-restart-schedule-updated': 'Server restart schedule updated',
  'server-restart-schedule-attempted': 'Scheduled server restart started',
  'server-restart-schedule-executed': 'Scheduled server restart completed',
  'server-restart-schedule-skipped': 'Scheduled server restart skipped',
  'server-restart-schedule-deferred': 'Scheduled server restart deferred',
  'server-restart-schedule-failed': 'Scheduled server restart failed',
  'server-restart-schedule-missed': 'Scheduled server restart was missed',
  'server-restart-schedule-interrupted': 'Scheduled server restart interrupted',
  'server-access-grant-updated': 'Server access updated',
  'server-runtime-settings-updated': 'Runtime settings updated',
  'server-metadata-updated': 'Server name updated',
  'workspace-template-created': 'Server template created',
  'workspace-template-updated': 'Server template updated',
  'workspace-template-deleted': 'Server template deleted',
}

const AUDIT_TITLES: Record<string, string> = {
  'bootstrap.completed': 'Administrator setup completed',
  'bootstrap.failed': 'Administrator setup attempt failed',
  'admin.recovered': 'Administrator recovery completed',
  'login.failed': 'Sign-in attempt failed',
  'login.succeeded': 'Sign-in succeeded',
  'logout.succeeded': 'Sign-out completed',
  'password.changed': 'Password changed',
  'profile.updated': 'Profile updated',
  'profile.preferences.updated': 'Personal preferences updated',
  'profile.avatar.updated': 'Profile image updated',
  'profile.avatar.removed': 'Profile image removed',
  'user.created': 'Workspace account created',
  'user.updated': 'Workspace account updated',
  'user.disabled': 'Workspace account disabled',
  'user.enabled': 'Workspace account enabled',
  'user.password.reset': 'Workspace password reset',
  'workspace.preferences.updated': 'Workspace settings updated',
  'server.access.updated': 'Server access updated',
}

function eventCategory(action: string): Exclude<ActivityCategory, 'all' | 'security' | 'player'> {
  if (action.startsWith('workspace-template-')) return 'system'
  if (action.startsWith('server-backup-schedule-') || action.startsWith('server-restart-schedule-')) return 'automation'
  if (action.startsWith('server-backup-')) return 'backup'
  return 'server'
}

function filterHash(query: ActivityQuery, access?: ActivityAccessScope): string {
  const normalized = JSON.stringify({ category: query.category, serverId: query.serverId ?? null, from: query.from ?? null, to: query.to ?? null,
    access: access ? { serverIds: access.serverIds?.slice().sort() ?? null, playerServerIds: access.playerServerIds?.slice().sort() ?? null, backupServerIds: access.backupServerIds?.slice().sort() ?? null, automationServerIds: access.automationServerIds?.slice().sort() ?? null } : null })
  return createHash('sha256').update(normalized).digest('base64url').slice(0, 18)
}

function scopeFilter(column: AnySQLiteColumn, ids: string[] | undefined): SQL | undefined {
  if (ids === undefined) return undefined
  return ids.length ? inArray(column, ids) : eq(column, '')
}

function decodeCursor(raw: string | undefined, filter: string): Cursor | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null) throw new Error('invalid')
    const cursor = value as Partial<Cursor>
    if (typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at)) || !Number.isInteger(cursor.source) || !Number.isInteger(cursor.id) || (cursor.id ?? 0) < 1 || cursor.filter !== filter || (cursor.source ?? -1) < 0 || (cursor.source ?? 4) > 3) throw new Error('invalid')
    return cursor as Cursor
  } catch {
    throw new ActivityFeedError('ACTIVITY_CURSOR_INVALID', 'The activity cursor is invalid or no longer matches these filters.')
  }
}

function sourceWindow(timeColumn: AnySQLiteColumn, idColumn: AnySQLiteColumn, source: number, cursor: Cursor | null): SQL | undefined {
  if (!cursor) return undefined
  if (source < cursor.source) return or(lt(timeColumn, cursor.at), eq(timeColumn, cursor.at))
  if (source > cursor.source) return lt(timeColumn, cursor.at)
  return or(lt(timeColumn, cursor.at), and(eq(timeColumn, cursor.at), lt(idColumn, cursor.id)))
}

function rangeConditions(timeColumn: AnySQLiteColumn, from?: string, to?: string): SQL[] {
  const conditions: SQL[] = []
  if (from) conditions.push(gte(timeColumn, from))
  if (to) conditions.push(lte(timeColumn, to))
  return conditions
}

function safePlayerDescription(eventType: string): string {
  switch (eventType) {
    case 'player_joined': return 'A player joined the server.'
    case 'player_left': return 'A player left the server.'
    case 'player_kicked':
    case 'player_banned':
    case 'player_pardoned':
    case 'player_operator_added':
    case 'player_operator_removed':
    case 'player_whitelisted':
    case 'player_unwhitelisted': return 'A player moderation action was recorded.'
    case 'server_ready': return 'The server reported that it is ready.'
    case 'server_shutdown_started': return 'The server log reported that shutdown started.'
    case 'server_restart_started': return 'The server log reported that a restart started.'
    default: return 'A server event was recorded.'
  }
}

function serverEventTitle(eventType: string): string {
  switch (eventType) {
    case 'server_ready': return 'Server readiness observed'
    case 'server_shutdown_started': return 'Server shutdown observed'
    case 'server_restart_started': return 'Server restart observed'
    case 'server_session_interrupted': return 'Server session interrupted'
    case 'server_crashed': return 'Server process crash observed'
    case 'server_start_failed': return 'Server start failed'
    case 'server_stopped': return 'Server stopped'
    default: return 'Server status event'
  }
}

function safeServerDescription(eventType: string): string {
  switch (eventType) {
    case 'server_ready': return 'The managed server reported readiness.'
    case 'server_shutdown_started': return 'The managed server began shutting down.'
    case 'server_restart_started': return 'The managed server began restarting.'
    case 'server_session_interrupted': return 'The managed server session could not be fully reconciled.'
    case 'server_crashed': return 'The managed server process exited unexpectedly.'
    case 'server_start_failed': return 'The managed server process could not start.'
    case 'server_stopped': return 'The managed server process stopped.'
    default: return 'A managed server status event was recorded.'
  }
}

function actionDescription(outcome: 'success' | 'failure'): string {
  return outcome === 'failure' ? 'The local action did not complete successfully.' : 'The local action was recorded.'
}

export class ActivityFeedError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class ActivityFeedService {
  constructor(private readonly db: AppDatabase) {}

  list(query: ActivityQuery, role: UserRole, access?: ActivityAccessScope): ActivityResponse {
    const fingerprint = filterHash(query, access)
    const cursor = decodeCursor(query.cursor, fingerprint)
    const fetchCount = query.limit * 2 + 1
    const rows: Row[] = []
    const isSelected = (category: Exclude<ActivityCategory, 'all'>) => query.category === 'all' || query.category === category
    const genericFilters = (column: AnySQLiteColumn, rank: number, id: AnySQLiteColumn) => [
      ...rangeConditions(column, query.from, query.to),
      sourceWindow(column, id, rank, cursor),
    ]

    if (!query.serverId && isSelected('system')) {
      const machineRows = this.db.select().from(machineEvents).where(and(
        eq(machineEvents.machineId, 'local'), ...genericFilters(machineEvents.occurredAt, 0, machineEvents.id),
      )).orderBy(desc(machineEvents.occurredAt), desc(machineEvents.id)).limit(fetchCount).all()
      for (const row of machineRows) rows.push({
        id: `machine:${row.id}`, occurredAt: row.occurredAt, category: 'system', title: 'Local metrics collector',
        description: row.message, outcome: row.severity === 'error' ? 'failure' : 'info', source: 'machine',
        serverId: null, serverName: null, actor: null, redacted: false, rank: 0, rowId: row.id,
      })
    }

    if (role === 'administrator' && !query.serverId && isSelected('security')) {
      const auditRows = this.db.select({ id: auditEvents.id, occurredAt: auditEvents.occurredAt, action: auditEvents.action,
        outcome: auditEvents.outcome, actor: users.displayName }).from(auditEvents)
        .leftJoin(users, eq(users.id, auditEvents.actorUserId)).where(and(...genericFilters(auditEvents.occurredAt, 3, auditEvents.id)))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(fetchCount).all()
      for (const row of auditRows) rows.push({
        id: `audit:${row.id}`, occurredAt: row.occurredAt, category: 'security', title: AUDIT_TITLES[row.action] ?? 'Account security event',
        description: row.outcome === 'failure' ? 'The account action was not completed.' : 'The account action was recorded locally.',
        outcome: row.outcome, source: 'audit', serverId: null, serverName: null, actor: row.actor, redacted: true, rank: 3, rowId: row.id,
      })
    }

    const includeServerActions = query.category === 'all' || query.category === 'system' || query.category === 'server' || query.category === 'backup' || query.category === 'automation'
    const actionAccess = access === undefined ? undefined : query.category === 'backup'
      ? scopeFilter(localServerEvents.serverId, access.backupServerIds)
      : query.category === 'automation' ? scopeFilter(localServerEvents.serverId, access.automationServerIds)
        : query.category === 'system' ? isNull(localServerEvents.serverId)
          : query.category === 'all' ? or(
            and(like(localServerEvents.action, 'server-backup-%'), notLike(localServerEvents.action, 'server-backup-schedule-%'), scopeFilter(localServerEvents.serverId, access.backupServerIds)),
            and(or(like(localServerEvents.action, 'server-backup-schedule-%'), like(localServerEvents.action, 'server-restart-schedule-%')), scopeFilter(localServerEvents.serverId, access.automationServerIds)),
            and(notLike(localServerEvents.action, 'server-backup-%'), notLike(localServerEvents.action, 'server-restart-schedule-%'), notLike(localServerEvents.action, 'workspace-template-%'), scopeFilter(localServerEvents.serverId, access.serverIds)),
            isNull(localServerEvents.serverId),
          )
          : scopeFilter(localServerEvents.serverId, access.serverIds)
    if (includeServerActions) {
      const actionRows = this.db.select({ id: localServerEvents.id, serverId: localServerEvents.serverId, occurredAt: localServerEvents.occurredAt,
        action: localServerEvents.action, outcome: localServerEvents.outcome, serverName: localServers.name, actor: users.displayName })
        .from(localServerEvents).leftJoin(localServers, eq(localServers.id, localServerEvents.serverId))
        .leftJoin(users, eq(users.id, localServerEvents.actorUserId)).where(and(
          query.serverId ? eq(localServerEvents.serverId, query.serverId) : undefined,
          actionAccess,
          query.category === 'backup' ? and(like(localServerEvents.action, 'server-backup-%'), notLike(localServerEvents.action, 'server-backup-schedule-%')) : undefined,
          query.category === 'automation' ? or(like(localServerEvents.action, 'server-backup-schedule-%'), like(localServerEvents.action, 'server-restart-schedule-%')) : undefined,
          query.category === 'server' ? and(notLike(localServerEvents.action, 'server-backup-%'), notLike(localServerEvents.action, 'server-restart-schedule-%'), notLike(localServerEvents.action, 'workspace-template-%')) : undefined,
          query.category === 'system' ? like(localServerEvents.action, 'workspace-template-%') : undefined,
          ...rangeConditions(localServerEvents.occurredAt, query.from, query.to),
          sourceWindow(localServerEvents.occurredAt, localServerEvents.id, 1, cursor),
        )).orderBy(desc(localServerEvents.occurredAt), desc(localServerEvents.id)).limit(fetchCount).all()
      for (const row of actionRows) {
        const category = eventCategory(row.action)
        if (query.category !== 'all' && category !== query.category) continue
        rows.push({ id: `server-action:${row.id}`, occurredAt: row.occurredAt, category,
          title: EVENT_TITLES[row.action] ?? 'Server activity', description: actionDescription(row.outcome), outcome: row.outcome,
          source: 'server-action', serverId: row.serverId, serverName: row.serverName,
          actor: role === 'administrator' ? row.actor : null, redacted: true, rank: 1, rowId: row.id })
      }
    }

    if (isSelected('server')) {
      const serverRows = this.db.select({ id: localServerStructuredEvents.id, serverId: localServerStructuredEvents.serverId,
        consoleEntryId: localServerStructuredEvents.consoleEntryId, occurredAt: localServerStructuredEvents.occurredAt,
        eventType: localServerStructuredEvents.eventType, description: localServerStructuredEvents.description,
        serverName: localServers.name })
        .from(localServerStructuredEvents).innerJoin(localServers, eq(localServers.id, localServerStructuredEvents.serverId)).where(and(
          eq(localServerStructuredEvents.category, 'server'),
          query.serverId ? eq(localServerStructuredEvents.serverId, query.serverId) : undefined,
          scopeFilter(localServerStructuredEvents.serverId, access?.serverIds),
          ...rangeConditions(localServerStructuredEvents.occurredAt, query.from, query.to),
          sourceWindow(localServerStructuredEvents.occurredAt, localServerStructuredEvents.id, 2, cursor),
        )).orderBy(desc(localServerStructuredEvents.occurredAt), desc(localServerStructuredEvents.id)).limit(fetchCount).all()
      for (const row of serverRows) {
        const failed = row.eventType === 'server_crashed' || row.eventType === 'server_start_failed'
        rows.push({ id: `server-log:${row.id}`, occurredAt: row.occurredAt, category: 'server',
          title: serverEventTitle(row.eventType),
          description: role === 'administrator' ? row.description : safeServerDescription(row.eventType),
          outcome: failed ? 'failure' : 'info', source: 'server-log', serverId: row.serverId,
          serverName: row.serverName, actor: null, redacted: role !== 'administrator', rank: 2,
          rowId: row.id, dedupeKey: row.consoleEntryId === null ? undefined : `${row.serverId}:${row.consoleEntryId}` })
      }
    }

    if (isSelected('player')) {
      const structuredRows = this.db.select({ id: localServerStructuredEvents.id, serverId: localServerStructuredEvents.serverId,
        consoleEntryId: localServerStructuredEvents.consoleEntryId, occurredAt: localServerStructuredEvents.occurredAt,
        category: localServerStructuredEvents.category, eventType: localServerStructuredEvents.eventType,
        description: localServerStructuredEvents.description, serverName: localServers.name })
        .from(localServerStructuredEvents).innerJoin(localServers, eq(localServers.id, localServerStructuredEvents.serverId)).where(and(
          or(eq(localServerStructuredEvents.category, 'player'), eq(localServerStructuredEvents.category, 'moderation')),
          query.serverId ? eq(localServerStructuredEvents.serverId, query.serverId) : undefined,
          scopeFilter(localServerStructuredEvents.serverId, access?.playerServerIds),
          ...rangeConditions(localServerStructuredEvents.occurredAt, query.from, query.to),
          sourceWindow(localServerStructuredEvents.occurredAt, localServerStructuredEvents.id, 2, cursor),
        )).orderBy(desc(localServerStructuredEvents.occurredAt), desc(localServerStructuredEvents.id)).limit(fetchCount).all()
      for (const row of structuredRows) rows.push({ id: `server-log:${row.id}`, occurredAt: row.occurredAt, category: 'player',
        title: row.eventType.startsWith('player_') ? 'Player activity' : 'Server activity',
        description: role === 'administrator' ? row.description : safePlayerDescription(row.eventType), outcome: 'info',
        source: 'server-log', serverId: row.serverId, serverName: row.serverName, actor: null,
        redacted: role !== 'administrator', rank: 2, rowId: row.id,
        dedupeKey: row.consoleEntryId === null ? undefined : `${row.serverId}:${row.consoleEntryId}` })
    }

    rows.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.rank - left.rank || right.rowId - left.rowId)
    const seen = new Set<string>()
    const uniqueRows = rows.filter((row) => {
      if (!row.dedupeKey) return true
      if (seen.has(row.dedupeKey)) return false
      seen.add(row.dedupeKey)
      return true
    })
    const page = uniqueRows.slice(0, query.limit)
    const hasMore = uniqueRows.length > query.limit
    const last = page.at(-1)
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ at: last.occurredAt, source: last.rank, id: last.rowId, filter: fingerprint } satisfies Cursor)).toString('base64url') : null
    return {
      events: page.map((row) => {
        const { rank, rowId, dedupeKey, ...event } = row
        void rank
        void rowId
        void dedupeKey
        return event
      }),
      nextCursor,
      hasMore,
    }
  }
}
