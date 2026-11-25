import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { LandingPage, UserPreferencesUpdate, UserRole } from '@mmsmanager/shared'
import { hashPassword, makeDummyPasswordHash, validatePasswordBytes, verifyPassword } from './password.js'

const BOOTSTRAP_TTL_MS = 30 * 60 * 1000
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
const PASSWORD_CHANGE_SESSION_MS = 15 * 60 * 1000
const SESSION_REFRESH_MS = 60 * 1000
const COOKIE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,80}$/
const USER_COLUMNS = `u.id, u.username, u.username_key AS usernameKey, u.display_name AS displayName, u.role,
  u.password_hash AS passwordHash, u.enabled, u.must_change_password AS mustChangePassword, u.avatar_key AS avatarKey, u.created_at AS createdAt,
  u.updated_at AS updatedAt, u.last_login_at AS lastLoginAt, u.password_changed_at AS passwordChangedAt`

type UserRow = {
  id: string
  username: string
  usernameKey: string
  displayName: string
  role: UserRole
  passwordHash: string
  enabled: number | boolean
  mustChangePassword: number | boolean
  avatarKey: string | null
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
  passwordChangedAt: string
  compactNavigation?: number | boolean | null
  defaultLanding?: LandingPage | null
  language?: 'en' | 'ru' | null
  theme?: 'dark' | 'light' | 'system' | null
  accent?: 'moss' | 'blue' | 'clay' | null
  density?: 'comfortable' | 'compact' | null
  reducedMotion?: number | boolean | null
}

type BootstrapRow = {
  bootstrapHash: string | null
  bootstrapExpiresAt: string | null
  bootstrapConsumedAt: string | null
  initializedAt: string | null
}

export type SessionPrincipal = {
  userId: string
  username: string
  displayName: string
  role: UserRole
  enabled: true
  mustChangePassword: boolean
  avatarKey: string | null
  tokenHash: string
  csrfHash: string
  createdAt: string
  lastLoginAt: string | null
  compactNavigation: boolean
  defaultLanding: LandingPage
}

export type SessionSecrets = { sessionToken: string; csrfToken: string }

export class AuthFailure extends Error {
  constructor(readonly code: 'bootstrap' | 'unauthorized' | 'conflict' | 'not-found' | 'locked' | 'forbidden' | 'current-password' | 'same-password' | 'confirmation') {
    super(code)
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function equalDigest(left: string | null | undefined, right: string): boolean {
  if (!left || !/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function nowIso(now: number): string {
  return new Date(now).toISOString()
}

function usernameKey(username: string): string {
  return username.trim().toLowerCase()
}

function isEnabled(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1
}

function mapUser(row: UserRow) {
  const defaultLanding = row.defaultLanding === 'machine' ? 'machine' as const : 'dashboard' as const
  const language = row.language === 'ru' ? 'ru' as const : 'en' as const
  const theme = row.theme === 'light' || row.theme === 'system' ? row.theme : 'dark' as const
  const accent = row.accent === 'blue' || row.accent === 'clay' ? row.accent : 'moss' as const
  const density = row.density === 'compact' ? 'compact' as const : 'comfortable' as const
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    enabled: isEnabled(row.enabled),
    mustChangePassword: isEnabled(row.mustChangePassword),
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    avatarUrl: row.avatarKey ? `/api/v1/avatars/${encodeURIComponent(row.id)}` : null,
    preferences: {
      compactNavigation: Boolean(row.compactNavigation),
      defaultLanding,
      language,
      theme,
      accent,
      density,
      reducedMotion: Boolean(row.reducedMotion),
    },
  }
}

export class AuthService {
  readonly bootstrapPath: string
  private dummyHash: string | null = null

  constructor(
    private readonly native: Database.Database,
    private readonly dataDirectory: string,
    private readonly now: () => number = Date.now,
  ) {
    this.bootstrapPath = join(dataDirectory, 'bootstrap-token')
  }

  async prepare(): Promise<void> {
    this.dummyHash = await makeDummyPasswordHash()
    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 })
    chmodSync(this.dataDirectory, 0o700)

    this.native.transaction(() => {
      const userCount = this.native.prepare('SELECT count(*) AS count FROM users').get() as { count: number }
      const state = this.native.prepare('SELECT bootstrap_hash AS bootstrapHash, bootstrap_expires_at AS bootstrapExpiresAt, bootstrap_consumed_at AS bootstrapConsumedAt, initialized_at AS initializedAt FROM auth_state WHERE id = 1').get() as BootstrapRow | undefined
      if (userCount.count > 0 || state?.initializedAt) {
        this.native.prepare('INSERT INTO auth_state (id, bootstrap_hash, bootstrap_expires_at, bootstrap_consumed_at, initialized_at) VALUES (1, NULL, NULL, NULL, ?) ON CONFLICT(id) DO UPDATE SET bootstrap_hash = NULL, bootstrap_expires_at = NULL, bootstrap_consumed_at = COALESCE(auth_state.bootstrap_consumed_at, excluded.initialized_at), initialized_at = COALESCE(auth_state.initialized_at, excluded.initialized_at)').run(nowIso(this.now()))
        this.removeBootstrapFile()
        this.ensureWorkspacePreferences()
        return
      }

      const now = this.now()
      const existingToken = this.readBootstrapToken()
      const existingStillValid = Boolean(
        state?.bootstrapHash && state.bootstrapExpiresAt && Date.parse(state.bootstrapExpiresAt) > now && existingToken,
      ) && equalDigest(state?.bootstrapHash, digest(existingToken ?? ''))
      if (existingStillValid) return

      const token = randomBytes(32).toString('base64url')
      const expiry = nowIso(now + BOOTSTRAP_TTL_MS)
      this.writeBootstrapToken(token)
      this.native.prepare('INSERT INTO auth_state (id, bootstrap_hash, bootstrap_expires_at, bootstrap_consumed_at, initialized_at) VALUES (1, ?, ?, NULL, NULL) ON CONFLICT(id) DO UPDATE SET bootstrap_hash = excluded.bootstrap_hash, bootstrap_expires_at = excluded.bootstrap_expires_at, bootstrap_consumed_at = NULL, initialized_at = NULL').run(digest(token), expiry)
    }).immediate()
  }

  getSetupRequired(): boolean {
    const state = this.native.prepare('SELECT initialized_at AS initializedAt FROM auth_state WHERE id = 1').get() as { initializedAt: string | null } | undefined
    const count = this.native.prepare('SELECT count(*) AS count FROM users').get() as { count: number }
    return count.count === 0 && !state?.initializedAt
  }

  async bootstrap(payload: { token: string; username: string; displayName: string; password: string }): Promise<SessionSecrets> {
    if (!validatePasswordBytes(payload.password)) throw new AuthFailure('bootstrap')
    const passwordHash = await hashPassword(payload.password)
    const sessionToken = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(32).toString('base64url')
    const time = nowIso(this.now())

    try {
      this.native.transaction(() => {
        const state = this.native.prepare('SELECT bootstrap_hash AS bootstrapHash, bootstrap_expires_at AS bootstrapExpiresAt, bootstrap_consumed_at AS bootstrapConsumedAt, initialized_at AS initializedAt FROM auth_state WHERE id = 1').get() as BootstrapRow | undefined
        const count = this.native.prepare('SELECT count(*) AS count FROM users').get() as { count: number }
        if (!state?.bootstrapHash || !state.bootstrapExpiresAt || state.bootstrapConsumedAt || state.initializedAt
          || Date.parse(state.bootstrapExpiresAt) <= this.now() || count.count !== 0
          || !equalDigest(state.bootstrapHash, digest(payload.token))) {
          throw new AuthFailure('bootstrap')
        }

        const userId = randomUUID()
        this.native.prepare('INSERT INTO users (id, username, username_key, display_name, role, password_hash, enabled, avatar_key, created_at, updated_at, last_login_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)')
          .run(userId, payload.username.trim(), usernameKey(payload.username), payload.displayName.trim(), 'administrator', passwordHash, time, time, time, time)
        this.native.prepare('INSERT INTO user_preferences (user_id, compact_navigation, default_landing, updated_at) VALUES (?, 0, ?, ?)').run(userId, 'dashboard', time)
        this.native.prepare('INSERT INTO workspace_preferences (id, display_name, default_landing, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run('MMSManager', 'dashboard', time)
        this.native.prepare('UPDATE auth_state SET bootstrap_hash = NULL, bootstrap_expires_at = NULL, bootstrap_consumed_at = ?, initialized_at = ? WHERE id = 1').run(time, time)
        this.createSession(userId, sessionToken, csrfToken, time)
        this.recordAudit(userId, userId, 'bootstrap.completed', 'success', time)
        this.removeBootstrapFile()
      }).immediate()
    } catch (error) {
      if (error instanceof AuthFailure) {
        if (error.code === 'bootstrap') this.setBootstrapFailure(time)
        throw error
      }
      if (this.isUniqueViolation(error)) throw new AuthFailure('conflict')
      throw error
    }
    return { sessionToken, csrfToken }
  }

  async login(username: string, password: string): Promise<SessionSecrets> {
    const row = this.native.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.username_key = ?`).get(usernameKey(username)) as UserRow | undefined
    const matches = row
      ? await verifyPassword(row.passwordHash, password)
      : await verifyPassword(this.dummyHash ?? await makeDummyPasswordHash(), password)
    const time = nowIso(this.now())
    if (!row || !matches || !isEnabled(row.enabled)) {
      this.recordAudit(null, row?.id ?? null, 'login.failed', 'failure', time)
      throw new AuthFailure('unauthorized')
    }

    const sessionToken = randomBytes(32).toString('base64url')
    const csrfToken = randomBytes(32).toString('base64url')
    this.native.transaction(() => {
      const fresh = this.native.prepare('SELECT enabled, password_changed_at AS passwordChangedAt FROM users WHERE id = ?').get(row.id) as { enabled: number | boolean; passwordChangedAt: string } | undefined
      if (!fresh || !isEnabled(fresh.enabled) || fresh.passwordChangedAt !== row.passwordChangedAt) throw new AuthFailure('unauthorized')
      this.native.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(time, time, row.id)
      this.createSession(row.id, sessionToken, csrfToken, time, isEnabled(row.mustChangePassword) ? PASSWORD_CHANGE_SESSION_MS : SESSION_ABSOLUTE_MS)
      this.recordAudit(row.id, row.id, 'login.succeeded', 'success', time)
    }).immediate()
    return { sessionToken, csrfToken }
  }

  authenticate(sessionToken: string | null): SessionPrincipal | null {
    if (!sessionToken || !COOKIE_TOKEN_PATTERN.test(sessionToken)) return null
    const tokenHash = digest(sessionToken)
    const row = this.native.prepare(`SELECT s.token_hash AS tokenHash, s.csrf_hash AS csrfHash, s.created_at AS sessionCreatedAt, s.expires_at AS expiresAt, s.last_seen_at AS sessionLastSeenAt, s.revoked_at AS revokedAt,
      u.id AS userId, u.username, u.display_name AS displayName, u.role, u.enabled, u.must_change_password AS mustChangePassword, u.avatar_key AS avatarKey, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
      COALESCE(p.compact_navigation, 0) AS compactNavigation, COALESCE(p.default_landing, 'dashboard') AS defaultLanding
      FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN user_preferences p ON p.user_id = u.id WHERE s.token_hash = ?`).get(tokenHash) as (UserRow & {
        tokenHash: string; csrfHash: string; sessionCreatedAt: string; expiresAt: string; sessionLastSeenAt: string; revokedAt: string | null; userId: string
      }) | undefined
    if (!row || row.revokedAt) return null
    const now = this.now()
    if (Date.parse(row.expiresAt) <= now || now - Date.parse(row.sessionLastSeenAt) > SESSION_IDLE_MS || !isEnabled(row.enabled)) {
      this.native.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?').run(nowIso(now), tokenHash)
      return null
    }
    if (now - Date.parse(row.sessionLastSeenAt) >= SESSION_REFRESH_MS) {
      this.native.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(now), tokenHash)
    }
    return {
      userId: row.userId,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      enabled: true,
      mustChangePassword: isEnabled(row.mustChangePassword),
      avatarKey: row.avatarKey,
      tokenHash,
      csrfHash: row.csrfHash,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
      compactNavigation: Boolean(row.compactNavigation),
      defaultLanding: row.defaultLanding === 'machine' ? 'machine' : 'dashboard',
    }
  }

  verifyCsrf(principal: SessionPrincipal, token: string | null): boolean {
    if (!token || !COOKIE_TOKEN_PATTERN.test(token)) return false
    return equalDigest(principal.csrfHash, digest(token))
  }

  getMe(principal: SessionPrincipal) {
    const user = this.getUserRow(principal.userId)
    if (!user || !isEnabled(user.enabled)) throw new AuthFailure('unauthorized')
    const time = nowIso(this.now())
    const activeSessions = this.native.prepare('SELECT token_hash AS tokenHash, created_at AS createdAt, last_seen_at AS lastSeenAt FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC')
      .all(principal.userId, time, nowIso(this.now() - SESSION_IDLE_MS)) as Array<{ tokenHash: string; createdAt: string; lastSeenAt: string }>
    const workspace = this.getWorkspace()
    return {
      user: mapUser(user),
      workspace,
      sessions: activeSessions.map((session) => ({
        id: session.tokenHash === principal.tokenHash ? 'current' : session.tokenHash.slice(0, 10),
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        current: session.tokenHash === principal.tokenHash,
      })),
    }
  }

  logout(principal: SessionPrincipal): void {
    const time = nowIso(this.now())
    this.native.transaction(() => {
      this.native.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?').run(time, principal.tokenHash)
      this.recordAudit(principal.userId, principal.userId, 'logout.succeeded', 'success', time)
    }).immediate()
  }

  async changePassword(principal: SessionPrincipal, currentPassword: string, newPassword: string): Promise<SessionSecrets | null> {
    if (!validatePasswordBytes(newPassword)) throw new AuthFailure('current-password')
    const row = this.native.prepare('SELECT password_hash AS passwordHash, must_change_password AS mustChangePassword FROM users WHERE id = ? AND enabled = 1').get(principal.userId) as { passwordHash: string; mustChangePassword: number | boolean } | undefined
    if (!row || !await verifyPassword(row.passwordHash, currentPassword)) throw new AuthFailure('current-password')
    if (await verifyPassword(row.passwordHash, newPassword)) throw new AuthFailure('same-password')
    const passwordHash = await hashPassword(newPassword)
    const time = nowIso(this.now())
    const rotateSession = isEnabled(row.mustChangePassword)
    const sessionToken = rotateSession ? randomBytes(32).toString('base64url') : null
    const csrfToken = rotateSession ? randomBytes(32).toString('base64url') : null
    this.native.transaction(() => {
      const updated = this.native.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ? AND password_hash = ?')
        .run(passwordHash, time, time, principal.userId, row.passwordHash)
      if (updated.changes !== 1) throw new AuthFailure('current-password')
      this.native.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(time, principal.userId)
      if (sessionToken && csrfToken) this.createSession(principal.userId, sessionToken, csrfToken, time)
      this.recordAudit(principal.userId, principal.userId, 'password.changed', 'success', time)
    }).immediate()
    return sessionToken && csrfToken ? { sessionToken, csrfToken } : null
  }

  updateProfile(principal: SessionPrincipal, displayName: string): void {
    const time = nowIso(this.now())
    this.native.transaction(() => {
      this.native.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(displayName.trim(), time, principal.userId)
      this.recordAudit(principal.userId, principal.userId, 'profile.updated', 'success', time)
    }).immediate()
  }

  updateUserPreferences(principal: SessionPrincipal, input: UserPreferencesUpdate): void {
    const time = nowIso(this.now())
    this.native.transaction(() => {
      const current = this.getUserRow(principal.userId)
      const preferences = {
        compactNavigation: Boolean(current?.compactNavigation),
        defaultLanding: current?.defaultLanding === 'machine' ? 'machine' : 'dashboard',
        language: current?.language === 'ru' ? 'ru' : 'en',
        theme: current?.theme === 'light' || current?.theme === 'system' ? current.theme : 'dark',
        accent: current?.accent === 'blue' || current?.accent === 'clay' ? current.accent : 'moss',
        density: current?.density === 'compact' ? 'compact' : 'comfortable',
        reducedMotion: Boolean(current?.reducedMotion),
        ...input,
      }
      this.native.prepare(`INSERT INTO user_preferences (user_id, compact_navigation, default_landing, language, theme, accent, density, reduced_motion, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET compact_navigation = excluded.compact_navigation,
        default_landing = excluded.default_landing, language = excluded.language, theme = excluded.theme, accent = excluded.accent,
        density = excluded.density, reduced_motion = excluded.reduced_motion, updated_at = excluded.updated_at`)
        .run(principal.userId, Number(preferences.compactNavigation), preferences.defaultLanding, preferences.language, preferences.theme, preferences.accent, preferences.density, Number(preferences.reducedMotion), time)
      this.recordAudit(principal.userId, principal.userId, 'profile.preferences.updated', 'success', time)
    }).immediate()
  }

  updateAvatarKey(principal: SessionPrincipal, avatarKey: string | null): void {
    const time = nowIso(this.now())
    this.native.transaction(() => {
      this.native.prepare('UPDATE users SET avatar_key = ?, updated_at = ? WHERE id = ?').run(avatarKey, time, principal.userId)
      this.recordAudit(principal.userId, principal.userId, avatarKey ? 'profile.avatar.updated' : 'profile.avatar.removed', 'success', time)
    }).immediate()
  }

  async createUser(actor: SessionPrincipal, input: { username: string; displayName: string; password: string; role: UserRole }) {
    if (!validatePasswordBytes(input.password)) throw new AuthFailure('conflict')
    if (this.native.prepare('SELECT 1 FROM users WHERE username_key = ?').get(usernameKey(input.username))) throw new AuthFailure('conflict')
    const passwordHash = await hashPassword(input.password)
    const userId = randomUUID()
    const time = nowIso(this.now())
    try {
      this.native.transaction(() => {
        if (this.native.prepare('SELECT 1 FROM users WHERE username_key = ?').get(usernameKey(input.username))) throw new AuthFailure('conflict')
        this.native.prepare('INSERT INTO users (id, username, username_key, display_name, role, password_hash, enabled, must_change_password, avatar_key, created_at, updated_at, last_login_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, NULL, ?, ?, NULL, ?)')
          .run(userId, input.username.trim(), usernameKey(input.username), input.displayName.trim(), input.role, passwordHash, time, time, time)
        this.native.prepare('INSERT INTO user_preferences (user_id, compact_navigation, default_landing, updated_at) VALUES (?, 0, ?, ?)').run(userId, 'dashboard', time)
        this.recordAudit(actor.userId, userId, 'user.created', 'success', time)
      }).immediate()
    } catch (error) {
      if (error instanceof AuthFailure) throw error
      if (this.isUniqueViolation(error)) throw new AuthFailure('conflict')
      throw error
    }
    return this.adminUser(userId)
  }

  listUsers() {
    const rows = this.native.prepare(`SELECT ${USER_COLUMNS}, COALESCE(p.compact_navigation, 0) AS compactNavigation, COALESCE(p.default_landing, 'dashboard') AS defaultLanding,
      COALESCE(p.language, 'en') AS language, COALESCE(p.theme, 'dark') AS theme, COALESCE(p.accent, 'moss') AS accent,
      COALESCE(p.density, 'comfortable') AS density, COALESCE(p.reduced_motion, 0) AS reducedMotion,
      (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ? AND s.last_seen_at > ?) AS activeSessionCount
      FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id ORDER BY u.created_at, u.username_key`)
      .all(nowIso(this.now()), nowIso(this.now() - SESSION_IDLE_MS)) as Array<UserRow & { activeSessionCount: number }>
    return { users: rows.map((row) => ({ ...mapUser(row), activeSessionCount: row.activeSessionCount })) }
  }

  updateUser(actor: SessionPrincipal, targetId: string, input: { role: UserRole; enabled: boolean }): void {
    const time = nowIso(this.now())
    this.native.transaction(() => {
      const target = this.native.prepare('SELECT role, enabled FROM users WHERE id = ?').get(targetId) as { role: UserRole; enabled: number | boolean } | undefined
      if (!target) throw new AuthFailure('not-found')
      if (isEnabled(target.enabled) && target.role === 'administrator' && (!input.enabled || input.role !== 'administrator')) {
        const count = this.native.prepare("SELECT count(*) AS count FROM users WHERE enabled = 1 AND role = 'administrator'").get() as { count: number }
        if (count.count <= 1) throw new AuthFailure('locked')
      }
      if (!input.enabled && targetId === actor.userId) {
        const count = this.native.prepare("SELECT count(*) AS count FROM users WHERE enabled = 1 AND role = 'administrator'").get() as { count: number }
        if (target.role === 'administrator' && count.count > 1) throw new AuthFailure('locked')
      }
      this.native.prepare('UPDATE users SET role = ?, enabled = ?, updated_at = ? WHERE id = ?').run(input.role, Number(input.enabled), time, targetId)
      if (!input.enabled || target.role !== input.role || !isEnabled(target.enabled)) {
        this.native.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(time, targetId)
      }
      const action = target.role !== input.role ? 'user.role.changed' : isEnabled(target.enabled) !== input.enabled ? (input.enabled ? 'user.enabled' : 'user.disabled') : 'user.updated'
      this.recordAudit(actor.userId, targetId, action, 'success', time)
    }).immediate()
  }

  deleteUser(actor: SessionPrincipal, targetId: string, confirmation: string): { avatarKey: string | null } {
    if (targetId === actor.userId) throw new AuthFailure('locked')
    const time = nowIso(this.now())
    return this.native.transaction(() => {
      const target = this.native.prepare('SELECT id, username, role, enabled, avatar_key AS avatarKey FROM users WHERE id = ?')
        .get(targetId) as { id: string; username: string; role: UserRole; enabled: number | boolean; avatarKey: string | null } | undefined
      if (!target) throw new AuthFailure('not-found')
      if (confirmation !== target.username) throw new AuthFailure('confirmation')
      if (isEnabled(target.enabled) && target.role === 'administrator') {
        const count = this.native.prepare("SELECT count(*) AS count FROM users WHERE enabled = 1 AND role = 'administrator'").get() as { count: number }
        if (count.count <= 1) throw new AuthFailure('locked')
      }
      this.recordAudit(actor.userId, targetId, 'user.deleted', 'success', time)
      const deleted = this.native.prepare('DELETE FROM users WHERE id = ?').run(targetId)
      if (deleted.changes !== 1) throw new AuthFailure('not-found')
      return { avatarKey: target.avatarKey }
    }).immediate()
  }

  async resetUserPassword(actor: SessionPrincipal, targetId: string, password: string): Promise<void> {
    if (!validatePasswordBytes(password)) throw new AuthFailure('conflict')
    const passwordHash = await hashPassword(password)
    const time = nowIso(this.now())
    this.native.transaction(() => {
      const target = this.native.prepare('SELECT id FROM users WHERE id = ?').get(targetId) as { id: string } | undefined
      if (!target) throw new AuthFailure('not-found')
      this.native.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = ?, updated_at = ? WHERE id = ?').run(passwordHash, time, time, targetId)
      this.native.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(time, targetId)
      this.recordAudit(actor.userId, targetId, 'user.password.reset', 'success', time)
    }).immediate()
  }

  async recoverAdministrator(username: string, password: string): Promise<void> {
    if (!validatePasswordBytes(password)) throw new AuthFailure('conflict')
    const key = usernameKey(username)
    const target = this.native.prepare('SELECT id FROM users WHERE username_key = ?').get(key) as { id: string } | undefined
    if (!target) throw new AuthFailure('not-found')
    const passwordHash = await hashPassword(password)
    const time = nowIso(this.now())
    this.native.transaction(() => {
      const current = this.native.prepare('SELECT id FROM users WHERE id = ?').get(target.id) as { id: string } | undefined
      if (!current) throw new AuthFailure('not-found')
      this.native.prepare("UPDATE users SET role = 'administrator', enabled = 1, password_hash = ?, must_change_password = 1, password_changed_at = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, time, time, target.id)
      this.native.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?').run(time, target.id)
      this.recordAudit(null, target.id, 'admin.recovered', 'success', time)
    }).immediate()
  }

  getWorkspace() {
    const row = this.native.prepare('SELECT display_name AS displayName, default_landing AS defaultLanding FROM workspace_preferences WHERE id = 1').get() as { displayName: string; defaultLanding: LandingPage } | undefined
    return { displayName: row?.displayName ?? 'MMSManager', defaultLanding: row?.defaultLanding === 'machine' ? 'machine' as const : 'dashboard' as const }
  }

  updateWorkspace(actor: SessionPrincipal, input: { displayName: string; defaultLanding: LandingPage }): void {
    const time = nowIso(this.now())
    this.native.transaction(() => {
      this.native.prepare('INSERT INTO workspace_preferences (id, display_name, default_landing, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, default_landing = excluded.default_landing, updated_at = excluded.updated_at')
        .run(input.displayName.trim(), input.defaultLanding, time)
      this.recordAudit(actor.userId, null, 'workspace.preferences.updated', 'success', time)
    }).immediate()
  }

  setBootstrapFailure(time = nowIso(this.now())): void {
    this.recordAudit(null, null, 'bootstrap.failed', 'failure', time)
  }

  listAuditEvents() {
    const rows = this.native.prepare(`SELECT e.id, e.action, e.outcome, e.occurred_at AS occurredAt, a.username AS actor, s.username AS subject
      FROM security_audit_events e LEFT JOIN users a ON a.id = e.actor_user_id LEFT JOIN users s ON s.id = e.subject_user_id
      ORDER BY e.id DESC LIMIT 50`).all() as Array<{ id: number; action: string; outcome: 'success' | 'failure'; occurredAt: string; actor: string | null; subject: string | null }>
    return { events: rows.map((row) => ({ ...row, actor: row.actor ?? (row.action.startsWith('bootstrap') ? 'System' : null) })) }
  }

  findUserAvatar(userId: string): string | null {
    const row = this.native.prepare('SELECT avatar_key AS avatarKey FROM users WHERE id = ?').get(userId) as { avatarKey: string | null } | undefined
    return row?.avatarKey ?? null
  }

  private getUserRow(userId: string): UserRow | undefined {
    return this.native.prepare(`SELECT ${USER_COLUMNS}, COALESCE(p.compact_navigation, 0) AS compactNavigation, COALESCE(p.default_landing, 'dashboard') AS defaultLanding,
      COALESCE(p.language, 'en') AS language, COALESCE(p.theme, 'dark') AS theme, COALESCE(p.accent, 'moss') AS accent,
      COALESCE(p.density, 'comfortable') AS density, COALESCE(p.reduced_motion, 0) AS reducedMotion
      FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = ?`).get(userId) as UserRow | undefined
  }

  private adminUser(userId: string) {
    const row = this.native.prepare(`SELECT ${USER_COLUMNS}, COALESCE(p.compact_navigation, 0) AS compactNavigation, COALESCE(p.default_landing, 'dashboard') AS defaultLanding,
      COALESCE(p.language, 'en') AS language, COALESCE(p.theme, 'dark') AS theme, COALESCE(p.accent, 'moss') AS accent,
      COALESCE(p.density, 'comfortable') AS density, COALESCE(p.reduced_motion, 0) AS reducedMotion,
      (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ? AND s.last_seen_at > ?) AS activeSessionCount
      FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = ?`).get(nowIso(this.now()), nowIso(this.now() - SESSION_IDLE_MS), userId) as (UserRow & { activeSessionCount: number }) | undefined
    if (!row) throw new AuthFailure('not-found')
    return { ...mapUser(row), activeSessionCount: row.activeSessionCount }
  }

  private createSession(userId: string, sessionToken: string, csrfToken: string, createdAt: string, ttlMs = SESSION_ABSOLUTE_MS): void {
    this.native.prepare('INSERT INTO sessions (token_hash, csrf_hash, user_id, created_at, expires_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(digest(sessionToken), digest(csrfToken), userId, createdAt, nowIso(Date.parse(createdAt) + Math.min(ttlMs, SESSION_ABSOLUTE_MS)), createdAt)
  }

  private ensureWorkspacePreferences(): void {
    const time = nowIso(this.now())
    this.native.prepare('INSERT INTO workspace_preferences (id, display_name, default_landing, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run('MMSManager', 'dashboard', time)
  }

  private recordAudit(actorId: string | null, subjectId: string | null, action: string, outcome: 'success' | 'failure', time: string): void {
    this.native.prepare('INSERT INTO security_audit_events (actor_user_id, subject_user_id, action, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)')
      .run(actorId, subjectId, action, outcome, time)
  }

  private readBootstrapToken(): string | null {
    if (!existsSync(this.bootstrapPath)) return null
    try {
      const value = readFileSync(this.bootstrapPath, 'utf8').trim()
      return COOKIE_TOKEN_PATTERN.test(value) ? value : null
    } catch {
      return null
    }
  }

  private writeBootstrapToken(token: string): void {
    const temporaryPath = `${this.bootstrapPath}.${randomBytes(8).toString('hex')}.tmp`
    const descriptor = openSync(temporaryPath, 'wx', 0o600)
    try {
      writeFileSync(descriptor, `${token}\n`, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporaryPath, this.bootstrapPath)
    chmodSync(this.bootstrapPath, 0o600)
  }

  private removeBootstrapFile(): void {
    try { unlinkSync(this.bootstrapPath) } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT'))
  }
}
