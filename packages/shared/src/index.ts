import { z } from 'zod'

const nullablePercent = z.number().finite().min(0).max(100).nullable()
const nullableBytes = z.number().finite().nonnegative().nullable()
const datePattern = /^\d{4}-\d{2}-\d{2}$/

export const machineMetricSampleSchema = z.object({
  id: z.number().int().positive().nullable(),
  collectedAt: z.string().datetime({ offset: true }),
  cpuPercent: nullablePercent,
  coreCount: z.number().int().positive().nullable(),
  loadAverage: z.object({ one: z.number().finite(), five: z.number().finite(), fifteen: z.number().finite() }).nullable(),
  memory: z.object({
    usedBytes: nullableBytes,
    availableBytes: nullableBytes,
    totalBytes: nullableBytes,
    swapUsedBytes: nullableBytes,
    swapTotalBytes: nullableBytes,
    usedPercent: nullablePercent,
  }),
  storage: z.object({
    device: z.string().nullable(),
    mount: z.string().nullable(),
    usedBytes: nullableBytes,
    availableBytes: nullableBytes,
    totalBytes: nullableBytes,
    usedPercent: nullablePercent,
  }).nullable(),
  network: z.object({
    interface: z.string().nullable(),
    rxBytesPerSecond: nullableBytes,
    txBytesPerSecond: nullableBytes,
    rxTransferredBytes: nullableBytes,
    txTransferredBytes: nullableBytes,
  }),
  sampleStatus: z.enum(['ok', 'partial', 'error']),
  unavailableFields: z.array(z.string()),
  source: z.literal('systeminformation'),
})

export const machineHostSchema = z.object({
  id: z.literal('local'),
  hostname: z.string(),
  platform: z.string(),
  distro: z.string().nullable(),
  release: z.string().nullable(),
  architecture: z.string(),
  cpuModel: z.string().nullable(),
  coreCount: z.number().int().positive().nullable(),
  uptimeSeconds: z.number().finite().nonnegative().nullable(),
  source: z.literal('systeminformation'),
})

export const publicHealthSchema = z.object({
  service: z.literal('mmsmanager-local-api'),
  status: z.literal('ok'),
  setupRequired: z.boolean(),
})

export const userRoleSchema = z.enum(['administrator', 'member'])
export const landingPageSchema = z.enum(['dashboard', 'machine'])

const usernameSchema = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9._-]+$/)
const displayNameSchema = z.string().trim().min(1).max(60)
const passwordSchema = z.string().min(14).max(128)

export const bootstrapSchema = z.object({
  token: z.string().min(40).max(80),
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  confirmPassword: z.string().min(14).max(128),
}).strict().refine((value) => value.password === value.confirmPassword, {
  path: ['confirmPassword'], message: 'Passwords do not match.',
})

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
}).strict()

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
  confirmPassword: z.string().min(14).max(128),
}).strict().refine((value) => value.newPassword === value.confirmPassword, {
  path: ['confirmPassword'], message: 'Passwords do not match.',
})

export const userCreateSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  role: userRoleSchema,
}).strict()

export const userUpdateSchema = z.object({
  role: userRoleSchema,
  enabled: z.boolean(),
}).strict()

export const userPasswordResetSchema = z.object({ password: passwordSchema }).strict()
export const profileUpdateSchema = z.object({ displayName: displayNameSchema }).strict()
export const userPreferencesSchema = z.object({
  compactNavigation: z.boolean(),
  defaultLanding: landingPageSchema,
}).strict()
export const workspacePreferencesSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  defaultLanding: landingPageSchema,
}).strict()

export const authUserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  role: userRoleSchema,
  enabled: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  lastLoginAt: z.string().datetime({ offset: true }).nullable(),
  avatarUrl: z.string().nullable(),
  preferences: userPreferencesSchema,
})

export const authSessionSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }),
  current: z.boolean(),
})

export const authMeSchema = z.object({
  user: authUserSchema,
  workspace: workspacePreferencesSchema,
  sessions: z.array(authSessionSchema),
})

export const adminUserSchema = authUserSchema.extend({
  activeSessionCount: z.number().int().nonnegative(),
})
export const adminUsersSchema = z.object({ users: z.array(adminUserSchema) })
export const adminUserResultSchema = z.object({ user: adminUserSchema })
export const apiAckSchema = z.object({ ok: z.literal(true), signInAgain: z.boolean().optional() })
export const auditRecordSchema = z.object({
  id: z.number().int().positive(),
  action: z.string(),
  outcome: z.enum(['success', 'failure']),
  occurredAt: z.string().datetime({ offset: true }),
  actor: z.string().nullable(),
  subject: z.string().nullable(),
})
export const auditRecordsSchema = z.object({ events: z.array(auditRecordSchema) })

export const machineCurrentSchema = z.object({
  status: z.enum(['live', 'stale', 'collecting']),
  timeZone: z.string(),
  host: machineHostSchema.nullable(),
  sample: machineMetricSampleSchema.nullable(),
  lastSuccessfulAt: z.string().datetime({ offset: true }).nullable(),
  intervalMs: z.number().int().positive(),
  provenance: z.literal('LOCAL_HOST'),
})

export const machineResourcePointSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  sampleCount: z.number().int().positive(),
  cpuPercent: nullablePercent,
  memoryUsedBytes: nullableBytes,
  memoryTotalBytes: nullableBytes,
  memoryPercent: nullablePercent,
  storageUsedBytes: nullableBytes,
  storageTotalBytes: nullableBytes,
  storagePercent: nullablePercent,
  rxBytesPerSecond: nullableBytes,
  txBytesPerSecond: nullableBytes,
})

export const machineHistorySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  timeZone: z.string(),
  resolution: z.enum(['raw', 'minute']),
  points: z.array(machineResourcePointSchema),
})

export const machineCalendarDaySchema = z.object({
  date: z.string().regex(datePattern),
  status: z.enum(['observed', 'partial', 'no-data', 'future']),
  sampleCount: z.number().int().nonnegative(),
  firstSampleAt: z.string().datetime({ offset: true }).nullable(),
  lastSampleAt: z.string().datetime({ offset: true }).nullable(),
  coveragePercent: z.number().finite().min(0).max(100),
})

export const machineCalendarSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  timeZone: z.string(),
  days: z.array(machineCalendarDaySchema),
})

export const machineEventSchema = z.object({
  id: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  category: z.enum(['collector', 'sample']),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  source: z.literal('local-backend'),
})

export const machineDaySummarySchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  firstSampleAt: z.string().datetime({ offset: true }).nullable(),
  lastSampleAt: z.string().datetime({ offset: true }).nullable(),
  coveragePercent: z.number().finite().min(0).max(100),
  cpuAveragePercent: nullablePercent,
  cpuMaximumPercent: nullablePercent,
  memoryPeakUsedBytes: nullableBytes,
  memoryTotalBytes: nullableBytes,
  memoryPeakPercent: nullablePercent,
  storageSnapshotUsedBytes: nullableBytes,
  storagePeakUsedBytes: nullableBytes,
  storageTotalBytes: nullableBytes,
  networkReceivedBytes: nullableBytes,
  networkTransmittedBytes: nullableBytes,
})

export const machineDaySchema = z.object({
  date: z.string().regex(datePattern),
  timeZone: z.string(),
  status: z.enum(['observed', 'partial', 'no-data', 'future']),
  summary: machineDaySummarySchema.nullable(),
  points: z.array(machineResourcePointSchema),
  events: z.array(machineEventSchema),
  window: z.object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    durationMs: z.number().int().positive(),
  }),
})

export const serverSoftwareSchema = z.enum(['vanilla', 'fabric', 'paper', 'unknown'])
export const serverEulaSchema = z.enum(['accepted', 'not-accepted', 'unknown'])
export const registeredServerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  directory: z.string(),
  source: z.enum(['created', 'imported']),
  software: serverSoftwareSchema,
  version: z.string().nullable(),
  jarName: z.string().nullable(),
  javaPath: z.string().nullable(),
  javaMajor: z.number().int().positive().nullable(),
  minMemoryMb: z.number().int().positive(),
  maxMemoryMb: z.number().int().positive(),
  port: z.number().int().min(1).max(65535).nullable(),
  eula: serverEulaSchema,
  managed: z.boolean(),
  worldFolders: z.array(z.string()),
  createdAt: z.string().datetime({ offset: true }),
})
export const serverInventorySchema = z.object({
  servers: z.array(registeredServerSchema),
  managedRoot: z.string(),
  importRoots: z.array(z.string()),
})
export const localServerSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  source: z.enum(['created', 'imported']),
  software: serverSoftwareSchema,
  version: z.string().nullable(),
  jarName: z.string().nullable(),
  javaMajor: z.number().int().positive().nullable(),
  minMemoryMb: z.number().int().positive(),
  maxMemoryMb: z.number().int().positive(),
  port: z.number().int().min(1).max(65535).nullable(),
  eula: serverEulaSchema,
  managed: z.boolean(),
  worldFolders: z.array(z.string()),
  createdAt: z.string().datetime({ offset: true }),
})
export const localServerListSchema = z.object({ servers: z.array(localServerSummarySchema) })
export const serverImportResultSchema = z.object({ server: localServerSummarySchema })
export const serverImportRequestSchema = z.object({
  path: z.string().trim().min(1).max(1024),
}).strict()
export const serverImportRegistrationSchema = serverImportRequestSchema.extend({
  name: z.string().trim().min(1).max(60),
  minMemoryMb: z.number().int().min(512).max(131072),
  maxMemoryMb: z.number().int().min(512).max(131072),
}).strict().refine((value) => value.maxMemoryMb >= value.minMemoryMb, {
  path: ['maxMemoryMb'], message: 'Maximum memory must be at least the minimum memory.',
})
export const serverImportPreviewSchema = z.object({
  path: z.string(),
  directoryName: z.string(),
  software: serverSoftwareSchema,
  version: z.string().nullable(),
  jarName: z.string().nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  eula: serverEulaSchema,
  worldFolders: z.array(z.string()),
  alreadyRegistered: z.boolean(),
})

export const installSoftwareSchema = z.enum(['vanilla', 'fabric', 'paper'])
export const installCatalogQuerySchema = z.object({
  software: installSoftwareSchema,
  version: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){1,3}$/).optional(),
}).strict()
export const installCatalogSchema = z.object({
  software: installSoftwareSchema,
  versions: z.array(z.string()).max(200),
  loaders: z.array(z.string()).max(100),
  builds: z.array(z.number().int().positive()).max(200),
  installerVersion: z.string().nullable(),
  requiredJavaMajor: z.number().int().positive().nullable(),
}).strict()
export const serverInstallRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
  directoryName: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/).refine((value) => value !== '.' && value !== '..'),
  software: installSoftwareSchema,
  version: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){1,3}$/),
  loaderVersion: z.string().regex(/^\d+(?:\.\d+){1,3}$/).optional(),
  installerVersion: z.string().regex(/^\d+(?:\.\d+){1,3}$/).optional(),
  paperBuild: z.number().int().positive().optional(),
  javaPath: z.string().trim().min(1).max(1024),
  minMemoryMb: z.number().int().min(512).max(131072),
  maxMemoryMb: z.number().int().min(512).max(131072),
  port: z.number().int().min(1).max(65535),
  eulaAccepted: z.boolean(),
}).strict().refine((value) => value.maxMemoryMb >= value.minMemoryMb, {
  path: ['maxMemoryMb'], message: 'Maximum memory must be at least the minimum memory.',
}).refine((value) => value.software !== 'fabric' || Boolean(value.loaderVersion && value.installerVersion), {
  path: ['loaderVersion'], message: 'Choose Fabric loader and installer versions.',
})
export const installOperationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  directoryName: z.string(),
  software: installSoftwareSchema,
  version: z.string(),
  status: z.enum(['pending', 'downloading', 'validating', 'completed', 'failed']),
  progress: z.number().int().min(0).max(100),
  phase: z.string(),
  serverId: z.string().uuid().nullable(),
  artifactUrl: z.string().url().nullable(),
  artifactSize: z.number().int().positive().nullable(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  partialDirectory: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict()
export const installOperationResultSchema = z.object({ operation: installOperationSchema }).strict()
export const installOperationListSchema = z.object({ operations: z.array(installOperationSchema) }).strict()
export const installOperationIdSchema = z.object({ operationId: z.string().uuid() }).strict()
export const javaRuntimeSchema = z.object({
  path: z.string(),
  version: z.string(),
  major: z.number().int().positive(),
  vendor: z.string().nullable(),
  source: z.enum(['discovered', 'custom']),
})
export const javaRuntimeListSchema = z.object({ runtimes: z.array(javaRuntimeSchema) })
export const javaProbeRequestSchema = z.object({ path: z.string().trim().min(1).max(1024) }).strict()

export const calendarQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
})

export const dateParamSchema = z.object({ date: z.string().regex(datePattern) })
export const userIdParamSchema = z.object({ userId: z.string().uuid() }).strict()

export const historyQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(500).default(360),
})

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

export type MachineMetricSample = z.infer<typeof machineMetricSampleSchema>
export type MachineHost = z.infer<typeof machineHostSchema>
export type PublicHealth = z.infer<typeof publicHealthSchema>
export type MachineCurrent = z.infer<typeof machineCurrentSchema>
export type MachineResourcePoint = z.infer<typeof machineResourcePointSchema>
export type MachineHistory = z.infer<typeof machineHistorySchema>
export type MachineCalendarDay = z.infer<typeof machineCalendarDaySchema>
export type MachineCalendar = z.infer<typeof machineCalendarSchema>
export type MachineEvent = z.infer<typeof machineEventSchema>
export type MachineDay = z.infer<typeof machineDaySchema>
export type UserRole = z.infer<typeof userRoleSchema>
export type LandingPage = z.infer<typeof landingPageSchema>
export type AuthUser = z.infer<typeof authUserSchema>
export type AuthMe = z.infer<typeof authMeSchema>
export type AdminUser = z.infer<typeof adminUserSchema>
export type AuditRecord = z.infer<typeof auditRecordSchema>
export type RegisteredServer = z.infer<typeof registeredServerSchema>
export type ServerInventory = z.infer<typeof serverInventorySchema>
export type LocalServerSummary = z.infer<typeof localServerSummarySchema>
export type ServerImportPreview = z.infer<typeof serverImportPreviewSchema>
export type JavaRuntime = z.infer<typeof javaRuntimeSchema>
export type InstallSoftware = z.infer<typeof installSoftwareSchema>
export type InstallCatalog = z.infer<typeof installCatalogSchema>
export type ServerInstallRequest = z.infer<typeof serverInstallRequestSchema>
export type InstallOperation = z.infer<typeof installOperationSchema>
