import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const machines = sqliteTable('machines', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  platform: text('platform').notNull(),
  distro: text('distro'),
  release: text('release'),
  architecture: text('architecture').notNull(),
  cpuModel: text('cpu_model'),
  coreCount: integer('core_count'),
  uptimeSeconds: real('uptime_seconds'),
  source: text('source').notNull(),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
})

export const machineSamples = sqliteTable('machine_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  machineId: text('machine_id').notNull().references(() => machines.id),
  collectedAt: text('collected_at').notNull(),
  minuteStart: text('minute_start').notNull(),
  localDate: text('local_date').notNull(),
  timeZone: text('time_zone').notNull(),
  cpuPercent: real('cpu_percent'),
  coreCount: integer('core_count'),
  loadOne: real('load_one'),
  loadFive: real('load_five'),
  loadFifteen: real('load_fifteen'),
  memoryUsedBytes: integer('memory_used_bytes'),
  memoryAvailableBytes: integer('memory_available_bytes'),
  memoryTotalBytes: integer('memory_total_bytes'),
  swapUsedBytes: integer('swap_used_bytes'),
  swapTotalBytes: integer('swap_total_bytes'),
  storageDevice: text('storage_device'),
  storageMount: text('storage_mount'),
  storageUsedBytes: integer('storage_used_bytes'),
  storageAvailableBytes: integer('storage_available_bytes'),
  storageTotalBytes: integer('storage_total_bytes'),
  networkInterface: text('network_interface'),
  networkRxBytesPerSecond: real('network_rx_bytes_per_second'),
  networkTxBytesPerSecond: real('network_tx_bytes_per_second'),
  networkRxTransferredBytes: real('network_rx_transferred_bytes'),
  networkTxTransferredBytes: real('network_tx_transferred_bytes'),
  sampleStatus: text('sample_status').notNull(),
  unavailableFields: text('unavailable_fields').notNull(),
  source: text('source').notNull(),
}, (table) => [
  uniqueIndex('machine_samples_machine_collected_unique').on(table.machineId, table.collectedAt),
  index('machine_samples_machine_date_idx').on(table.machineId, table.localDate, table.collectedAt),
  index('machine_samples_machine_time_idx').on(table.machineId, table.collectedAt),
])

export const machineMinuteRollups = sqliteTable('machine_minute_rollups', {
  machineId: text('machine_id').notNull().references(() => machines.id),
  timeZone: text('time_zone').notNull(),
  localDate: text('local_date').notNull(),
  minuteStart: text('minute_start').notNull(),
  sampleCount: integer('sample_count').notNull(),
  cpuSum: real('cpu_sum'),
  cpuCount: integer('cpu_count').notNull(),
  cpuMinimum: real('cpu_minimum'),
  cpuMaximum: real('cpu_maximum'),
  memoryPeakUsedBytes: integer('memory_peak_used_bytes'),
  memoryTotalBytes: integer('memory_total_bytes'),
  memoryPeakPercent: real('memory_peak_percent'),
  storageLastUsedBytes: integer('storage_last_used_bytes'),
  storagePeakUsedBytes: integer('storage_peak_used_bytes'),
  storageTotalBytes: integer('storage_total_bytes'),
  networkRxRateSum: real('network_rx_rate_sum'),
  networkTxRateSum: real('network_tx_rate_sum'),
  networkRateCount: integer('network_rate_count').notNull(),
  networkReceivedBytes: real('network_received_bytes'),
  networkTransmittedBytes: real('network_transmitted_bytes'),
  firstSampleAt: text('first_sample_at').notNull(),
  lastSampleAt: text('last_sample_at').notNull(),
}, (table) => [
  uniqueIndex('machine_minute_rollups_key_unique').on(table.machineId, table.timeZone, table.minuteStart),
  index('machine_minute_rollups_date_idx').on(table.machineId, table.timeZone, table.localDate, table.minuteStart),
])

export const machineDayRollups = sqliteTable('machine_day_rollups', {
  machineId: text('machine_id').notNull().references(() => machines.id),
  timeZone: text('time_zone').notNull(),
  localDate: text('local_date').notNull(),
  sampleCount: integer('sample_count').notNull(),
  cpuSum: real('cpu_sum'),
  cpuCount: integer('cpu_count').notNull(),
  cpuMinimum: real('cpu_minimum'),
  cpuMaximum: real('cpu_maximum'),
  memoryPeakUsedBytes: integer('memory_peak_used_bytes'),
  memoryTotalBytes: integer('memory_total_bytes'),
  memoryPeakPercent: real('memory_peak_percent'),
  storageSnapshotUsedBytes: integer('storage_snapshot_used_bytes'),
  storagePeakUsedBytes: integer('storage_peak_used_bytes'),
  storageTotalBytes: integer('storage_total_bytes'),
  networkReceivedBytes: real('network_received_bytes'),
  networkTransmittedBytes: real('network_transmitted_bytes'),
  firstSampleAt: text('first_sample_at').notNull(),
  lastSampleAt: text('last_sample_at').notNull(),
}, (table) => [
  uniqueIndex('machine_day_rollups_key_unique').on(table.machineId, table.timeZone, table.localDate),
  index('machine_day_rollups_month_idx').on(table.machineId, table.timeZone, table.localDate),
])

export const machineEvents = sqliteTable('machine_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  machineId: text('machine_id').notNull(),
  occurredAt: text('occurred_at').notNull(),
  timeZone: text('time_zone').notNull(),
  localDate: text('local_date').notNull(),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  message: text('message').notNull(),
  source: text('source').notNull(),
}, (table) => [
  index('machine_events_date_idx').on(table.machineId, table.timeZone, table.localDate, table.occurredAt),
])

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  usernameKey: text('username_key').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['administrator', 'member'] }).notNull(),
  passwordHash: text('password_hash').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  avatarKey: text('avatar_key'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastLoginAt: text('last_login_at'),
  passwordChangedAt: text('password_changed_at').notNull(),
}, (table) => [
  uniqueIndex('users_username_key_unique').on(table.usernameKey),
  index('users_enabled_role_idx').on(table.enabled, table.role),
  check('users_role_check', sql`${table.role} IN ('administrator', 'member')`),
  check('users_enabled_check', sql`${table.enabled} IN (0, 1)`),
])

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  csrfHash: text('csrf_hash').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  revokedAt: text('revoked_at'),
}, (table) => [
  index('sessions_user_active_idx').on(table.userId, table.revokedAt, table.expiresAt),
  check('sessions_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
])

export const authState = sqliteTable('auth_state', {
  id: integer('id').primaryKey(),
  bootstrapHash: text('bootstrap_hash'),
  bootstrapExpiresAt: text('bootstrap_expires_at'),
  bootstrapConsumedAt: text('bootstrap_consumed_at'),
  initializedAt: text('initialized_at'),
}, (table) => [check('auth_state_singleton_check', sql`${table.id} = 1`)])

export const workspacePreferences = sqliteTable('workspace_preferences', {
  id: integer('id').primaryKey(),
  displayName: text('display_name').notNull(),
  defaultLanding: text('default_landing', { enum: ['dashboard', 'machine'] }).notNull().default('dashboard'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('workspace_preferences_singleton_check', sql`${table.id} = 1`),
  check('workspace_preferences_landing_check', sql`${table.defaultLanding} IN ('dashboard', 'machine')`),
])

export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  compactNavigation: integer('compact_navigation', { mode: 'boolean' }).notNull().default(false),
  defaultLanding: text('default_landing', { enum: ['dashboard', 'machine'] }).notNull().default('dashboard'),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('user_preferences_landing_check', sql`${table.defaultLanding} IN ('dashboard', 'machine')`),
])

export const auditEvents = sqliteTable('security_audit_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  subjectUserId: text('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  outcome: text('outcome', { enum: ['success', 'failure'] }).notNull(),
  occurredAt: text('occurred_at').notNull(),
}, (table) => [
  index('security_audit_events_time_idx').on(table.occurredAt),
  index('security_audit_events_actor_idx').on(table.actorUserId, table.occurredAt),
  check('security_audit_events_outcome_check', sql`${table.outcome} IN ('success', 'failure')`),
])

export const localServers = sqliteTable('local_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  directory: text('directory').notNull(),
  source: text('source', { enum: ['created', 'imported'] }).notNull(),
  software: text('software', { enum: ['vanilla', 'fabric', 'paper', 'unknown'] }).notNull(),
  version: text('version'),
  jarName: text('jar_name'),
  javaPath: text('java_path'),
  javaMajor: integer('java_major'),
  minMemoryMb: integer('min_memory_mb').notNull(),
  maxMemoryMb: integer('max_memory_mb').notNull(),
  port: integer('port'),
  eula: text('eula', { enum: ['accepted', 'not-accepted', 'unknown'] }).notNull(),
  managed: integer('managed', { mode: 'boolean' }).notNull().default(false),
  worldFolders: text('world_folders').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('local_servers_directory_unique').on(table.directory),
  index('local_servers_created_at_idx').on(table.createdAt),
  check('local_servers_source_check', sql`${table.source} IN ('created', 'imported')`),
  check('local_servers_software_check', sql`${table.software} IN ('vanilla', 'fabric', 'paper', 'unknown')`),
  check('local_servers_memory_check', sql`${table.minMemoryMb} >= 512 AND ${table.maxMemoryMb} >= ${table.minMemoryMb}`),
  check('local_servers_port_check', sql`${table.port} IS NULL OR (${table.port} >= 1 AND ${table.port} <= 65535)`),
  check('local_servers_eula_check', sql`${table.eula} IN ('accepted', 'not-accepted', 'unknown')`),
  check('local_servers_managed_check', sql`${table.managed} IN (0, 1)`),
])

export const localServerEvents = sqliteTable('local_server_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serverId: text('server_id').references(() => localServers.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  outcome: text('outcome', { enum: ['success', 'failure'] }).notNull(),
  occurredAt: text('occurred_at').notNull(),
  detail: text('detail').notNull(),
}, (table) => [
  index('local_server_events_time_idx').on(table.occurredAt),
  index('local_server_events_server_idx').on(table.serverId, table.occurredAt),
  check('local_server_events_outcome_check', sql`${table.outcome} IN ('success', 'failure')`),
])

export const serverInstallOperations = sqliteTable('server_install_operations', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  serverId: text('server_id').references(() => localServers.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  directoryName: text('directory_name').notNull(),
  software: text('software', { enum: ['vanilla', 'fabric', 'paper'] }).notNull(),
  version: text('version').notNull(),
  requestJson: text('request_json').notNull(),
  status: text('status', { enum: ['pending', 'downloading', 'validating', 'completed', 'failed'] }).notNull(),
  progress: integer('progress').notNull(),
  phase: text('phase').notNull(),
  artifactUrl: text('artifact_url'),
  artifactSize: integer('artifact_size'),
  artifactSha1: text('artifact_sha1'),
  artifactSha256: text('artifact_sha256'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  partialDirectory: text('partial_directory'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('server_install_operations_time_idx').on(table.createdAt),
  index('server_install_operations_status_idx').on(table.status, table.updatedAt),
  check('server_install_operations_status_check', sql`${table.status} IN ('pending', 'downloading', 'validating', 'completed', 'failed')`),
  check('server_install_operations_progress_check', sql`${table.progress} >= 0 AND ${table.progress} <= 100`),
])

export const localServerRuntime = sqliteTable('local_server_runtime', {
  serverId: text('server_id').primaryKey().references(() => localServers.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['stopped', 'starting', 'running', 'stopping', 'crashed', 'error', 'external/unmanaged'] }).notNull(),
  processPid: integer('process_pid'),
  processStartMarker: text('process_start_marker'),
  processBootId: text('process_boot_id'),
  startedAt: text('started_at'),
  updatedAt: text('updated_at').notNull(),
  lastExitCode: integer('last_exit_code'),
  errorMessage: text('error_message'),
  restartRequired: integer('restart_required', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('local_server_runtime_status_idx').on(table.status, table.updatedAt),
  check('local_server_runtime_status_check', sql`${table.status} IN ('stopped', 'starting', 'running', 'stopping', 'crashed', 'error', 'external/unmanaged')`),
  check('local_server_runtime_restart_check', sql`${table.restartRequired} IN (0, 1)`),
])

export const localServerConsoleEntries = sqliteTable('local_server_console_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  occurredAt: text('occurred_at').notNull(),
  source: text('source', { enum: ['stdout', 'stderr', 'system', 'command'] }).notNull(),
  severity: text('severity', { enum: ['info', 'warn', 'error', 'debug'] }).notNull(),
  message: text('message').notNull(),
}, (table) => [
  index('local_server_console_entries_order_idx').on(table.serverId, table.id),
  check('local_server_console_entries_source_check', sql`${table.source} IN ('stdout', 'stderr', 'system', 'command')`),
  check('local_server_console_entries_severity_check', sql`${table.severity} IN ('info', 'warn', 'error', 'debug')`),
])

export const localServerPropertiesBackups = sqliteTable('local_server_properties_backups', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  fileName: text('file_name').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('local_server_properties_backups_server_time_idx').on(table.serverId, table.createdAt),
])

export const localServerStatusSamples = sqliteTable('local_server_status_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  checkedAt: text('checked_at').notNull(),
  state: text('state', { enum: ['reachable', 'unreachable'] }).notNull(),
  playersOnline: integer('players_online'),
  playersMax: integer('players_max'),
  versionName: text('version_name'),
  description: text('description'),
  latencyMs: integer('latency_ms'),
  errorCode: text('error_code'),
  source: text('source').notNull().default('local-status-ping'),
}, (table) => [index('local_server_status_samples_server_time_idx').on(table.serverId, table.checkedAt)])
