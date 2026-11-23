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
  runtimeStatus: z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed', 'error', 'external/unmanaged']).optional(),
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
export const localServerIdSchema = z.object({ serverId: z.string().uuid() }).strict()
export const serverRuntimeStatusSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed', 'error', 'external/unmanaged', 'unavailable'])
export const serverRuntimeSchema = z.object({
  serverId: z.string().uuid(),
  status: serverRuntimeStatusSchema,
  startedAt: z.string().datetime({ offset: true }).nullable(),
  uptimeSeconds: z.number().finite().nonnegative().nullable(),
  memoryRssBytes: z.number().int().nonnegative().nullable(),
  cpuPercent: z.number().finite().min(0).max(100).nullable(),
  ready: z.boolean(),
  playersOnline: z.null(),
  eula: serverEulaSchema,
  restartRequired: z.boolean(),
  lastExitCode: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
}).strict()
export const serverRuntimeResultSchema = z.object({ runtime: serverRuntimeSchema }).strict()
export const serverStatusSchema = z.object({
  serverId: z.string().uuid(),
  checkedAt: z.string().datetime({ offset: true }),
  source: z.literal('local-status-ping'),
  state: z.enum(['reachable', 'unreachable', 'unavailable']),
  playersOnline: z.number().int().nonnegative().nullable(),
  playersMax: z.number().int().nonnegative().nullable(),
  versionName: z.string().max(120).nullable(),
  description: z.string().max(256).nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
  authoritativePlayerList: z.literal(false),
}).strict()
export const serverStatusResultSchema = z.object({ status: serverStatusSchema }).strict()
export const serverPlayerListSchema = z.object({
  serverId: z.string().uuid(),
  state: z.enum(['authoritative', 'unavailable']),
  source: z.enum(['owned-console-list', 'unavailable']),
  sampledAt: z.string().datetime({ offset: true }).nullable(),
  names: z.array(z.string().regex(/^[A-Za-z0-9_]{3,16}$/)).max(500),
  reason: z.string().max(160).nullable(),
}).strict()
export const serverPlayerListResultSchema = z.object({ players: serverPlayerListSchema }).strict()
export const serverPlayerActionSchema = z.enum(['kick', 'ban', 'pardon', 'op', 'deop', 'whitelist-add', 'whitelist-remove', 'whitelist-list'])
export const serverPlayerActionRequestSchema = z.object({
  action: serverPlayerActionSchema,
  username: z.string().trim().regex(/^[A-Za-z0-9_]{3,16}$/).optional(),
}).strict().refine((value) => value.action === 'whitelist-list' ? value.username === undefined : value.username !== undefined, {
  path: ['username'], message: 'A valid player name is required for this action.',
})
export const serverPlayerActionResultSchema = z.object({
  state: z.enum(['confirmed', 'unverified']),
  action: serverPlayerActionSchema,
  username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/).nullable(),
  submittedAt: z.string().datetime({ offset: true }),
  confirmedAt: z.string().datetime({ offset: true }).nullable(),
}).strict()
export const serverModEntrySchema = z.object({
  id: z.string().min(1).max(180),
  fileName: z.string().min(1).max(180),
  sizeBytes: z.number().int().nonnegative(),
  state: z.enum(['enabled', 'disabled', 'quarantined']),
  metadataKind: z.enum(['fabric', 'paper', 'unknown']),
  metadataState: z.enum(['known', 'unknown']),
  modId: z.string().max(128).nullable(),
  name: z.string().max(160).nullable(),
  artifactVersion: z.string().max(120).nullable(),
  minecraftConstraint: z.string().max(120).nullable(),
  loaderConstraint: z.string().max(120).nullable(),
  dependencies: z.array(z.string().max(128)).max(64).nullable(),
}).strict()
export const serverModsInventorySchema = z.object({
  serverId: z.string().uuid(),
  supported: z.boolean(),
  loader: z.enum(['fabric', 'paper', 'unsupported']),
  loadDirectory: z.string().max(16).nullable(),
  items: z.array(serverModEntrySchema).max(300),
  truncated: z.boolean(),
  restartRequired: z.boolean(),
  runtimeStatus: z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed', 'error', 'external/unmanaged', 'unavailable']),
}).strict()
export const serverModsInventoryResultSchema = z.object({ mods: serverModsInventorySchema }).strict()
export const serverModMutationResultSchema = z.object({ ok: z.literal(true), restartRequired: z.boolean() }).strict()
export const serverConsoleEntrySchema = z.object({
  id: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  source: z.enum(['stdout', 'stderr', 'system', 'command']),
  severity: z.enum(['info', 'warn', 'error', 'debug']),
  message: z.string().max(8192),
}).strict()
export const serverConsoleResponseSchema = z.object({ entries: z.array(serverConsoleEntrySchema), nextAfter: z.number().int().nonnegative().nullable() }).strict()
export const serverConsoleQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(500).default(200) }).strict()
export const serverCommandSchema = z.object({ command: z.string().min(1).max(256).refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)) }).strict()
export const serverPropertySettingsSchema = z.object({
  motd: z.string().max(120).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'MOTD cannot contain control characters.'),
  gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']),
  maxPlayers: z.number().int().min(1).max(500),
  viewDistance: z.number().int().min(2).max(32),
  simulationDistance: z.number().int().min(2).max(32),
  spawnProtection: z.number().int().min(0).max(128),
  pvp: z.boolean(),
  whiteList: z.boolean(),
  allowNether: z.boolean(),
}).strict()
export const serverPropertiesUpdateSchema = serverPropertySettingsSchema.partial().strict().refine((value) => Object.keys(value).length > 0, 'At least one property change is required.')
export const serverPropertiesBackupSchema = z.object({ id: z.string().uuid(), createdAt: z.string().datetime({ offset: true }), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const serverPropertiesResponseSchema = z.object({
  settings: serverPropertySettingsSchema,
  unknownKeys: z.array(z.string()).max(256),
  backups: z.array(serverPropertiesBackupSchema).max(20),
  restartRequired: z.boolean(),
}).strict()
export const serverPropertiesResultSchema = z.object({ properties: serverPropertiesResponseSchema }).strict()
export const serverPropertiesRestorePreviewSchema = z.object({
  backupId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  checksumValid: z.boolean(),
  backupSha256: z.string().regex(/^[a-f0-9]{64}$/),
  currentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  running: z.boolean(),
  restartRequiredAfterRestore: z.boolean(),
  otherContentDiffers: z.boolean(),
  changedSettings: z.array(z.object({ key: z.string().max(80), current: z.string().max(160), restored: z.string().max(160) }).strict()).max(32),
}).strict()
export const serverPropertiesRestorePreviewResultSchema = z.object({ preview: serverPropertiesRestorePreviewSchema }).strict()
export const serverPropertiesRestoreRequestSchema = z.object({ expectedCurrentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const serverPropertiesRestoreResultSchema = z.object({ properties: serverPropertiesResponseSchema, recoveryBackupId: z.string().uuid().nullable() }).strict()
export const serverPropertiesBackupIdParamSchema = z.object({ serverId: z.string().uuid(), backupId: z.string().uuid() }).strict()
export const serverFileEntrySchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().max(2048),
  kind: z.enum(['folder', 'file', 'symlink', 'unsupported']),
  sizeBytes: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string().datetime({ offset: true }).nullable(),
  contentState: z.enum(['editable', 'read-only', 'binary', 'oversized', 'protected', 'unsafe']),
  reason: z.string().max(180).nullable(),
  canDownload: z.boolean(),
  canEdit: z.boolean(),
  canRename: z.boolean(),
  canTrash: z.boolean(),
}).strict()
export const serverFileListSchema = z.object({
  serverId: z.string().uuid(),
  path: z.string().max(2048),
  breadcrumbs: z.array(z.object({ name: z.string().max(255), path: z.string().max(2048) }).strict()).max(64),
  entries: z.array(serverFileEntrySchema).max(500),
  truncated: z.boolean(),
  trashCount: z.number().int().nonnegative(),
}).strict()
export const serverFileReadSchema = z.object({
  path: z.string().max(2048),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime({ offset: true }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  text: z.string().max(524288).nullable(),
  contentState: z.enum(['editable', 'read-only', 'binary', 'oversized', 'protected', 'unsafe']),
  reason: z.string().max(180).nullable(),
}).strict()
export const serverFileWriteSchema = z.object({ path: z.string().min(1).max(2048), text: z.string().max(524288), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const serverFileCreateSchema = z.object({ path: z.string().min(1).max(2048), kind: z.enum(['file', 'folder']), text: z.string().max(524288).optional() }).strict().refine((value) => value.kind === 'file' || value.text === undefined)
export const serverFileMoveSchema = z.object({ sourcePath: z.string().min(1).max(2048), destinationPath: z.string().min(1).max(2048) }).strict()
export const serverFileTrashSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(255),
  originalPath: z.string().max(2048),
  kind: z.enum(['file', 'folder']),
  sizeBytes: z.number().int().nonnegative().nullable(),
  deletedAt: z.string().datetime({ offset: true }),
}).strict()
export const serverFileTrashListSchema = z.object({ items: z.array(serverFileTrashSchema).max(500) }).strict()
export const serverFileTrashResultSchema = z.object({ item: serverFileTrashSchema, inventory: serverFileListSchema }).strict()
export const serverFileTrashRestoreSchema = z.object({ id: z.string().uuid() }).strict()
export const serverFileRecoverySchema = z.object({ id: z.string().uuid(), path: z.string().max(2048), sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime({ offset: true }) }).strict()
export const serverFileRecoveryListSchema = z.object({ items: z.array(serverFileRecoverySchema).max(100) }).strict()
export const serverFileRecoveryRestoreSchema = z.object({ expectedCurrentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const serverFilePathQuerySchema = z.object({ path: z.string().max(2048).default('') }).strict()
export const serverFileReadQuerySchema = z.object({ path: z.string().min(1).max(2048) }).strict()
export const serverFileIdParamSchema = z.object({ serverId: z.string().uuid(), id: z.string().uuid() }).strict()
export const serverWorldEntrySchema = z.object({
  name: z.string().max(255),
  path: z.string().max(2048),
  dimension: z.enum(['overworld', 'nether', 'end', 'custom']),
  state: z.enum(['available', 'missing', 'incomplete', 'unsafe']),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sizeComplete: z.boolean(),
  modifiedAt: z.string().datetime({ offset: true }).nullable(),
  backupAvailable: z.boolean(),
  reason: z.string().max(300).nullable(),
}).strict()
export const serverWorldsSchema = z.object({
  serverId: z.string().uuid(),
  status: z.enum(['available', 'unavailable']),
  levelName: z.string().max(2048).nullable(),
  levelNameSource: z.enum(['server.properties', 'minecraft-default', 'unavailable']),
  entries: z.array(serverWorldEntrySchema).max(100),
  reason: z.string().max(300).nullable(),
}).strict()
export const serverWorldsResultSchema = z.object({ worlds: serverWorldsSchema }).strict()

export const serverHistoryScopeSchema = z.union([z.literal('all'), z.string().uuid()])
export const serverHistoryCalendarQuerySchema = z.object({
  scope: serverHistoryScopeSchema.default('all'),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
}).strict()
export const serverHistoryDayQuerySchema = z.object({
  scope: serverHistoryScopeSchema.default('all'),
  date: z.string().regex(datePattern),
}).strict()
export const serverHistoryCalendarDaySchema = z.object({
  date: z.string().regex(datePattern),
  status: z.enum(['observed', 'partial', 'no-data', 'future']),
  sampleCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  firstSampleAt: z.string().datetime({ offset: true }).nullable(),
  lastSampleAt: z.string().datetime({ offset: true }).nullable(),
  coveragePercent: z.number().finite().min(0).max(100),
}).strict()
export const serverHistoryCalendarSchema = z.object({
  scope: serverHistoryScopeSchema,
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  timeZone: z.string(),
  days: z.array(serverHistoryCalendarDaySchema).max(31),
}).strict()
export const serverHistoryPointSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  sampleCount: z.number().int().positive(),
  serverCount: z.number().int().positive(),
  cpuAveragePercent: nullablePercent,
  memoryPeakBytes: nullableBytes,
  playersPeak: z.number().int().nonnegative().nullable(),
  uptimePeakSeconds: z.number().int().nonnegative().nullable(),
}).strict()
export const serverHistoryEventSchema = z.object({
  id: z.number().int().positive(),
  serverId: z.string().uuid(),
  serverName: z.string().max(255),
  occurredAt: z.string().datetime({ offset: true }),
  category: z.enum(['server', 'player', 'moderation']),
  eventType: z.string().max(80),
  description: z.string().max(300),
  rawMessage: z.string().max(8192).nullable(),
  confidence: z.enum(['high', 'medium']),
  source: z.enum(['owned-log', 'panel-process']),
}).strict()
export const serverHistorySessionSchema = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  serverName: z.string().max(255),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).nullable(),
  outcome: z.enum(['running', 'stopped', 'crashed', 'interrupted']),
  uptimeSeconds: z.number().int().nonnegative().nullable(),
  durationInDaySeconds: z.number().int().nonnegative(),
}).strict()
export const serverHistoryDaySchema = z.object({
  scope: serverHistoryScopeSchema,
  date: z.string().regex(datePattern),
  timeZone: z.string(),
  status: z.enum(['observed', 'partial', 'no-data', 'future']),
  summary: z.object({
    sampleCount: z.number().int().nonnegative(),
    firstSampleAt: z.string().datetime({ offset: true }).nullable(),
    lastSampleAt: z.string().datetime({ offset: true }).nullable(),
    coveragePercent: z.number().finite().min(0).max(100),
    cpuAveragePercent: nullablePercent,
    cpuMaximumPercent: nullablePercent,
    memoryPeakBytes: nullableBytes,
    playersPeak: z.number().int().nonnegative().nullable(),
    uptimeSeconds: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
  }).strict().nullable(),
  points: z.array(serverHistoryPointSchema).max(3000),
  events: z.array(serverHistoryEventSchema).max(500),
  eventsTruncated: z.boolean(),
  sessions: z.array(serverHistorySessionSchema).max(200),
  sessionsTruncated: z.boolean(),
  window: z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), durationMs: z.number().int().positive() }).strict(),
}).strict()
export const serverHistoryCalendarResultSchema = z.object({ calendar: serverHistoryCalendarSchema }).strict()
export const serverHistoryDayResultSchema = z.object({ day: serverHistoryDaySchema }).strict()
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
export type ServerRuntime = z.infer<typeof serverRuntimeSchema>
export type ServerStatus = z.infer<typeof serverStatusSchema>
export type ServerPlayerList = z.infer<typeof serverPlayerListSchema>
export type ServerPlayerAction = z.infer<typeof serverPlayerActionSchema>
export type ServerPlayerActionResult = z.infer<typeof serverPlayerActionResultSchema>
export type ServerModEntry = z.infer<typeof serverModEntrySchema>
export type ServerModsInventory = z.infer<typeof serverModsInventorySchema>
export type ServerConsoleEntry = z.infer<typeof serverConsoleEntrySchema>
export type ServerPropertySettings = z.infer<typeof serverPropertySettingsSchema>
export type ServerPropertiesUpdate = z.infer<typeof serverPropertiesUpdateSchema>
export type ServerPropertiesResponse = z.infer<typeof serverPropertiesResponseSchema>
export type ServerPropertiesRestorePreview = z.infer<typeof serverPropertiesRestorePreviewSchema>
export type ServerFileEntry = z.infer<typeof serverFileEntrySchema>
export type ServerFileList = z.infer<typeof serverFileListSchema>
export type ServerFileRead = z.infer<typeof serverFileReadSchema>
export type ServerFileTrash = z.infer<typeof serverFileTrashSchema>
export type ServerFileRecovery = z.infer<typeof serverFileRecoverySchema>
export type ServerWorldEntry = z.infer<typeof serverWorldEntrySchema>
export type ServerWorlds = z.infer<typeof serverWorldsSchema>
export type ServerHistoryCalendar = z.infer<typeof serverHistoryCalendarSchema>
export type ServerHistoryCalendarDay = z.infer<typeof serverHistoryCalendarDaySchema>
export type ServerHistoryScope = z.infer<typeof serverHistoryScopeSchema>
export type ServerHistoryPoint = z.infer<typeof serverHistoryPointSchema>
export type ServerHistoryEvent = z.infer<typeof serverHistoryEventSchema>
export type ServerHistorySession = z.infer<typeof serverHistorySessionSchema>
export type ServerHistoryDay = z.infer<typeof serverHistoryDaySchema>
