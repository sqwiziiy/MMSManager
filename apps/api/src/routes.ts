import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import {
  adminUsersSchema,
  auditRecordsSchema,
  activityQuerySchema,
  activityResponseSchema,
  notificationsResponseSchema,
  notificationEventIdParamSchema,
  authMeSchema,
  bootstrapSchema,
  calendarQuerySchema,
  dateParamSchema,
  historyQuerySchema,
  loginSchema,
  machineCalendarSchema,
  machineCurrentSchema,
  machineDaySchema,
  machineHistorySchema,
  installCatalogQuerySchema,
  installCatalogSchema,
  installOperationIdSchema,
  installOperationListSchema,
  installOperationResultSchema,
  localServerListSchema,
  localServerIdSchema,
  serverCommandSchema,
  serverConsoleQuerySchema,
  serverConsoleResponseSchema,
  serverRuntimeResultSchema,
  serverRuntimeSettingsResultSchema,
  serverRuntimeSettingsUpdateSchema,
  serverStatusResultSchema,
  serverPlayerListResultSchema,
  serverPlayerActionRequestSchema,
  serverPlayerActionResultSchema,
  serverModsInventoryResultSchema,
  serverPropertiesResultSchema,
  serverPropertiesUpdateRequestSchema,
  serverPropertiesBackupIdParamSchema,
  serverPropertiesRestorePreviewResultSchema,
  serverPropertiesRestoreRequestSchema,
  serverPropertiesRestoreResultSchema,
  serverFileCreateSchema,
  serverFileIdParamSchema,
  serverFileListSchema,
  serverFileMoveSchema,
  serverFilePathQuerySchema,
  serverFileReadQuerySchema,
  serverFileReadSchema,
  serverFileRecoveryListSchema,
  serverFileRecoveryRestoreSchema,
  serverFileTrashListSchema,
  serverFileTrashRestoreSchema,
  serverFileWriteSchema,
  serverWorldsResultSchema,
  serverBackupsResultSchema,
  serverBackupCreateResultSchema,
  serverBackupIdParamSchema,
  serverBackupPreviewResultSchema,
  serverBackupRestoreRequestSchema,
  serverBackupRestoreResultSchema,
  serverAutomationResultSchema,
  serverAutomationUpdateSchema,
  serverAutomationJobIdParamSchema,
  serverHistoryCalendarQuerySchema,
  serverHistoryCalendarResultSchema,
  serverHistoryDayQuerySchema,
  serverHistoryDayResultSchema,
  javaProbeRequestSchema,
  javaRuntimeListSchema,
  javaRuntimeSchema,
  passwordChangeSchema,
  profileUpdateSchema,
  publicHealthSchema,
  userCreateSchema,
  userIdParamSchema,
  userPasswordResetSchema,
  userPreferencesSchema,
  userUpdateSchema,
  workspacePreferencesSchema,
  serverImportPreviewSchema,
  serverImportResultSchema,
  serverImportRegistrationSchema,
  serverMetadataUpdateSchema,
  serverImportRequestSchema,
  serverInventorySchema,
  serverInstallRequestSchema,
  serverTemplateIdParamSchema,
  serverTemplateInputSchema,
  serverTemplateListSchema,
  serverTemplateResultSchema,
} from '@mmsmanager/shared'
import { API_HOST, WEB_ORIGIN } from './config.js'
import type { AppDatabase } from './db/client.js'
import type { MachineCollector } from './machine/collector.js'
import { MachineHistoryService } from './machine/history.js'
import { validateCalendarDate } from './time.js'
import { AuthFailure, AuthService } from './auth/service.js'
import type { SessionPrincipal } from './auth/service.js'
import { AvatarStore, InvalidAvatarError, MAX_AVATAR_BYTES } from './auth/avatar-store.js'
import { JavaRuntimeError, JavaRuntimeRegistry } from './servers/java.js'
import { ServerInventoryError, ServerRegistry } from './servers/registry.js'
import { ServerInstallError, ServerInstallService } from './servers/install.js'
import { ServerProcessError, ServerProcessManager } from './servers/processes.js'
import { ServerPropertiesError, ServerPropertiesManager } from './servers/properties.js'
import { ServerStatusError, ServerStatusService } from './servers/status.js'
import { MAX_MOD_JAR_BYTES, ServerModsError, ServerModsService } from './servers/mods.js'
import { MAX_SERVER_FILE_UPLOAD_BYTES, ServerFileService, ServerFilesError } from './servers/files.js'
import { ServerWorldService, ServerWorldsError } from './servers/worlds.js'
import { ServerHistoryService } from './servers/history.js'
import { ServerBackupError, ServerBackupService } from './servers/backups.js'
import { ServerAutomationError, ServerAutomationService } from './servers/automation.js'
import { ServerRuntimeSettingsError, ServerRuntimeSettingsService } from './servers/runtime.js'
import { ActivityFeedError, ActivityFeedService } from './activity/feed.js'
import { ServerTemplateError, ServerTemplateService } from './servers/templates.js'
import { NotificationError, NotificationService } from './activity/notifications.js'

class InvalidRequestError extends Error {}

declare module 'fastify' {
  interface FastifyRequest {
    principal: SessionPrincipal | null
  }
}

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new InvalidRequestError('Invalid request parameters')
  return parsed.data
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  const cookieHeader = request.headers.cookie
  if (!cookieHeader) return null
  for (const segment of cookieHeader.split(';')) {
    const [key, ...value] = segment.trim().split('=')
    if (key === name) return value.join('=') || null
  }
  return null
}

function requestHostAllowed(host: string | undefined, webOrigin: string, apiPort: number): boolean {
  if (!host) return false
  const normalized = host.toLowerCase()
  const webPort = new URL(webOrigin).port || '80'
  const allowed = new Set([
    '127.0.0.1', 'localhost', 'localhost:80', '127.0.0.1:80',
    `127.0.0.1:${apiPort}`, `localhost:${apiPort}`,
    `127.0.0.1:${webPort}`, `localhost:${webPort}`,
  ])
  return allowed.has(normalized)
}

function equalText(left: string | null, right: string | null): boolean {
  if (!left || !right) return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

function nestedStatusCode(error: unknown): number | null {
  let value: unknown = error
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (record['code'] === 'FST_ERR_RATE_LIMIT' || record['code'] === 'RATE_LIMITED') return 429
    const statusCode = Number(record['statusCode'])
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) return statusCode
    value = record['error']
  }
  return null
}

function addSessionCookies(reply: FastifyReply, sessionToken: string, csrfToken: string, secure: boolean): void {
  const secureAttribute = secure ? '; Secure' : ''
  reply.header('set-cookie', [
    `mmsmanager_session=${sessionToken}; Path=/api; Max-Age=604800; HttpOnly; SameSite=Strict${secureAttribute}`,
    `mmsmanager_csrf=${csrfToken}; Path=/; Max-Age=604800; SameSite=Strict${secureAttribute}`,
  ])
}

function clearSessionCookies(reply: FastifyReply, secure: boolean): void {
  const secureAttribute = secure ? '; Secure' : ''
  reply.header('set-cookie', [
    `mmsmanager_session=; Path=/api; Max-Age=0; HttpOnly; SameSite=Strict${secureAttribute}`,
    `mmsmanager_csrf=; Path=/; Max-Age=0; SameSite=Strict${secureAttribute}`,
  ])
}

function respondAuthFailure(error: unknown, reply: FastifyReply): boolean {
  if (!(error instanceof AuthFailure)) return false
  if (error.code === 'unauthorized' || error.code === 'bootstrap') {
    reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: error.code === 'bootstrap' ? 'The one-time setup credential is invalid or expired.' : 'Username or password is incorrect.' } })
    return true
  }
  if (error.code === 'forbidden') {
    reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Administrator access is required.' } })
    return true
  }
  if (error.code === 'not-found') {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'The requested account was not found.' } })
    return true
  }
  if (error.code === 'locked') {
    reply.code(409).send({ error: { code: 'LAST_ADMIN', message: 'This change would remove the last enabled administrator.' } })
    return true
  }
  if (error.code === 'current-password') {
    reply.code(400).send({ error: { code: 'CURRENT_PASSWORD', message: 'The current password could not be verified.' } })
    return true
  }
  reply.code(409).send({ error: { code: 'CONFLICT', message: 'This change conflicts with an existing account.' } })
  return true
}

export async function createApiApp(options: {
  db: AppDatabase
  collector: MachineCollector
  timeZone: string
  auth: AuthService
  avatars: AvatarStore
  servers: ServerRegistry
  javaRuntimes: JavaRuntimeRegistry
  processes?: ServerProcessManager
  webOrigin?: string
  apiPort?: number
  secureCookies?: boolean
  rateLimitMax?: number
  installFetch?: typeof fetch
  now?: () => number
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false })
  const history = new MachineHistoryService(options.db, options.timeZone, options.now)
  const activity = new ActivityFeedService(options.db)
  const notifications = new NotificationService(options.db, activity, options.now)
  const templates = new ServerTemplateService(options.db, options.now)
  const installs = new ServerInstallService(options.db, options.servers, options.javaRuntimes, options.installFetch ? { fetch: options.installFetch } : {})
  await installs.prepare()
  const processes = options.processes ?? new ServerProcessManager(options.db, options.servers, options.now)
  await processes.prepare()
  const runtimeSettings = new ServerRuntimeSettingsService(options.db, options.servers, processes, options.javaRuntimes, options.now)
  const properties = new ServerPropertiesManager(options.db, options.servers, options.now)
  const serverStatus = new ServerStatusService(options.db, options.now)
  const mods = new ServerModsService(options.db, options.servers, processes, options.now)
  const files = new ServerFileService(options.db, options.servers, processes, options.now)
  const backups = new ServerBackupService(options.db, options.servers, processes, options.now)
  await backups.prepare()
  const automation = new ServerAutomationService(options.db, backups, options.timeZone, options.now)
  await automation.prepare()
  app.addHook('onReady', async () => { automation.start() })
  app.addHook('onClose', async () => { await automation.stop() })
  const worlds = new ServerWorldService(options.db, options.servers, backups)
  const serverHistory = new ServerHistoryService(options.db, options.timeZone, options.now)
  const webOrigin = options.webOrigin ?? WEB_ORIGIN
  const apiPort = options.apiPort ?? 4174
  const secureCookies = options.secureCookies ?? false
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === webOrigin),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-mms-csrf'],
    credentials: true,
    maxAge: 600,
  })
  await app.register(rateLimit, {
    global: true,
    max: options.rateLimitMax ?? 600,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } }),
  })
  await app.register(multipart, {
    limits: { fields: 0, files: 1, parts: 1, fileSize: MAX_MOD_JAR_BYTES, headerPairs: 100 },
  })

  app.decorateRequest('principal', null)
  app.addHook('onRequest', async (request, reply) => {
    if (!requestHostAllowed(request.headers.host, webOrigin, apiPort)) {
      return reply.code(400).send({ error: { code: 'BAD_HOST', message: 'The local API host is not allowed.' } })
    }
    const origin = request.headers.origin
    if (origin !== undefined && origin !== webOrigin) {
      return reply.code(403).send({ error: { code: 'BAD_ORIGIN', message: 'This request origin is not allowed.' } })
    }
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
      if (origin !== webOrigin) return reply.code(403).send({ error: { code: 'ORIGIN_REQUIRED', message: 'A same-origin request is required.' } })
      const fetchSite = request.headers['sec-fetch-site']
      if (fetchSite && fetchSite !== 'same-origin') return reply.code(403).send({ error: { code: 'CROSS_SITE', message: 'Cross-site requests are not allowed.' } })
      const contentType = request.headers['content-type']?.toLowerCase() ?? ''
      const isAvatarUpload = request.url === '/api/v1/profile/avatar' && request.method === 'POST'
      const isModUpload = /^\/api\/v1\/admin\/servers\/[0-9a-f-]{36}\/mods$/.test(request.url) && request.method === 'POST'
      const expectsMultipart = isAvatarUpload || isModUpload
      if (expectsMultipart ? !contentType.startsWith('multipart/form-data;') : request.method !== 'DELETE' && !contentType.startsWith('application/json')) {
        return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The request content type is not supported.' } })
      }
    }
  })
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    return payload
  })

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const principal = options.auth.authenticate(cookieValue(request, 'mmsmanager_session'))
    if (!principal) {
      clearSessionCookies(reply, secureCookies)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } })
    }
    request.principal = principal
  }
  const requireMutationAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(request, reply)
    if (!request.principal) return
    const cookieToken = cookieValue(request, 'mmsmanager_csrf')
    const headerValue = request.headers['x-mms-csrf']
    const headerToken = Array.isArray(headerValue) ? headerValue[0] ?? null : headerValue ?? null
    if (!equalText(cookieToken, headerToken) || !options.auth.verifyCsrf(request.principal, headerToken)) {
      return reply.code(403).send({ error: { code: 'CSRF_REJECTED', message: 'The request security check failed.' } })
    }
  }
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(request, reply)
    if (!request.principal) return
    if (request.principal.role !== 'administrator') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Administrator access is required.' } })
    }
  }
  const requireAdminMutation = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireMutationAuth(request, reply)
    if (!request.principal) return
    if (request.principal.role !== 'administrator') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Administrator access is required.' } })
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof NotificationError) return reply.code(404).send({ error: { code: error.code, message: error.message } })
    if (error instanceof ActivityFeedError) return reply.code(400).send({ error: { code: error.code, message: error.message } })
    if (error instanceof ServerTemplateError) {
      const status = error.code === 'TEMPLATE_NOT_FOUND' ? 404 : 409
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerStatusError) return reply.code(404).send({ error: { code: error.code, message: error.message } })
    if (error instanceof ServerProcessError) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404
        : error.code.includes('TIMEOUT') ? 504
          : error.code.endsWith('_CONFLICT') || error.code.includes('ALREADY') || error.code.includes('STILL_RUNNING') || error.code.includes('RATE_LIMITED') || error.code.endsWith('_NOT_RUNNING') || error.code.endsWith('_BUSY') || error.code.endsWith('_NOT_STOPPED') || error.code.includes('RECOVERY_REQUIRED') || error.code === 'PROCESS_NOT_OWNED' || error.code === 'SERVER_NOT_PANEL_MANAGED' || error.code === 'RESTART_NOT_RUNNING' ? 409
          : error.code.includes('UNAVAILABLE') ? 503 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerRuntimeSettingsError) {
      const status = error.code === 'SERVER_NOT_FOUND' ? 404
        : error.code.endsWith('_BUSY') || error.code.includes('INCOMPATIBLE') || error.code.includes('NOT_PANEL_MANAGED') || error.code.includes('PATH_UNSAFE') ? 409
          : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerAutomationError) {
      const status = error.code === 'SERVER_NOT_FOUND' || error.code === 'AUTOMATION_JOB_NOT_FOUND' ? 404
        : error.code.includes('NOT_PANEL_MANAGED') || error.code.includes('NOT_ACKNOWLEDGEABLE') ? 409 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerBackupError) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404
        : error.code.includes('TOO_LARGE') || error.code.includes('_LIMIT') ? 413
          : error.code.includes('CONFLICT') || error.code.includes('CONFIRMATION_FAILED') || error.code.includes('NOT_STOPPED') || error.code.includes('NOT_MANAGED') || error.code.includes('UNSAFE') || error.code.includes('CHECKSUM') || error.code.includes('MISMATCH') || error.code.includes('RECOVERY_REQUIRED') || error.code === 'BACKUP_QUOTA_EXCEEDED' || error.code === 'SERVER_CHANGED_DURING_BACKUP' || error.code === 'BACKUP_INTERRUPTED' ? 409
            : error.code.includes('DISK_SPACE') || error.code.includes('UNAVAILABLE') ? 503
              : error.code.includes('TIMEOUT') ? 504
                : ['BACKUP_FAILED', 'BACKUP_READ_FAILED', 'BACKUP_WRITE_FAILED', 'BACKUP_CLEANUP_FAILED', 'RESTORE_FAILED', 'RESTORE_ROLLBACK_FAILED'].includes(error.code) ? 500 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerPropertiesError) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404
        : error.code.endsWith('_BUSY') || error.code.includes('_CONFLICT') || error.code.includes('_CHECKSUM_FAILED') || error.code.includes('_ROLLBACK_FAILED') || error.code.startsWith('ONLINE_MODE_') ? 409
          : error.code.endsWith('_UNAVAILABLE') ? 503 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerModsError) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404
        : error.code.includes('DUPLICATE') || error.code.endsWith('_BUSY') || error.code === 'SERVER_NOT_PANEL_MANAGED' || error.code === 'MODS_UNSUPPORTED' || error.code === 'PROCESS_NOT_OWNED' ? 409
          : error.code.includes('TOO_LARGE') ? 413
            : error.code.includes('UNAVAILABLE') ? 503 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerFilesError) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404
        : error.code.includes('CONFLICT') || error.code.includes('ALREADY_EXISTS') || error.code.includes('BUSY') || error.code.includes('PROTECTED') || error.code.includes('UNSAFE') || error.code.includes('NOT_PANEL_MANAGED') ? 409
          : error.code.includes('TOO_LARGE') ? 413
            : error.code.includes('UNAVAILABLE') ? 503 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerWorldsError) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404
        : error.code.includes('UNSAFE') || error.code.includes('REJECTED') ? 409 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerInstallError) {
      const status = error.code === 'INSTALL_LIMIT' || error.code === 'INSTALL_NOT_RUNNING' ? 409
        : error.code === 'INSTALL_NOT_FOUND' ? 404
          : error.code.endsWith('_UNAVAILABLE') || error.code === 'PROVIDER_UNAVAILABLE' ? 502
            : error.code === 'PAPER_CONTACT_REQUIRED' ? 503 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerInventoryError) {
      const duplicate = error.code === 'duplicate'
      const status = duplicate ? 409 : error.code === 'not-found' ? 404 : 400
      return reply.code(status).send({
        error: { code: duplicate ? 'SERVER_ALREADY_REGISTERED' : error.code === 'not-found' ? 'SERVER_NOT_FOUND' : 'SERVER_PATH_REJECTED', message: error.message },
      })
    }
    if (error instanceof JavaRuntimeError) {
      return reply.code(400).send({ error: { code: 'JAVA_RUNTIME_REJECTED', message: error.message } })
    }
    if (error instanceof InvalidRequestError || error instanceof RangeError) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'The request payload is invalid.' } })
    }
    if (error instanceof InvalidAvatarError) {
      const status = error.reason === 'size' ? 413 : 400
      return reply.code(status).send({ error: { code: 'INVALID_AVATAR', message: 'Upload a PNG, JPEG or WebP image no larger than 1 MiB and 1024 pixels per side.' } })
    }
    const statusCode = nestedStatusCode(error)
    if (statusCode === 413) return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' } })
    if (statusCode === 429) return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } })
    if (statusCode === 415) return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The request content type is not supported.' } })
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'The local data request failed.' } })
  })

  app.get('/api/v1/health', async () => publicHealthSchema.parse({
    service: 'mmsmanager-local-api', status: 'ok', setupRequired: options.auth.getSetupRequired(),
  }))

  app.post('/api/v1/auth/setup', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const input = parse(bootstrapSchema, request.body)
    try {
      const session = await options.auth.bootstrap(input)
      addSessionCookies(reply, session.sessionToken, session.csrfToken, secureCookies || request.protocol === 'https')
      return reply.code(201).send({ ok: true })
    } catch (error) {
      if (respondAuthFailure(error, reply)) return reply
      throw error
    }
  })

  app.post('/api/v1/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const input = parse(loginSchema, request.body)
    try {
      const session = await options.auth.login(input.username, input.password)
      addSessionCookies(reply, session.sessionToken, session.csrfToken, secureCookies || request.protocol === 'https')
      return reply.send({ ok: true })
    } catch (error) {
      if (respondAuthFailure(error, reply)) return reply
      throw error
    }
  })

  app.get('/api/v1/auth/me', { preHandler: requireAuth }, async (request) => authMeSchema.parse(options.auth.getMe(request.principal!)))
  app.post('/api/v1/auth/logout', { preHandler: requireMutationAuth }, async (request, reply) => {
    options.auth.logout(request.principal!)
    clearSessionCookies(reply, secureCookies || request.protocol === 'https')
    return reply.send({ ok: true })
  })
  app.post('/api/v1/auth/change-password', { preHandler: requireMutationAuth }, async (request, reply) => {
    const input = parse(passwordChangeSchema, request.body)
    try {
      await options.auth.changePassword(request.principal!, input.currentPassword, input.newPassword)
      clearSessionCookies(reply, secureCookies || request.protocol === 'https')
      return reply.send({ ok: true, signInAgain: true })
    } catch (error) {
      if (respondAuthFailure(error, reply)) return reply
      throw error
    }
  })

  app.patch('/api/v1/profile', { preHandler: requireMutationAuth }, async (request) => {
    const input = parse(profileUpdateSchema, request.body)
    options.auth.updateProfile(request.principal!, input.displayName)
    return authMeSchema.parse(options.auth.getMe(request.principal!))
  })
  app.patch('/api/v1/profile/preferences', { preHandler: requireMutationAuth }, async (request) => {
    const input = parse(userPreferencesSchema, request.body)
    options.auth.updateUserPreferences(request.principal!, input)
    return authMeSchema.parse(options.auth.getMe(request.principal!))
  })
  app.post('/api/v1/profile/avatar', { preHandler: requireMutationAuth }, async (request) => {
    const part = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_AVATAR_BYTES } })
    if (!part) throw new InvalidAvatarError('format')
    const buffer = await part.toBuffer()
    if (part.file.truncated) throw new InvalidAvatarError('size')
    const previous = options.auth.findUserAvatar(request.principal!.userId)
    const next = await options.avatars.save(buffer)
    try {
      options.auth.updateAvatarKey(request.principal!, next)
    } catch (error) {
      await options.avatars.remove(next)
      throw error
    }
    await options.avatars.remove(previous)
    return authMeSchema.parse(options.auth.getMe(request.principal!))
  })
  app.delete('/api/v1/profile/avatar', { preHandler: requireMutationAuth }, async (request) => {
    const previous = options.auth.findUserAvatar(request.principal!.userId)
    options.auth.updateAvatarKey(request.principal!, null)
    await options.avatars.remove(previous)
    return authMeSchema.parse(options.auth.getMe(request.principal!))
  })
  app.get('/api/v1/avatars/:userId', { preHandler: requireAuth }, async (request, reply) => {
    const params = parse(userIdParamSchema, request.params)
    if (request.principal!.role !== 'administrator' && request.principal!.userId !== params.userId) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'The requested image was not found.' } })
    }
    const key = options.auth.findUserAvatar(params.userId)
    const image = key ? await options.avatars.read(key) : null
    if (!image) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'The requested image was not found.' } })
    return reply.type('image/webp').header('cache-control', 'private, no-store').send(image)
  })

  app.get('/api/v1/admin/users', { preHandler: requireAdmin }, async () => adminUsersSchema.parse(options.auth.listUsers()))
  app.post('/api/v1/admin/users', { preHandler: requireAdminMutation }, async (request, reply) => {
    const input = parse(userCreateSchema, request.body)
    try {
      return reply.code(201).send({ user: await options.auth.createUser(request.principal!, input) })
    } catch (error) {
      if (respondAuthFailure(error, reply)) return reply
      throw error
    }
  })
  app.patch('/api/v1/admin/users/:userId', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(userIdParamSchema, request.params)
    const input = parse(userUpdateSchema, request.body)
    try {
      options.auth.updateUser(request.principal!, params.userId, input)
      return reply.send({ user: options.auth.listUsers().users.find((user) => user.id === params.userId) ?? null })
    } catch (error) {
      if (respondAuthFailure(error, reply)) return reply
      throw error
    }
  })
  app.post('/api/v1/admin/users/:userId/password', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(userIdParamSchema, request.params)
    const input = parse(userPasswordResetSchema, request.body)
    try {
      await options.auth.resetUserPassword(request.principal!, params.userId, input.password)
      return reply.send({ ok: true })
    } catch (error) {
      if (respondAuthFailure(error, reply)) return reply
      throw error
    }
  })
  app.get('/api/v1/admin/workspace', { preHandler: requireAdmin }, async () => workspacePreferencesSchema.parse(options.auth.getWorkspace()))
  app.patch('/api/v1/admin/workspace', { preHandler: requireAdminMutation }, async (request) => {
    const input = parse(workspacePreferencesSchema, request.body)
    options.auth.updateWorkspace(request.principal!, input)
    return workspacePreferencesSchema.parse(options.auth.getWorkspace())
  })
  app.get('/api/v1/admin/audit', { preHandler: requireAdmin }, async () => auditRecordsSchema.parse(options.auth.listAuditEvents()))

  app.get('/api/v1/templates', { preHandler: requireAuth }, async () => serverTemplateListSchema.parse({ templates: templates.list() }))
  app.post('/api/v1/admin/templates', { preHandler: requireAdminMutation }, async (request, reply) => {
    const input = parse(serverTemplateInputSchema, request.body)
    const template = templates.create(input, request.principal!.userId)
    return reply.code(201).send(serverTemplateResultSchema.parse({ template }))
  })
  app.patch('/api/v1/admin/templates/:templateId', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(serverTemplateIdParamSchema, request.params)
    const input = parse(serverTemplateInputSchema, request.body)
    return serverTemplateResultSchema.parse({ template: templates.update(params.templateId, input, request.principal!.userId) })
  })
  app.post('/api/v1/admin/templates/:templateId/duplicate', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(serverTemplateIdParamSchema, request.params)
    const template = templates.duplicate(params.templateId, request.principal!.userId)
    return reply.code(201).send(serverTemplateResultSchema.parse({ template }))
  })
  app.delete('/api/v1/admin/templates/:templateId', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(serverTemplateIdParamSchema, request.params)
    templates.delete(params.templateId, request.principal!.userId)
    return reply.code(204).send()
  })

  app.get('/api/v1/admin/servers', { preHandler: requireAdmin }, async () => serverInventorySchema.parse({
    servers: await options.servers.list(),
    managedRoot: options.servers.managedRoot,
    importRoots: options.servers.importRoots,
  }))
  app.get('/api/v1/servers', { preHandler: requireAuth }, async () => {
    const statuses = processes.listPublicStatuses()
    return localServerListSchema.parse({
      servers: (await options.servers.listPublic()).map((server) => ({ ...server, runtimeStatus: statuses.get(server.id) ?? 'unavailable' })),
    })
  })
  app.post('/api/v1/admin/servers/import/inspect', { preHandler: requireAdminMutation }, async (request) => {
    const input = parse(serverImportRequestSchema, request.body)
    return serverImportPreviewSchema.parse(await options.servers.inspect(input.path))
  })
  app.post('/api/v1/admin/servers/import', { preHandler: requireAdminMutation }, async (request, reply) => {
    const input = parse(serverImportRegistrationSchema, request.body)
    const server = await options.servers.registerImport(input, request.principal!.userId)
    return reply.code(201).send({ server })
  })
  app.patch('/api/v1/admin/servers/:serverId/metadata', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverMetadataUpdateSchema, request.body)
    return serverImportResultSchema.parse({ server: await options.servers.updateMetadata(params.serverId, input.name, request.principal!.userId) })
  })
  app.get('/api/v1/admin/server-installs/catalog', { preHandler: requireAdmin }, async (request) => {
    const query = parse(installCatalogQuerySchema, request.query)
    return installCatalogSchema.parse(await installs.catalog(query.software, query.version))
  })
  app.get('/api/v1/admin/server-installs', { preHandler: requireAdmin }, async () => installOperationListSchema.parse({ operations: installs.list() }))
  app.get('/api/v1/admin/server-installs/:operationId', { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(installOperationIdSchema, request.params)
    const operation = installs.get(params.operationId)
    if (!operation) return reply.code(404).send({ error: { code: 'INSTALL_NOT_FOUND', message: 'The installation operation was not found.' } })
    return installOperationResultSchema.parse({ operation })
  })
  app.post('/api/v1/admin/server-installs/:operationId/cancel', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(installOperationIdSchema, request.params)
    return reply.code(202).send(installOperationResultSchema.parse({ operation: installs.cancel(params.operationId) }))
  })
  app.post('/api/v1/admin/server-installs', { preHandler: requireAdminMutation }, async (request, reply) => {
    const input = parse(serverInstallRequestSchema, request.body)
    const operation = await installs.create(input, request.principal!.userId)
    return reply.code(202).send(installOperationResultSchema.parse({ operation }))
  })
  app.get('/api/v1/servers/:serverId/runtime', { preHandler: requireAuth }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverRuntimeResultSchema.parse({ runtime: await processes.get(params.serverId) })
  })
  app.get('/api/v1/admin/servers/:serverId/runtime-settings', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverRuntimeSettingsResultSchema.parse({ settings: await runtimeSettings.get(params.serverId) })
  })
  app.put('/api/v1/admin/servers/:serverId/runtime-settings', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverRuntimeSettingsUpdateSchema, request.body)
    return serverRuntimeSettingsResultSchema.parse({ settings: await runtimeSettings.update(params.serverId, request.principal!.userId, input) })
  })
  app.get('/api/v1/servers/:serverId/status', { preHandler: requireAuth }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverStatusResultSchema.parse({ status: await serverStatus.get(params.serverId) })
  })
  app.get('/api/v1/admin/servers/:serverId/players', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverPlayerListResultSchema.parse({ players: await processes.players(params.serverId) })
  })
  app.get('/api/v1/servers/:serverId/mods', { preHandler: requireAuth }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverModsInventoryResultSchema.parse({ mods: await mods.list(params.serverId) })
  })
  app.post('/api/v1/admin/servers/:serverId/mods', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const part = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_MOD_JAR_BYTES } })
    if (!part) throw new InvalidRequestError('A JAR file is required.')
    const inventory = await mods.upload(params.serverId, request.principal!.userId, part.filename, part.file, () => part.file.truncated)
    return reply.code(201).send(serverModsInventoryResultSchema.parse({ mods: inventory }))
  })
  app.post('/api/v1/admin/servers/:serverId/mods/:fileName/enable', { preHandler: requireAdminMutation }, async (request) => {
    const rawParams = request.params as { serverId?: unknown; fileName?: unknown }
    const params = parse(localServerIdSchema, { serverId: rawParams.serverId })
    const fileName = rawParams.fileName
    if (typeof fileName !== 'string') throw new InvalidRequestError('A mod filename is required.')
    return serverModsInventoryResultSchema.parse({ mods: await mods.setEnabled(params.serverId, request.principal!.userId, fileName, true) })
  })
  app.post('/api/v1/admin/servers/:serverId/mods/:fileName/disable', { preHandler: requireAdminMutation }, async (request) => {
    const rawParams = request.params as { serverId?: unknown; fileName?: unknown }
    const params = parse(localServerIdSchema, { serverId: rawParams.serverId })
    const fileName = rawParams.fileName
    if (typeof fileName !== 'string') throw new InvalidRequestError('A mod filename is required.')
    return serverModsInventoryResultSchema.parse({ mods: await mods.setEnabled(params.serverId, request.principal!.userId, fileName, false) })
  })
  app.post('/api/v1/admin/servers/:serverId/mods/:fileName/quarantine', { preHandler: requireAdminMutation }, async (request) => {
    const rawParams = request.params as { serverId?: unknown; fileName?: unknown }
    const params = parse(localServerIdSchema, { serverId: rawParams.serverId })
    const fileName = rawParams.fileName
    if (typeof fileName !== 'string') throw new InvalidRequestError('A mod filename is required.')
    return serverModsInventoryResultSchema.parse({ mods: await mods.quarantine(params.serverId, request.principal!.userId, fileName) })
  })
  app.post('/api/v1/admin/servers/:serverId/mods/quarantine/:id/restore', { preHandler: requireAdminMutation }, async (request) => {
    const rawParams = request.params as { serverId?: unknown; id?: unknown }
    const params = parse(localServerIdSchema, { serverId: rawParams.serverId })
    const quarantineId = rawParams.id
    if (typeof quarantineId !== 'string') throw new InvalidRequestError('A quarantine id is required.')
    return serverModsInventoryResultSchema.parse({ mods: await mods.restoreQuarantine(params.serverId, request.principal!.userId, quarantineId) })
  })
  app.post('/api/v1/admin/servers/:serverId/player-actions', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverPlayerActionRequestSchema, request.body)
    return serverPlayerActionResultSchema.parse(await processes.playerAction(params.serverId, request.principal!.userId, input.action, input.username ?? null))
  })
  app.get('/api/v1/servers/:serverId/console', { preHandler: requireAuth }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverConsoleQuerySchema, request.query)
    return serverConsoleResponseSchema.parse(await processes.console(params.serverId, query.after, query.limit))
  })
  app.post('/api/v1/admin/servers/:serverId/start', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    return reply.code(202).send(serverRuntimeResultSchema.parse({ runtime: await processes.start(params.serverId, request.principal!.userId) }))
  })
  app.post('/api/v1/admin/servers/:serverId/stop', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverRuntimeResultSchema.parse({ runtime: await processes.stop(params.serverId, request.principal!.userId) })
  })
  app.post('/api/v1/admin/servers/:serverId/restart', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverRuntimeResultSchema.parse({ runtime: await processes.restart(params.serverId, request.principal!.userId) })
  })
  app.post('/api/v1/admin/servers/:serverId/confirm-stopped', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverRuntimeResultSchema.parse({ runtime: await processes.confirmStopped(params.serverId, request.principal!.userId) })
  })
  app.post('/api/v1/admin/servers/:serverId/console', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverCommandSchema, request.body)
    await processes.sendCommand(params.serverId, request.principal!.userId, input.command)
    return reply.code(202).send({ ok: true })
  })
  app.get('/api/v1/admin/servers/:serverId/backups', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverBackupsResultSchema.parse(await backups.list(params.serverId))
  })
  app.post('/api/v1/admin/servers/:serverId/backups', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    if (request.body && typeof request.body === 'object' && Object.keys(request.body as Record<string, unknown>).length !== 0) throw new InvalidRequestError('Backup creation does not accept request options.')
    return reply.code(201).send(serverBackupCreateResultSchema.parse({ backup: await backups.create(params.serverId, request.principal!.userId) }))
  })
  app.get('/api/v1/admin/servers/:serverId/backups/:backupId/preview', { preHandler: requireAdmin }, async (request) => {
    const params = parse(serverBackupIdParamSchema, request.params)
    return serverBackupPreviewResultSchema.parse({ preview: await backups.preview(params.serverId, params.backupId) })
  })
  app.get('/api/v1/admin/servers/:serverId/backups/:backupId/download', { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(serverBackupIdParamSchema, request.params)
    const download = await backups.openDownload(params.serverId, params.backupId)
    reply.header('content-type', 'application/octet-stream')
    reply.header('content-length', String(download.sizeBytes))
    reply.header('content-disposition', `attachment; filename="mmsmanager-${params.serverId}-${params.backupId}.mmsbackup"`)
    reply.header('cache-control', 'private, no-store')
    reply.header('x-content-type-options', 'nosniff')
    return reply.send(download.handle.createReadStream({ start: 0, autoClose: true }))
  })
  app.post('/api/v1/admin/servers/:serverId/backups/:backupId/restore', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(serverBackupIdParamSchema, request.params)
    const input = parse(serverBackupRestoreRequestSchema, request.body)
    return serverBackupRestoreResultSchema.parse(await backups.restore(params.serverId, request.principal!.userId, params.backupId, input.confirmation))
  })
  app.get('/api/v1/admin/servers/:serverId/automation', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverAutomationResultSchema.parse({ automation: await automation.get(params.serverId) })
  })
  app.put('/api/v1/admin/servers/:serverId/automation', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverAutomationUpdateSchema, request.body)
    return serverAutomationResultSchema.parse({ automation: await automation.update(params.serverId, request.principal!.userId, input) })
  })
  app.post('/api/v1/admin/servers/:serverId/automation/jobs/:jobId/acknowledge', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(serverAutomationJobIdParamSchema, request.params)
    return serverAutomationResultSchema.parse({ automation: await automation.acknowledge(params.serverId, params.jobId, request.principal!.userId) })
  })
  app.get('/api/v1/admin/servers/:serverId/properties', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverPropertiesResultSchema.parse({ properties: await properties.get(params.serverId) })
  })
  app.patch('/api/v1/admin/servers/:serverId/properties', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverPropertiesUpdateRequestSchema, request.body)
    const { confirmOnlineModeChange, ...update } = input
    return serverPropertiesResultSchema.parse({ properties: await properties.update(params.serverId, request.principal!.userId, update, { confirmOnlineModeChange }) })
  })
  app.get('/api/v1/admin/servers/:serverId/properties/backups/:backupId/preview', { preHandler: requireAdmin }, async (request) => {
    const params = parse(serverPropertiesBackupIdParamSchema, request.params)
    return serverPropertiesRestorePreviewResultSchema.parse({ preview: await properties.previewRestore(params.serverId, params.backupId) })
  })
  app.post('/api/v1/admin/servers/:serverId/properties/backups/:backupId/restore', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(serverPropertiesBackupIdParamSchema, request.params)
    const input = parse(serverPropertiesRestoreRequestSchema, request.body)
    return serverPropertiesRestoreResultSchema.parse(await properties.restore(params.serverId, request.principal!.userId, params.backupId, input.expectedCurrentSha256))
  })
  app.get('/api/v1/admin/servers/:serverId/files', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFilePathQuerySchema, request.query)
    return serverFileListSchema.parse(await files.list(params.serverId, query.path))
  })
  app.get('/api/v1/admin/servers/:serverId/files/read', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFileReadQuerySchema, request.query)
    return serverFileReadSchema.parse(await files.read(params.serverId, query.path))
  })
  app.get('/api/v1/admin/servers/:serverId/files/download', { preHandler: requireAdmin }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFileReadQuerySchema, request.query)
    const download = await files.download(params.serverId, query.path)
    reply.header('content-type', 'application/octet-stream')
    reply.header('content-length', String(download.bytes.byteLength))
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download.name)}`)
    reply.header('cache-control', 'private, no-store')
    reply.header('x-content-type-options', 'nosniff')
    return reply.send(download.bytes)
  })
  app.post('/api/v1/admin/servers/:serverId/files/upload', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFilePathQuerySchema, request.query)
    const part = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_SERVER_FILE_UPLOAD_BYTES } })
    if (!part) throw new InvalidRequestError('A file is required.')
    const inventory = await files.upload(params.serverId, request.principal!.userId, query.path, part.filename, part.file, () => part.file.truncated)
    return reply.code(201).send(serverFileListSchema.parse(inventory))
  })
  app.post('/api/v1/admin/servers/:serverId/files/create', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileCreateSchema, request.body)
    return reply.code(201).send(serverFileListSchema.parse(await files.create(params.serverId, request.principal!.userId, input.path, input.kind, input.text ?? '')))
  })
  app.post('/api/v1/admin/servers/:serverId/files/move', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileMoveSchema, request.body)
    return serverFileListSchema.parse(await files.move(params.serverId, request.principal!.userId, input.sourcePath, input.destinationPath))
  })
  app.delete('/api/v1/admin/servers/:serverId/files', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileReadQuerySchema, request.body)
    const result = await files.trash(params.serverId, request.principal!.userId, input.path)
    return { item: result.item, inventory: serverFileListSchema.parse(result.inventory) }
  })
  app.get('/api/v1/admin/servers/:serverId/files/trash', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverFileTrashListSchema.parse({ items: files.listTrash(params.serverId) })
  })
  app.post('/api/v1/admin/servers/:serverId/files/trash/:id/restore', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(serverFileIdParamSchema, request.params)
    parse(serverFileTrashRestoreSchema, { id: params.id })
    return serverFileListSchema.parse(await files.restoreTrash(params.serverId, request.principal!.userId, params.id))
  })
  app.put('/api/v1/admin/servers/:serverId/files', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileWriteSchema, request.body)
    return serverFileReadSchema.parse(await files.writeText(params.serverId, request.principal!.userId, input.path, input.text, input.expectedSha256))
  })
  app.get('/api/v1/admin/servers/:serverId/files/recoveries', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFileReadQuerySchema, request.query)
    return serverFileRecoveryListSchema.parse({ items: await files.listRecoveries(params.serverId, query.path) })
  })
  app.post('/api/v1/admin/servers/:serverId/files/recoveries/:id/restore', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(serverFileIdParamSchema, request.params)
    const input = parse(serverFileRecoveryRestoreSchema, request.body)
    return serverFileReadSchema.parse(await files.restoreRecovery(params.serverId, request.principal!.userId, params.id, input.expectedCurrentSha256))
  })
  app.get('/api/v1/admin/servers/:serverId/worlds', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverWorldsResultSchema.parse({ worlds: await worlds.get(params.serverId) })
  })
  app.get('/api/v1/admin/java', { preHandler: requireAdmin }, async () => javaRuntimeListSchema.parse({
    runtimes: options.javaRuntimes.list(),
  }))
  app.post('/api/v1/admin/java/scan', { preHandler: requireAdminMutation }, async () => javaRuntimeListSchema.parse({
    runtimes: await options.javaRuntimes.scan(),
  }))
  app.post('/api/v1/admin/java/probe', { preHandler: requireAdminMutation }, async (request) => {
    const input = parse(javaProbeRequestSchema, request.body)
    return javaRuntimeSchema.parse(await options.javaRuntimes.probe(input.path))
  })

  app.get('/api/v1/activity', { preHandler: requireAuth }, async (request) => {
    const query = parse(activityQuerySchema, request.query)
    return activityResponseSchema.parse(activity.list(query, request.principal!.role))
  })
  app.get('/api/v1/notifications', { preHandler: requireAuth }, async (request) =>
    notificationsResponseSchema.parse(notifications.list(request.principal!.userId, request.principal!.role)))
  app.patch('/api/v1/notifications/:eventId/read', { preHandler: requireMutationAuth }, async (request) => {
    const params = parse(notificationEventIdParamSchema, request.params)
    return notificationsResponseSchema.parse(notifications.markRead(request.principal!.userId, request.principal!.role, params.eventId))
  })
  app.get('/api/v1/machine/current', { preHandler: requireAuth }, async () => machineCurrentSchema.parse(history.getCurrent(options.collector.health)))
  app.get('/api/v1/machine/history', { preHandler: requireAuth }, async (request) => {
    const query = parse(historyQuerySchema, request.query)
    return machineHistorySchema.parse(history.getHistory(query.from, query.to, query.limit))
  })
  app.get('/api/v1/machine/calendar', { preHandler: requireAuth }, async (request) => {
    const query = parse(calendarQuerySchema, request.query)
    return machineCalendarSchema.parse(history.getCalendar(query.year, query.month))
  })
  app.get('/api/v1/machine/day/:date', { preHandler: requireAuth }, async (request) => {
    const params = parse(dateParamSchema, request.params)
    validateCalendarDate(params.date)
    return machineDaySchema.parse(history.getDay(params.date))
  })
  app.get('/api/v1/admin/server-history/calendar', { preHandler: requireAdmin }, async (request) => {
    const query = parse(serverHistoryCalendarQuerySchema, request.query)
    return serverHistoryCalendarResultSchema.parse({ calendar: serverHistory.getCalendar(query.scope, query.year, query.month) })
  })
  app.get('/api/v1/admin/server-history/day', { preHandler: requireAdmin }, async (request) => {
    const query = parse(serverHistoryDayQuerySchema, request.query)
    return serverHistoryDayResultSchema.parse({ day: serverHistory.getDay(query.scope, query.date) })
  })

  await app.ready()
  return app
}

export { API_HOST }
