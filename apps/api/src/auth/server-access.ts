import { and, eq } from 'drizzle-orm'
import { serverAccessPermissionsSchema, type ServerAccessPermissions } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { auditEvents, localServerEvents, localServers, serverAccessGrants, users } from '../db/schema.js'
import type { SessionPrincipal } from './service.js'

export type ServerCapability = keyof ServerAccessPermissions
export type ServerAccessDecision = 'allowed' | 'not-found' | 'forbidden'

const permissionFields = Object.keys(serverAccessPermissionsSchema.shape) as ServerCapability[]
const noPermissions = (): ServerAccessPermissions => Object.fromEntries(permissionFields.map((field) => [field, false])) as ServerAccessPermissions
const fullPermissions = (): ServerAccessPermissions => Object.fromEntries(permissionFields.map((field) => [field, true])) as ServerAccessPermissions

function permissionsFromRow(row: Partial<ServerAccessPermissions> | null | undefined): ServerAccessPermissions {
  const values = noPermissions()
  for (const field of permissionFields) values[field] = row?.[field] === true
  return values
}

export class ServerAccessError extends Error {
  constructor(readonly code: 'SERVER_ACCESS_NOT_FOUND' | 'ACCESS_USER_NOT_FOUND' | 'ACCESS_ADMIN_IMPLICIT', message: string) { super(message) }
}

export class ServerAccessService {
  constructor(private readonly db: AppDatabase, private readonly now: () => number = Date.now) {}

  permissions(serverId: string, userId: string): ServerAccessPermissions {
    const account = this.db.select({ role: users.role, enabled: users.enabled }).from(users).where(eq(users.id, userId)).get()
    if (!account?.enabled) return noPermissions()
    if (account.role === 'administrator') return fullPermissions()
    const row = this.db.select().from(serverAccessGrants).where(and(
      eq(serverAccessGrants.serverId, serverId), eq(serverAccessGrants.userId, userId),
    )).get()
    return permissionsFromRow(row)
  }

  authorize(principal: SessionPrincipal, serverId: string, capability: ServerCapability): ServerAccessDecision {
    const server = this.db.select({ id: localServers.id }).from(localServers).where(eq(localServers.id, serverId)).get()
    if (!server) return 'not-found'
    const account = this.db.select({ role: users.role, enabled: users.enabled }).from(users).where(eq(users.id, principal.userId)).get()
    if (!account?.enabled) return 'not-found'
    if (account.role === 'administrator') return 'allowed'
    const permissions = this.permissions(serverId, principal.userId)
    if (!permissions.viewServer) return 'not-found'
    if (!permissions[capability]) return 'forbidden'
    return 'allowed'
  }

  serverIds(principal: SessionPrincipal, capability: ServerCapability): string[] {
    const account = this.db.select({ role: users.role, enabled: users.enabled }).from(users).where(eq(users.id, principal.userId)).get()
    if (!account?.enabled) return []
    if (account.role === 'administrator') {
      return this.db.select({ id: localServers.id }).from(localServers).all().map((row) => row.id)
    }
    const rows = this.db.select({ serverId: serverAccessGrants.serverId }).from(serverAccessGrants)
      .innerJoin(users, eq(users.id, serverAccessGrants.userId)).where(and(
        eq(serverAccessGrants.userId, principal.userId), eq(users.enabled, true), eq(users.role, 'member'),
        eq(serverAccessGrants.viewServer, true), eq(serverAccessGrants[capability], true),
      )).all()
    return rows.map((row) => row.serverId)
  }

  listForAdmin(serverId: string) {
    if (!this.db.select({ id: localServers.id }).from(localServers).where(eq(localServers.id, serverId)).get()) {
      throw new ServerAccessError('SERVER_ACCESS_NOT_FOUND', 'This server is not available in the local inventory.')
    }
    const usersInWorkspace = this.db.select({
      userId: users.id, username: users.username, displayName: users.displayName, role: users.role, enabled: users.enabled,
    }).from(users).orderBy(users.usernameKey).limit(500).all()
    const grants = new Map(this.db.select().from(serverAccessGrants).where(eq(serverAccessGrants.serverId, serverId)).all()
      .map((row) => [row.userId, row]))
    return usersInWorkspace.map((user) => ({
      ...user,
      permissions: user.role === 'administrator' ? fullPermissions() : permissionsFromRow(grants.get(user.userId)),
    }))
  }

  update(principal: SessionPrincipal, serverId: string, userId: string, input: ServerAccessPermissions): void {
    const permissions = serverAccessPermissionsSchema.parse(input)
    const at = new Date(this.now()).toISOString()
    this.db.transaction((tx) => {
      const server = tx.select({ id: localServers.id }).from(localServers).where(eq(localServers.id, serverId)).get()
      if (!server) throw new ServerAccessError('SERVER_ACCESS_NOT_FOUND', 'This server is not available in the local inventory.')
      const user = tx.select({ id: users.id, role: users.role, enabled: users.enabled }).from(users).where(eq(users.id, userId)).get()
      if (!user || user.role !== 'member' || !user.enabled) throw new ServerAccessError('ACCESS_USER_NOT_FOUND', 'Choose an enabled Member account to set server permissions.')
      const oldRow = tx.select().from(serverAccessGrants).where(and(
        eq(serverAccessGrants.serverId, serverId), eq(serverAccessGrants.userId, userId),
      )).get()
      const previous = permissionsFromRow(oldRow)
      const changed = permissionFields.filter((field) => previous[field] !== permissions[field])
      if (changed.length === 0) return
      tx.insert(serverAccessGrants).values({
        serverId, userId, ...permissions, createdAt: oldRow?.createdAt ?? at, updatedAt: at, updatedBy: principal.userId,
      }).onConflictDoUpdate({
        target: [serverAccessGrants.serverId, serverAccessGrants.userId],
        set: { ...permissions, updatedAt: at, updatedBy: principal.userId },
      }).run()
      tx.insert(localServerEvents).values({
        serverId, actorUserId: principal.userId, action: 'server-access-grant-updated', outcome: 'success', occurredAt: at,
        detail: JSON.stringify({ memberUserId: userId, changed }),
      }).run()
      tx.insert(auditEvents).values({ actorUserId: principal.userId, subjectUserId: userId, action: 'server.access.updated', outcome: 'success', occurredAt: at }).run()
    })
  }
}
