import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
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
  machineStorageQuerySchema,
  machineStorageSchema,
  machineDaySchema,
  machineHistorySchema,
  monitoringSettingsSchema,
  monitoringSettingsUpdateSchema,
  installCatalogQuerySchema,
  installCatalogSchema,
  installOperationIdSchema,
  installOperationListSchema,
  installOperationResultSchema,
  localServerListSchema,
  localServerIdSchema,
  serverAccessAdminResultSchema,
  serverAccessSelfResultSchema,
  serverAccessUpdateSchema,
  serverCommandSchema,
  serverConsoleQuerySchema,
  serverConsoleResponseSchema,
  serverConsoleSessionsResponseSchema,
  serverRuntimeResultSchema,
  serverRuntimeSettingsResultSchema,
  serverRuntimeSettingsUpdateSchema,
  serverStatusResultSchema,
  dashboardPlayerSummaryResultSchema,
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
  serverFileRenameSchema,
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
  serverRestartScheduleUpdateSchema,
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
  userDeleteRequestSchema,
  userDeleteResultSchema,
  userPreferencesUpdateSchema,
  userUpdateSchema,
  workspacePreferencesSchema,
  serverImportPreviewSchema,
  serverImportResultSchema,
  serverImportRegistrationSchema,
  serverMetadataUpdateSchema,
  serverImportRequestSchema,
  serverInventorySchema,
  serverZipImportPublishSchema,
  serverZipImportPublishResultSchema,
  serverZipImportUploadResultSchema,
  serverZipImportIdParamSchema,
  serverRemovalRequestSchema,
  serverRemovalRetrySchema,
  serverRemovalIdParamSchema,
  serverRemovalOperationListSchema,
  serverRemovalResultSchema,
  serverInstallRequestSchema,
  serverTemplateIdParamSchema,
  serverTemplateInputSchema,
  serverTemplateListSchema,
  serverTemplateResultSchema,
} from '@mmsmanager/shared'
import { API_HOST, WEB_ORIGIN } from './config.js'
import { DEFAULT_MONITORING_SETTINGS } from './app-config.js'
import type { AppConfigStore } from './app-config.js'
import type { AppDatabase } from './db/client.js'
import type { MachineCollector } from './machine/collector.js'
import { MachineHistoryService } from './machine/history.js'
import { MachineStorageHistoryService } from './machine/storage-history.js'
import { validateCalendarDate } from './time.js'
import { AuthFailure, AuthService } from './auth/service.js'
import type { SessionPrincipal } from './auth/service.js'
import { AvatarStore, InvalidAvatarError, MAX_AVATAR_BYTES } from './auth/avatar-store.js'
import { ServerAccessError, ServerAccessService } from './auth/server-access.js'
import type { ServerCapability } from './auth/server-access.js'
import { JavaRuntimeError, JavaRuntimeRegistry } from './servers/java.js'
import { ServerInventoryError, ServerRegistry } from './servers/registry.js'
import { ServerInstallError, ServerInstallService } from './servers/install.js'
import { ServerProcessError, ServerProcessManager } from './servers/processes.js'
import { ServerPropertiesError, ServerPropertiesManager } from './servers/properties.js'
import { ServerStatusError, ServerStatusService } from './servers/status.js'
import { MAX_MOD_JAR_BYTES, ServerModsError, ServerModsService } from './servers/mods.js'
import {
  MAX_SERVER_FILE_UPLOAD_BATCH_BYTES, MAX_SERVER_FILE_UPLOAD_BYTES, MAX_SERVER_FILE_UPLOAD_COUNT,
  MAX_SERVER_FILE_UPLOAD_DIRECTORY_COUNT, MAX_SERVER_FILE_UPLOAD_MANIFEST_BYTES, ServerFileService,
  ServerFilesError, type ServerFileUploadManifest,
} from './servers/files.js'
import { ServerWorldService, ServerWorldsError } from './servers/worlds.js'
import { ServerHistoryService } from './servers/history.js'
import { ServerBackupError, ServerBackupService } from './servers/backups.js'
import { ServerAutomationError, ServerAutomationService } from './servers/automation.js'
import { ServerRuntimeSettingsError, ServerRuntimeSettingsService } from './servers/runtime.js'
import { ActivityFeedError, ActivityFeedService } from './activity/feed.js'
import { ServerTemplateError, ServerTemplateService } from './servers/templates.js'
import { NotificationError, NotificationService } from './activity/notifications.js'
import { ServerRemovalError, ServerRemovalService } from './servers/removals.js'
import { MAX_SERVER_ZIP_BYTES, ServerZipImportError, ServerZipImportService } from './servers/zip-import.js'

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
  const configuredOriginHost = new URL(webOrigin).host.toLowerCase()
  const allowed = new Set([
    configuredOriginHost,
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
    reply.code(409).send({ error: { code: 'ADMIN_ACCESS_PROTECTED', message: 'This action is blocked to protect administrator access.' } })
    return true
  }
  if (error.code === 'confirmation') {
    reply.code(400).send({ error: { code: 'CONFIRMATION_MISMATCH', message: 'The typed username did not match.' } })
    return true
  }
  if (error.code === 'current-password') {
    reply.code(400).send({ error: { code: 'CURRENT_PASSWORD', message: 'The current password could not be verified.' } })
    return true
  }
  if (error.code === 'same-password') {
    reply.code(400).send({ error: { code: 'PASSWORD_UNCHANGED', message: 'Choose a password different from the current one.' } })
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
  authRateLimitMax?: number
  installFetch?: typeof fetch
  now?: () => number
  monitoringConfig?: AppConfigStore
  onMonitoringSettingsChanged?: (settings: { fastSampleMs: number; historySaveMs: number; diskRefreshMs: number; statusPollMs: number }) => void
  staticWebDirectory?: string
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false })
  const history = new MachineHistoryService(options.db, options.timeZone, options.now, options.monitoringConfig?.get().historySaveMs)
  const storageHistory = new MachineStorageHistoryService(options.db, options.now)
  const activity = new ActivityFeedService(options.db)
  const notifications = new NotificationService(options.db, activity, options.now)
  const templates = new ServerTemplateService(options.db, options.now)
  const installs = new ServerInstallService(options.db, options.servers, options.javaRuntimes, options.installFetch ? { fetch: options.installFetch } : {})
  await installs.prepare()
  const processes = options.processes ?? new ServerProcessManager(options.db, options.servers, options.now, {}, options.javaRuntimes)
  await processes.prepare()
  const runtimeSettings = new ServerRuntimeSettingsService(options.db, options.servers, processes, options.javaRuntimes, options.now)
  const serverAccess = new ServerAccessService(options.db, options.now)
  const properties = new ServerPropertiesManager(options.db, options.servers, options.now)
  const serverStatus = new ServerStatusService(options.db, options.now)
  serverStatus.configurePollInterval(options.monitoringConfig?.get().statusPollMs ?? DEFAULT_MONITORING_SETTINGS.statusPollMs)
  const mods = new ServerModsService(options.db, options.servers, processes, options.now)
  const files = new ServerFileService(options.db, options.servers, processes, options.now)
  const backups = new ServerBackupService(options.db, options.servers, processes, options.now)
  await backups.prepare()
  const removals = new ServerRemovalService(options.db, options.servers, processes, options.now)
  await removals.prepare()
  const zipImports = new ServerZipImportService(options.db, options.servers, options.javaRuntimes, options.now)
  await zipImports.prepare()
  const automation = new ServerAutomationService(options.db, backups, options.timeZone, options.now, processes)
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
      const isFileUpload = /^\/api\/v1\/admin\/servers\/[0-9a-f-]{36}\/files\/upload(?:-batch)?(?:\?|$)/.test(request.url) && request.method === 'POST'
      const isServerZipUpload = request.url === '/api/v1/admin/server-imports/zip' && request.method === 'POST'
      const expectsMultipart = isAvatarUpload || isModUpload || isFileUpload || isServerZipUpload
      if (expectsMultipart ? !contentType.startsWith('multipart/form-data;') : request.method !== 'DELETE' && !contentType.startsWith('application/json')) {
        return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The request content type is not supported.' } })
      }
    }
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.getHeader('cache-control')) reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-frame-options', 'DENY')
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
    if (secureCookies) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    reply.header('x-mms-request-id', request.id)
    return payload
  })

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const principal = options.auth.authenticate(cookieValue(request, 'mmsmanager_session'))
    if (!principal) {
      clearSessionCookies(reply, secureCookies)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } })
    }
    request.principal = principal
    if (principal.mustChangePassword) {
      const path = request.url.split('?')[0]
      const allowed = request.method === 'GET' && path === '/api/v1/auth/me'
        || request.method === 'POST' && (path === '/api/v1/auth/change-password' || path === '/api/v1/auth/logout')
      if (!allowed) return reply.code(403).send({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Change your temporary password to continue.' } })
    }
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
  const requireServerCapability = (capability: ServerCapability, mutation = false) => async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (mutation) await requireMutationAuth(request, reply)
    else await requireAuth(request, reply)
    if (!request.principal) return
    const rawServerId = (request.params as { serverId?: unknown }).serverId
    const params = typeof rawServerId === 'string' ? localServerIdSchema.safeParse({ serverId: rawServerId }) : null
    if (!params?.success) return reply.code(400).send({ error: { code: 'INVALID_SERVER_ID', message: 'The server identifier is invalid.' } })
    const decision = serverAccess.authorize(request.principal, params.data.serverId, capability)
    if (decision === 'not-found') return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND', message: 'This server is not available in your local inventory.' } })
    if (decision === 'forbidden') return reply.code(403).send({ error: { code: 'SERVER_PERMISSION_REQUIRED', message: 'This server permission is not granted.' } })
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServerRemovalError) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404 : error.code.includes('BUSY') || error.code.includes('STOPPED') || error.code.includes('UNSAFE') || error.code.includes('UNMANAGED') || error.code.includes('RECOVERY') || error.code.includes('COLLISION') ? 409 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerZipImportError) {
      const status = error.code.includes('NOT_FOUND') ? 404 : error.code.includes('LIMIT') || error.code.includes('TOO_LARGE') ? 413 : error.code.includes('NOT_READY') || error.code.includes('UNSUPPORTED') || error.code.includes('INCOMPATIBLE') || error.code.includes('COLLISION') || error.code.includes('CHANGED') ? 409 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerAccessError) return reply.code(error.code === 'SERVER_ACCESS_NOT_FOUND' || error.code === 'ACCESS_USER_NOT_FOUND' ? 404 : 400).send({ error: { code: error.code, message: error.message } })
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
          : error.code.endsWith('_CONFLICT') || error.code.includes('ALREADY') || error.code.includes('STILL_RUNNING') || error.code.includes('RATE_LIMITED') || error.code.endsWith('_NOT_RUNNING') || error.code.endsWith('_BUSY') || error.code.endsWith('_NOT_STOPPED') || error.code.includes('RECOVERY_REQUIRED') || error.code === 'PROCESS_NOT_OWNED' || error.code === 'SERVER_NOT_PANEL_MANAGED' || error.code === 'SERVER_DELETE_UNMANAGED' || error.code === 'RESTART_NOT_RUNNING' ? 409
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
    config: { rateLimit: { max: options.authRateLimitMax ?? 5, timeWindow: '15 minutes' } },
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
    config: { rateLimit: { max: options.authRateLimitMax ?? 5, timeWindow: '15 minutes' } },
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
      const replacement = await options.auth.changePassword(request.principal!, input.currentPassword, input.newPassword)
      if (replacement) {
        addSessionCookies(reply, replacement.sessionToken, replacement.csrfToken, secureCookies || request.protocol === 'https')
        return reply.send({ ok: true, signInAgain: false })
      }
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
    const input = parse(userPreferencesUpdateSchema, request.body)
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
  app.delete('/api/v1/admin/users/:userId', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(userIdParamSchema, request.params)
    const input = parse(userDeleteRequestSchema, request.body)
    try {
      const deleted = options.auth.deleteUser(request.principal!, params.userId, input.confirmation)
      let avatarCleanup: 'done' | 'pending' = 'done'
      try { await options.avatars.remove(deleted.avatarKey) } catch { avatarCleanup = 'pending' }
      return reply.send(userDeleteResultSchema.parse({ ok: true, avatarCleanup }))
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
      if (params.userId === request.principal!.userId) clearSessionCookies(reply, secureCookies || request.protocol === 'https')
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
  app.get('/api/v1/servers', { preHandler: requireAuth }, async (request) => {
    const statuses = processes.listPublicStatuses()
    const allowedIds = new Set(serverAccess.serverIds(request.principal!, 'viewServer'))
    return localServerListSchema.parse({
      servers: (await options.servers.listPublic()).filter((server) => allowedIds.has(server.id))
        .map((server) => ({ ...server, runtimeStatus: statuses.get(server.id) ?? 'unavailable' })),
    })
  })
  app.get('/api/v1/servers/:serverId/access', { preHandler: requireServerCapability('viewServer') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverAccessSelfResultSchema.parse({
      administrator: request.principal!.role === 'administrator',
      permissions: serverAccess.permissions(params.serverId, request.principal!.userId),
    })
  })
  app.get('/api/v1/admin/servers/:serverId/access', { preHandler: requireAdmin }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverAccessAdminResultSchema.parse({ users: serverAccess.listForAdmin(params.serverId) })
  })
  app.put('/api/v1/admin/servers/:serverId/access', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverAccessUpdateSchema, request.body)
    serverAccess.update(request.principal!, params.serverId, input.userId, input.permissions)
    return serverAccessAdminResultSchema.parse({ users: serverAccess.listForAdmin(params.serverId) })
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
  app.get('/api/v1/admin/server-removals', { preHandler: requireAdmin }, async () => serverRemovalOperationListSchema.parse({ operations: removals.list() }))
  app.post('/api/v1/admin/servers/:serverId/remove', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverRemovalRequestSchema, request.body)
    return serverRemovalResultSchema.parse({ operation: await removals.remove(params.serverId, input.mode, input.confirmation, request.principal!.userId) })
  })
  app.post('/api/v1/admin/server-removals/:id/retry', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(serverRemovalIdParamSchema, request.params)
    const input = parse(serverRemovalRetrySchema, request.body)
    return serverRemovalResultSchema.parse({ operation: await removals.retry(params.id, input.confirmation, request.principal!.userId) })
  })
  app.post('/api/v1/admin/server-imports/zip', {
    preHandler: requireAdminMutation,
    bodyLimit: MAX_SERVER_ZIP_BYTES + 1024 * 1024,
  }, async (request, reply) => {
    const file = await request.file()
    if (!file || file.fieldname !== 'archive') {
      file?.file.resume()
      throw new ServerZipImportError('ZIP_FILE_REQUIRED', 'Choose one ZIP archive to upload.')
    }
    const preview = await zipImports.stage(file.filename, file.file, () => file.file.truncated, request.principal!.userId)
    return reply.code(201).send(serverZipImportUploadResultSchema.parse({ preview }))
  })
  app.post('/api/v1/admin/server-imports/:token/publish', { preHandler: requireAdminMutation }, async (request, reply) => {
    const params = parse(serverZipImportIdParamSchema, request.params)
    const body = typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {}
    const input = parse(serverZipImportPublishSchema, { ...body, token: params.token })
    const server = await zipImports.publish(input, request.principal!.userId)
    let started = false
    let startError: string | null = null
    if (input.startAfterImport) {
      try { await processes.start(server.id, request.principal!.userId); started = true }
      catch (error) { startError = error instanceof Error ? error.message.slice(0, 300) : 'The imported server was created but did not start.' }
    }
    return reply.code(201).send(serverZipImportPublishResultSchema.parse({ server, importState: 'published', started, startError }))
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
  app.get('/api/v1/servers/:serverId/runtime', { preHandler: requireServerCapability('viewServer') }, async (request) => {
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
  app.get('/api/v1/servers/:serverId/status', { preHandler: requireServerCapability('viewServer') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverStatusResultSchema.parse({ status: await serverStatus.get(params.serverId) })
  })
  app.get('/api/v1/dashboard/players', { preHandler: requireAuth }, async (request) => {
    const allowedIds = serverAccess.serverIds(request.principal!, 'viewPlayers')
    return dashboardPlayerSummaryResultSchema.parse({ summary: await serverStatus.getPlayerSummary(request.principal!.role === 'administrator' ? undefined : allowedIds) })
  })
  app.get('/api/v1/admin/servers/:serverId/players', { preHandler: requireServerCapability('viewPlayers') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverPlayerListResultSchema.parse({ players: await processes.players(params.serverId) })
  })
  app.get('/api/v1/servers/:serverId/mods', { preHandler: requireServerCapability('viewMods') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverModsInventoryResultSchema.parse({ mods: await mods.list(params.serverId) })
  })
  app.post('/api/v1/admin/servers/:serverId/mods', { preHandler: requireServerCapability('manageMods', true) }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const part = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_MOD_JAR_BYTES } })
    if (!part) throw new InvalidRequestError('A JAR file is required.')
    const inventory = await mods.upload(params.serverId, request.principal!.userId, part.filename, part.file, () => part.file.truncated)
    return reply.code(201).send(serverModsInventoryResultSchema.parse({ mods: inventory }))
  })
  app.post('/api/v1/admin/servers/:serverId/mods/:fileName/enable', { preHandler: requireServerCapability('manageMods', true) }, async (request) => {
    const rawParams = request.params as { serverId?: unknown; fileName?: unknown }
    const params = parse(localServerIdSchema, { serverId: rawParams.serverId })
    const fileName = rawParams.fileName
    if (typeof fileName !== 'string') throw new InvalidRequestError('A mod filename is required.')
    return serverModsInventoryResultSchema.parse({ mods: await mods.setEnabled(params.serverId, request.principal!.userId, fileName, true) })
  })
  app.post('/api/v1/admin/servers/:serverId/mods/:fileName/disable', { preHandler: requireServerCapability('manageMods', true) }, async (request) => {
    const rawParams = request.params as { serverId?: unknown; fileName?: unknown }
    const params = parse(localServerIdSchema, { serverId: rawParams.serverId })
    const fileName = rawParams.fileName
    if (typeof fileName !== 'string') throw new InvalidRequestError('A mod filename is required.')
    return serverModsInventoryResultSchema.parse({ mods: await mods.setEnabled(params.serverId, request.principal!.userId, fileName, false) })
  })
  app.post('/api/v1/admin/servers/:serverId/mods/:fileName/quarantine', { preHandler: requireServerCapability('manageMods', true) }, async (request) => {
    const rawParams = request.params as { serverId?: unknown; fileName?: unknown }
    const params = parse(localServerIdSchema, { serverId: rawParams.serverId })
    const fileName = rawParams.fileName
    if (typeof fileName !== 'string') throw new InvalidRequestError('A mod filename is required.')
    return serverModsInventoryResultSchema.parse({ mods: await mods.quarantine(params.serverId, request.principal!.userId, fileName) })
  })
  app.post('/api/v1/admin/servers/:serverId/mods/quarantine/:id/restore', { preHandler: requireServerCapability('manageMods', true) }, async (request) => {
    const rawParams = request.params as { serverId?: unknown; id?: unknown }
    const params = parse(localServerIdSchema, { serverId: rawParams.serverId })
    const quarantineId = rawParams.id
    if (typeof quarantineId !== 'string') throw new InvalidRequestError('A quarantine id is required.')
    return serverModsInventoryResultSchema.parse({ mods: await mods.restoreQuarantine(params.serverId, request.principal!.userId, quarantineId) })
  })
  app.post('/api/v1/admin/servers/:serverId/player-actions', { preHandler: requireServerCapability('moderatePlayers', true) }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverPlayerActionRequestSchema, request.body)
    return serverPlayerActionResultSchema.parse(await processes.playerAction(params.serverId, request.principal!.userId, input.action, input.username ?? null))
  })
  app.get('/api/v1/servers/:serverId/console', { preHandler: requireServerCapability('viewLogs') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverConsoleQuerySchema, request.query)
    return serverConsoleResponseSchema.parse(await processes.console(params.serverId, query.after ?? 0, query.limit, query.sessionId ?? null, query.before))
  })
  app.get('/api/v1/servers/:serverId/console/sessions', { preHandler: requireServerCapability('viewLogs') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverConsoleSessionsResponseSchema.parse({ sessions: await processes.consoleSessions(params.serverId) })
  })
  app.post('/api/v1/admin/servers/:serverId/start', { preHandler: requireServerCapability('startServer', true) }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const runtime = await processes.start(params.serverId, request.principal!.userId)
    serverStatus.invalidate(params.serverId)
    return reply.code(202).send(serverRuntimeResultSchema.parse({ runtime }))
  })
  app.post('/api/v1/admin/servers/:serverId/stop', { preHandler: requireServerCapability('stopServer', true) }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const runtime = await processes.stop(params.serverId, request.principal!.userId)
    serverStatus.invalidate(params.serverId)
    return serverRuntimeResultSchema.parse({ runtime })
  })
  app.post('/api/v1/admin/servers/:serverId/restart', { preHandler: requireServerCapability('restartServer', true) }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const runtime = await processes.restart(params.serverId, request.principal!.userId)
    serverStatus.invalidate(params.serverId)
    return serverRuntimeResultSchema.parse({ runtime })
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
  app.get('/api/v1/admin/servers/:serverId/backups', { preHandler: requireServerCapability('viewBackups') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverBackupsResultSchema.parse(await backups.list(params.serverId))
  })
  app.post('/api/v1/admin/servers/:serverId/backups', { preHandler: requireServerCapability('createBackups', true) }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    if (request.body && typeof request.body === 'object' && Object.keys(request.body as Record<string, unknown>).length !== 0) throw new InvalidRequestError('Backup creation does not accept request options.')
    return reply.code(201).send(serverBackupCreateResultSchema.parse({ backup: await backups.create(params.serverId, request.principal!.userId) }))
  })
  app.get('/api/v1/admin/servers/:serverId/backups/:backupId/preview', { preHandler: requireServerCapability('viewBackups') }, async (request) => {
    const params = parse(serverBackupIdParamSchema, request.params)
    return serverBackupPreviewResultSchema.parse({ preview: await backups.preview(params.serverId, params.backupId) })
  })
  app.get('/api/v1/admin/servers/:serverId/backups/:backupId/download', { preHandler: requireServerCapability('viewBackups') }, async (request, reply) => {
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
  app.put('/api/v1/admin/servers/:serverId/automation/restart-schedule', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverRestartScheduleUpdateSchema, request.body)
    return serverAutomationResultSchema.parse({ automation: await automation.updateRestart(params.serverId, request.principal!.userId, input) })
  })
  app.post('/api/v1/admin/servers/:serverId/automation/jobs/:jobId/acknowledge', { preHandler: requireAdminMutation }, async (request) => {
    const params = parse(serverAutomationJobIdParamSchema, request.params)
    return serverAutomationResultSchema.parse({ automation: await automation.acknowledge(params.serverId, params.jobId, request.principal!.userId) })
  })
  app.get('/api/v1/admin/servers/:serverId/properties', { preHandler: requireServerCapability('viewSettings') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverPropertiesResultSchema.parse({ properties: await properties.get(params.serverId) })
  })
  app.patch('/api/v1/admin/servers/:serverId/properties', { preHandler: requireServerCapability('manageSettings', true) }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverPropertiesUpdateRequestSchema, request.body)
    const { expectedSha256, advancedProperties, confirmOnlineModeChange, confirmLevelNameChange, confirmWorldGenerationChange, confirmResourcePackChange, confirmGamePortChange, ...update } = input
    return serverPropertiesResultSchema.parse({ properties: await properties.update(params.serverId, request.principal!.userId, update, {
      expectedSha256, advancedProperties, confirmOnlineModeChange, confirmLevelNameChange, confirmWorldGenerationChange, confirmResourcePackChange, confirmGamePortChange,
    }) })
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
  app.get('/api/v1/admin/servers/:serverId/files', { preHandler: requireServerCapability('viewFiles') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFilePathQuerySchema, request.query)
    return serverFileListSchema.parse(await files.list(params.serverId, query.path))
  })
  app.get('/api/v1/admin/servers/:serverId/files/read', { preHandler: requireServerCapability('viewFiles') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFileReadQuerySchema, request.query)
    return serverFileReadSchema.parse(await files.read(params.serverId, query.path))
  })
  app.get('/api/v1/admin/servers/:serverId/files/download', { preHandler: requireServerCapability('viewFiles') }, async (request, reply) => {
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
  app.post('/api/v1/admin/servers/:serverId/files/upload', { preHandler: requireServerCapability('manageFiles', true) }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFilePathQuerySchema, request.query)
    const part = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: MAX_SERVER_FILE_UPLOAD_BYTES } })
    if (!part) throw new InvalidRequestError('A file is required.')
    const inventory = await files.upload(params.serverId, request.principal!.userId, query.path, part.filename, part.file, () => part.file.truncated)
    return reply.code(201).send(serverFileListSchema.parse(inventory))
  })
  app.post('/api/v1/admin/servers/:serverId/files/upload-batch', {
    preHandler: requireServerCapability('manageFiles', true),
    bodyLimit: MAX_SERVER_FILE_UPLOAD_BATCH_BYTES + MAX_SERVER_FILE_UPLOAD_MANIFEST_BYTES + 256 * 1024,
  }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFilePathQuerySchema, request.query)
    const parts = request.parts({
      preservePath: true,
      limits: {
        fields: 1,
        files: MAX_SERVER_FILE_UPLOAD_COUNT,
        parts: MAX_SERVER_FILE_UPLOAD_COUNT + 1,
        fileSize: MAX_SERVER_FILE_UPLOAD_BYTES,
        fieldSize: MAX_SERVER_FILE_UPLOAD_MANIFEST_BYTES,
      },
    })
    const drainRemainingParts = async () => {
      try {
        for await (const part of parts) if (part.type === 'file') part.file.resume()
      } catch { /* preserve the original multipart validation error */ }
    }
    let manifest: ServerFileUploadManifest
    try {
      const first = await parts.next()
      if (first.done || first.value.type !== 'field' || first.value.fieldname !== 'manifest' || first.value.valueTruncated) {
        await drainRemainingParts()
        throw new InvalidRequestError('A bounded file upload manifest is required before the file parts.')
      }
      const raw = first.value.value
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_SERVER_FILE_UPLOAD_MANIFEST_BYTES) {
        await drainRemainingParts()
        throw new InvalidRequestError('The file upload manifest is invalid or too large.')
      }
      let parsed: unknown
      try { parsed = JSON.parse(raw) as unknown } catch {
        await drainRemainingParts()
        throw new InvalidRequestError('The file upload manifest is not valid JSON.')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).sort().join(',') !== 'directories,files'
        || !Array.isArray((parsed as { files?: unknown }).files)
        || !Array.isArray((parsed as { directories?: unknown }).directories)
        || (parsed as { files: unknown[] }).files.length > MAX_SERVER_FILE_UPLOAD_COUNT
        || (parsed as { directories: unknown[] }).directories.length > MAX_SERVER_FILE_UPLOAD_DIRECTORY_COUNT
        || [...(parsed as { files: unknown[] }).files, ...(parsed as { directories: unknown[] }).directories].some((value) => typeof value !== 'string' || value.length > 2048)) {
        await drainRemainingParts()
        throw new InvalidRequestError('The file upload manifest is invalid or exceeds its limits.')
      }
      manifest = parsed as ServerFileUploadManifest
    } catch (error) {
      await drainRemainingParts()
      throw error
    }

    async function* fileParts() {
      let fileCount = 0
      for await (const part of parts) {
        if (part.type !== 'file') throw new InvalidRequestError('Only declared file parts are accepted in a file upload batch.')
        if (fileCount >= manifest.files.length) {
          part.file.resume()
          throw new InvalidRequestError('The upload includes an undeclared file part.')
        }
        if (part.fieldname !== 'file') {
          part.file.resume()
          throw new InvalidRequestError('The file part name does not match the upload manifest.')
        }
        fileCount += 1
        yield { relativePath: part.filename, stream: part.file, truncated: () => part.file.truncated }
      }
    }
    try {
      const inventory = await files.uploadBatch(params.serverId, request.principal!.userId, query.path, manifest, fileParts())
      return reply.code(201).send(serverFileListSchema.parse(inventory))
    } catch (error) {
      await drainRemainingParts()
      throw error
    }
  })
  app.post('/api/v1/admin/servers/:serverId/files/create', { preHandler: requireServerCapability('manageFiles', true) }, async (request, reply) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileCreateSchema, request.body)
    return reply.code(201).send(serverFileListSchema.parse(await files.create(params.serverId, request.principal!.userId, input.path, input.kind, input.text ?? '')))
  })
  app.post('/api/v1/admin/servers/:serverId/files/move', { preHandler: requireServerCapability('manageFiles', true) }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileMoveSchema, request.body)
    return serverFileListSchema.parse(await files.move(params.serverId, request.principal!.userId, input.sourcePath, input.destinationDirectory))
  })
  app.post('/api/v1/admin/servers/:serverId/files/rename', { preHandler: requireServerCapability('manageFiles', true) }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileRenameSchema, request.body)
    return serverFileListSchema.parse(await files.rename(params.serverId, request.principal!.userId, input.path, input.newName))
  })
  app.delete('/api/v1/admin/servers/:serverId/files', { preHandler: requireServerCapability('manageFiles', true) }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileReadQuerySchema, request.body)
    const result = await files.trash(params.serverId, request.principal!.userId, input.path)
    return { item: result.item, inventory: serverFileListSchema.parse(result.inventory) }
  })
  app.get('/api/v1/admin/servers/:serverId/files/trash', { preHandler: requireServerCapability('viewFiles') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    return serverFileTrashListSchema.parse({ items: files.listTrash(params.serverId) })
  })
  app.post('/api/v1/admin/servers/:serverId/files/trash/:id/restore', { preHandler: requireServerCapability('manageFiles', true) }, async (request) => {
    const params = parse(serverFileIdParamSchema, request.params)
    parse(serverFileTrashRestoreSchema, { id: params.id })
    return serverFileListSchema.parse(await files.restoreTrash(params.serverId, request.principal!.userId, params.id))
  })
  app.put('/api/v1/admin/servers/:serverId/files', { preHandler: requireServerCapability('manageFiles', true) }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const input = parse(serverFileWriteSchema, request.body)
    return serverFileReadSchema.parse(await files.writeText(params.serverId, request.principal!.userId, input.path, input.text, input.expectedSha256))
  })
  app.get('/api/v1/admin/servers/:serverId/files/recoveries', { preHandler: requireServerCapability('viewFiles') }, async (request) => {
    const params = parse(localServerIdSchema, request.params)
    const query = parse(serverFileReadQuerySchema, request.query)
    return serverFileRecoveryListSchema.parse({ items: await files.listRecoveries(params.serverId, query.path) })
  })
  app.post('/api/v1/admin/servers/:serverId/files/recoveries/:id/restore', { preHandler: requireServerCapability('manageFiles', true) }, async (request) => {
    const params = parse(serverFileIdParamSchema, request.params)
    const input = parse(serverFileRecoveryRestoreSchema, request.body)
    return serverFileReadSchema.parse(await files.restoreRecovery(params.serverId, request.principal!.userId, params.id, input.expectedCurrentSha256))
  })
  app.get('/api/v1/admin/servers/:serverId/worlds', { preHandler: requireServerCapability('viewWorlds') }, async (request) => {
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

  app.get('/api/v1/activity', { preHandler: requireAuth }, async (request, reply) => {
    const query = parse(activityQuerySchema, request.query)
    const principal = request.principal!
    const serverIds = serverAccess.serverIds(principal, 'viewServer')
    if (query.serverId && !serverIds.includes(query.serverId)) return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND', message: 'This server is not available in your local inventory.' } })
    const access = {
      serverIds: serverAccess.serverIds(principal, 'viewLogs'),
      playerServerIds: serverAccess.serverIds(principal, 'viewPlayers'),
      backupServerIds: serverAccess.serverIds(principal, 'viewBackups'),
      automationServerIds: principal.role === 'administrator' ? serverAccess.serverIds(principal, 'viewServer') : [],
    }
    return activityResponseSchema.parse(activity.list(query, principal.role, access))
  })
  app.get('/api/v1/notifications', { preHandler: requireAuth }, async (request) => {
    const principal = request.principal!
    const access = {
      serverIds: serverAccess.serverIds(principal, 'viewLogs'),
      playerServerIds: serverAccess.serverIds(principal, 'viewPlayers'),
      backupServerIds: serverAccess.serverIds(principal, 'viewBackups'),
      automationServerIds: principal.role === 'administrator' ? serverAccess.serverIds(principal, 'viewServer') : [],
    }
    return notificationsResponseSchema.parse(notifications.list(principal.userId, principal.role, access))
  })
  app.patch('/api/v1/notifications/:eventId/read', { preHandler: requireMutationAuth }, async (request) => {
    const params = parse(notificationEventIdParamSchema, request.params)
    const principal = request.principal!
    const access = {
      serverIds: serverAccess.serverIds(principal, 'viewLogs'),
      playerServerIds: serverAccess.serverIds(principal, 'viewPlayers'),
      backupServerIds: serverAccess.serverIds(principal, 'viewBackups'),
      automationServerIds: principal.role === 'administrator' ? serverAccess.serverIds(principal, 'viewServer') : [],
    }
    return notificationsResponseSchema.parse(notifications.markRead(principal.userId, principal.role, params.eventId, access))
  })
  app.get('/api/v1/machine/current', { preHandler: requireAuth }, async () => machineCurrentSchema.parse(history.getCurrent(options.collector.health, options.collector.currentSnapshot)))
  app.get('/api/v1/machine/storage', { preHandler: requireAuth }, async (request) => {
    const query = parse(machineStorageQuerySchema, request.query)
    const volumes = options.collector.currentSnapshot?.snapshot.storageVolumes ?? []
    return machineStorageSchema.parse(storageHistory.get(query, volumes))
  })
  app.get('/api/v1/monitoring-settings', { preHandler: requireAuth }, async () => monitoringSettingsSchema.parse(options.monitoringConfig?.get() ?? DEFAULT_MONITORING_SETTINGS))
  app.get('/api/v1/admin/monitoring-settings', { preHandler: requireAdmin }, async () => monitoringSettingsSchema.parse(options.monitoringConfig?.get() ?? DEFAULT_MONITORING_SETTINGS))
  app.patch('/api/v1/admin/monitoring-settings', { preHandler: requireAdminMutation }, async (request) => {
    if (!options.monitoringConfig) throw new Error('Monitoring settings are not available in this API process.')
    const input = parse(monitoringSettingsUpdateSchema, request.body)
    const settings = await options.monitoringConfig.update(input)
    options.collector.configure(settings.fastSampleMs, settings.historySaveMs)
    history.setPersistenceInterval(settings.historySaveMs)
    serverStatus.configurePollInterval(settings.statusPollMs)
    options.onMonitoringSettingsChanged?.(settings)
    return monitoringSettingsSchema.parse(settings)
  })
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
  app.get('/api/v1/admin/server-history/calendar', { preHandler: requireAuth }, async (request, reply) => {
    const query = parse(serverHistoryCalendarQuerySchema, request.query)
    const principal = request.principal!
    const serverIds = serverAccess.serverIds(principal, 'viewServer')
    if (!serverHistory.scopeAvailable(query.scope, serverIds)) return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND', message: 'This server does not have an available local history.' } })
    return serverHistoryCalendarResultSchema.parse({ calendar: serverHistory.getCalendar(query.scope, query.year, query.month, serverIds, serverAccess.serverIds(principal, 'viewPlayers')) })
  })
  app.get('/api/v1/admin/server-history/day', { preHandler: requireAuth }, async (request, reply) => {
    const query = parse(serverHistoryDayQuerySchema, request.query)
    const principal = request.principal!
    const serverIds = serverAccess.serverIds(principal, 'viewServer')
    if (!serverHistory.scopeAvailable(query.scope, serverIds)) return reply.code(404).send({ error: { code: 'SERVER_NOT_FOUND', message: 'This server does not have an available local history.' } })
    const day = serverHistory.getDay(query.scope, query.date, serverIds, serverAccess.serverIds(principal, 'viewPlayers'))
    if (principal.role !== 'administrator') day.events = day.events.map((event) => ({ ...event, rawMessage: null }))
    return serverHistoryDayResultSchema.parse({ day })
  })

  if (options.staticWebDirectory) {
    const root = resolve(options.staticWebDirectory)
    const rootRealPath = await realpath(root)
    app.get('/*', async (request, reply) => {
      let pathname: string
      try { pathname = decodeURIComponent(new URL(request.raw.url ?? '/', 'http://mmsmanager.local').pathname) }
      catch { return reply.code(400).send({ error: { code: 'BAD_PATH', message: 'The requested page path is invalid.' } }) }
      if (pathname === '/api' || pathname.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'This endpoint does not exist.' } })
      const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
      let candidate = resolve(root, relativePath)
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return reply.code(404).send()
      let metadata: Awaited<ReturnType<typeof stat>> | null = null
      try { metadata = await stat(candidate) } catch { /* SPA route or absent asset */ }
      if (!metadata?.isFile()) {
        if (extname(pathname)) return reply.code(404).send()
        candidate = resolve(root, 'index.html')
        try { metadata = await stat(candidate) } catch { return reply.code(503).send() }
      }
      if (!metadata?.isFile()) return reply.code(404).send()
      let candidateRealPath: string
      try { candidateRealPath = await realpath(candidate) } catch { return reply.code(404).send() }
      if (candidateRealPath !== rootRealPath && !candidateRealPath.startsWith(`${rootRealPath}${sep}`)) return reply.code(404).send()
      const contentTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json; charset=utf-8',
      }
      const extension = extname(candidate).toLowerCase()
      reply.header('content-type', contentTypes[extension] ?? 'application/octet-stream')
      reply.header('content-length', metadata.size)
      reply.header('cache-control', extension === '.html' ? 'no-store' : /-[A-Za-z0-9_-]{8,}\./.test(candidate) ? 'public, max-age=31536000, immutable' : 'no-cache')
      return reply.send(createReadStream(candidateRealPath))
    })
  }

  await app.ready()
  return app
}

export { API_HOST }
