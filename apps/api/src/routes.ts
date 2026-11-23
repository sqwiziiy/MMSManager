import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import {
  adminUsersSchema,
  auditRecordsSchema,
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
  serverImportRegistrationSchema,
  serverImportRequestSchema,
  serverInventorySchema,
  serverInstallRequestSchema,
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
    if (record['code'] === 'FST_ERR_RATE_LIMIT') return 429
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
  webOrigin?: string
  apiPort?: number
  secureCookies?: boolean
  now?: () => number
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false })
  const history = new MachineHistoryService(options.db, options.timeZone, options.now)
  const installs = new ServerInstallService(options.db, options.servers, options.javaRuntimes)
  await installs.prepare()
  const webOrigin = options.webOrigin ?? WEB_ORIGIN
  const apiPort = options.apiPort ?? 4174
  const secureCookies = options.secureCookies ?? false
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === webOrigin),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-mms-csrf'],
    credentials: true,
    maxAge: 600,
  })
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' } }),
  })
  await app.register(multipart, {
    limits: { fields: 0, files: 1, parts: 1, fileSize: MAX_AVATAR_BYTES, headerPairs: 100 },
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
      if (isAvatarUpload ? !contentType.startsWith('multipart/form-data;') : request.method !== 'DELETE' && !contentType.startsWith('application/json')) {
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
    if (error instanceof ServerInstallError) {
      const status = error.code === 'INSTALL_LIMIT' ? 409 : error.code.endsWith('_UNAVAILABLE') || error.code === 'PROVIDER_UNAVAILABLE' ? 502 : error.code === 'PAPER_CONTACT_REQUIRED' ? 503 : 400
      return reply.code(status).send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ServerInventoryError) {
      const duplicate = error.code === 'duplicate'
      return reply.code(duplicate ? 409 : 400).send({
        error: { code: duplicate ? 'SERVER_ALREADY_REGISTERED' : 'SERVER_PATH_REJECTED', message: error.message },
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

  app.get('/api/v1/admin/servers', { preHandler: requireAdmin }, async () => serverInventorySchema.parse({
    servers: await options.servers.list(),
    managedRoot: options.servers.managedRoot,
    importRoots: options.servers.importRoots,
  }))
  app.get('/api/v1/servers', { preHandler: requireAuth }, async () => localServerListSchema.parse({
    servers: await options.servers.listPublic(),
  }))
  app.post('/api/v1/admin/servers/import/inspect', { preHandler: requireAdminMutation }, async (request) => {
    const input = parse(serverImportRequestSchema, request.body)
    return serverImportPreviewSchema.parse(await options.servers.inspect(input.path))
  })
  app.post('/api/v1/admin/servers/import', { preHandler: requireAdminMutation }, async (request, reply) => {
    const input = parse(serverImportRegistrationSchema, request.body)
    const server = await options.servers.registerImport(input, request.principal!.userId)
    return reply.code(201).send({ server })
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
  app.post('/api/v1/admin/server-installs', { preHandler: requireAdminMutation }, async (request, reply) => {
    const input = parse(serverInstallRequestSchema, request.body)
    const operation = await installs.create(input, request.principal!.userId)
    return reply.code(202).send(installOperationResultSchema.parse({ operation }))
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

  await app.ready()
  return app
}

export { API_HOST }
