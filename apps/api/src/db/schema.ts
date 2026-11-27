import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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

export const machineStorageSamples = sqliteTable('machine_storage_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  machineId: text('machine_id').notNull().references(() => machines.id),
  volumeId: text('volume_id').notNull(),
  name: text('name').notNull(),
  roles: text('roles').notNull(),
  collectedAt: text('collected_at').notNull(),
  minuteStart: text('minute_start').notNull(),
  localDate: text('local_date').notNull(),
  timeZone: text('time_zone').notNull(),
  usedBytes: integer('used_bytes'),
  availableBytes: integer('available_bytes'),
  totalBytes: integer('total_bytes'),
  usedPercent: real('used_percent'),
}, (table) => [
  uniqueIndex('machine_storage_samples_key_unique').on(table.machineId, table.volumeId, table.collectedAt),
  index('machine_storage_samples_volume_time_idx').on(table.machineId, table.volumeId, table.collectedAt),
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
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
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
  check('users_must_change_password_check', sql`${table.mustChangePassword} IN (0, 1)`),
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
  language: text('language', { enum: ['en', 'ru'] }).notNull().default('en'),
  theme: text('theme', { enum: ['dark', 'light', 'system'] }).notNull().default('dark'),
  accent: text('accent', { enum: ['moss', 'blue', 'clay'] }).notNull().default('moss'),
  density: text('density', { enum: ['comfortable', 'compact'] }).notNull().default('comfortable'),
  reducedMotion: integer('reduced_motion', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('user_preferences_landing_check', sql`${table.defaultLanding} IN ('dashboard', 'machine')`),
  check('user_preferences_language_check', sql`${table.language} IN ('en', 'ru')`),
  check('user_preferences_theme_check', sql`${table.theme} IN ('dark', 'light', 'system')`),
  check('user_preferences_accent_check', sql`${table.accent} IN ('moss', 'blue', 'clay')`),
  check('user_preferences_density_check', sql`${table.density} IN ('comfortable', 'compact')`),
])

export const serverTemplates = sqliteTable('server_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  software: text('software', { enum: ['vanilla', 'fabric', 'paper'] }).notNull(),
  loader: text('loader', { enum: ['forge', 'neoforge'] }),
  version: text('version').notNull(),
  minMemoryMb: integer('min_memory_mb').notNull(),
  maxMemoryMb: integer('max_memory_mb').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('server_templates_name_unique').on(sql`lower(${table.name})`),
  index('server_templates_updated_idx').on(table.updatedAt),
  check('server_templates_software_check', sql`${table.software} IN ('vanilla', 'fabric', 'paper')`),
  check('server_templates_memory_check', sql`${table.minMemoryMb} >= 512 AND ${table.maxMemoryMb} >= ${table.minMemoryMb} AND ${table.maxMemoryMb} <= 131072`),
])

export const userNotificationReads = sqliteTable('user_notification_reads', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull(),
  readAt: text('read_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.eventId], name: 'user_notification_reads_pk' }),
  index('user_notification_reads_read_idx').on(table.userId, table.readAt),
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
  loader: text('loader', { enum: ['forge', 'neoforge'] }),
  version: text('version'),
  jarName: text('jar_name'),
  javaPath: text('java_path'),
  javaMajor: integer('java_major'),
  javaSelectionMode: text('java_selection_mode', { enum: ['auto', 'manual'] }).notNull().default('manual'),
  javaCompatibilityOverrideHash: text('java_compatibility_override_hash'),
  requiredJavaMajor: integer('required_java_major'),
  minMemoryMb: integer('min_memory_mb').notNull(),
  maxMemoryMb: integer('max_memory_mb').notNull(),
  jvmOptionsJson: text('jvm_options_json').notNull().default('{"collector":"default","maxGCPauseMs":null,"parallelGcThreads":null,"alwaysPreTouch":false,"disableExplicitGc":false}'),
  startScriptSha256: text('start_script_sha256'),
  port: integer('port'),
  eula: text('eula', { enum: ['accepted', 'not-accepted', 'unknown'] }).notNull(),
  managed: integer('managed', { mode: 'boolean' }).notNull().default(false),
  worldFolders: text('world_folders').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  removedAt: text('removed_at'),
}, (table) => [
  uniqueIndex('local_servers_directory_unique').on(table.directory).where(sql`${table.removedAt} IS NULL`),
  index('local_servers_created_at_idx').on(table.createdAt),
  check('local_servers_source_check', sql`${table.source} IN ('created', 'imported')`),
  check('local_servers_software_check', sql`${table.software} IN ('vanilla', 'fabric', 'paper', 'unknown')`),
  check('local_servers_java_selection_mode_check', sql`${table.javaSelectionMode} IN ('auto', 'manual')`),
  check('local_servers_memory_check', sql`${table.minMemoryMb} >= 512 AND ${table.maxMemoryMb} >= ${table.minMemoryMb}`),
  check('local_servers_port_check', sql`${table.port} IS NULL OR (${table.port} >= 1 AND ${table.port} <= 65535)`),
  check('local_servers_eula_check', sql`${table.eula} IN ('accepted', 'not-accepted', 'unknown')`),
  check('local_servers_managed_check', sql`${table.managed} IN (0, 1)`),
])

export const localServerRemovalOperations = sqliteTable('local_server_removal_operations', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id),
  mode: text('mode', { enum: ['unregister', 'permanent'] }).notNull(),
  state: text('state', { enum: ['prepared', 'quarantined', 'purging', 'unregistered', 'purged', 'failed', 'recovery-required'] }).notNull(),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  serverName: text('server_name').notNull(),
  directory: text('directory').notNull(),
  source: text('source', { enum: ['created', 'imported'] }).notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('local_server_removal_operations_server_time_idx').on(table.serverId, table.createdAt),
  index('local_server_removal_operations_state_idx').on(table.state, table.createdAt),
  check('local_server_removal_operations_mode_check', sql`${table.mode} IN ('unregister', 'permanent')`),
  check('local_server_removal_operations_state_check', sql`${table.state} IN ('prepared', 'quarantined', 'purging', 'unregistered', 'purged', 'failed', 'recovery-required')`),
])

export const serverZipImports = sqliteTable('server_zip_imports', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  uploadName: text('upload_name').notNull(),
  compressedBytes: integer('compressed_bytes').notNull(),
  previewJson: text('preview_json').notNull(),
  state: text('state', { enum: ['ready', 'importing', 'published', 'expired', 'failed'] }).notNull(),
  serverId: text('server_id').references(() => localServers.id, { onDelete: 'set null' }),
  errorCode: text('error_code'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, (table) => [
  index('server_zip_imports_actor_time_idx').on(table.actorUserId, table.createdAt),
  index('server_zip_imports_state_expiry_idx').on(table.state, table.expiresAt),
  check('server_zip_imports_size_check', sql`${table.compressedBytes} >= 0`),
  check('server_zip_imports_state_check', sql`${table.state} IN ('ready', 'importing', 'published', 'expired', 'failed')`),
])

export const serverAccessGrants = sqliteTable('server_access_grants', {
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  viewServer: integer('view_server', { mode: 'boolean' }).notNull().default(false),
  viewLogs: integer('view_logs', { mode: 'boolean' }).notNull().default(false),
  sendConsoleCommands: integer('send_console_commands', { mode: 'boolean' }).notNull().default(false),
  controlLifecycle: integer('control_lifecycle', { mode: 'boolean' }).notNull().default(false),
  startServer: integer('start_server', { mode: 'boolean' }).notNull().default(false),
  stopServer: integer('stop_server', { mode: 'boolean' }).notNull().default(false),
  restartServer: integer('restart_server', { mode: 'boolean' }).notNull().default(false),
  viewPlayers: integer('view_players', { mode: 'boolean' }).notNull().default(false),
  moderatePlayers: integer('moderate_players', { mode: 'boolean' }).notNull().default(false),
  viewMods: integer('view_mods', { mode: 'boolean' }).notNull().default(false),
  manageMods: integer('manage_mods', { mode: 'boolean' }).notNull().default(false),
  viewFiles: integer('view_files', { mode: 'boolean' }).notNull().default(false),
  manageFiles: integer('manage_files', { mode: 'boolean' }).notNull().default(false),
  viewSettings: integer('view_settings', { mode: 'boolean' }).notNull().default(false),
  manageSettings: integer('manage_settings', { mode: 'boolean' }).notNull().default(false),
  viewWorlds: integer('view_worlds', { mode: 'boolean' }).notNull().default(false),
  viewBackups: integer('view_backups', { mode: 'boolean' }).notNull().default(false),
  createBackups: integer('create_backups', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, (table) => [
  primaryKey({ columns: [table.serverId, table.userId], name: 'server_access_grants_pk' }),
  index('server_access_grants_user_idx').on(table.userId, table.viewServer, table.viewPlayers),
  check('server_access_grants_boolean_check', sql`${table.viewServer} IN (0, 1) AND ${table.viewLogs} IN (0, 1) AND ${table.sendConsoleCommands} IN (0, 1) AND ${table.controlLifecycle} IN (0, 1) AND ${table.startServer} IN (0, 1) AND ${table.stopServer} IN (0, 1) AND ${table.restartServer} IN (0, 1) AND ${table.viewPlayers} IN (0, 1) AND ${table.moderatePlayers} IN (0, 1) AND ${table.viewMods} IN (0, 1) AND ${table.manageMods} IN (0, 1) AND ${table.viewFiles} IN (0, 1) AND ${table.manageFiles} IN (0, 1) AND ${table.viewSettings} IN (0, 1) AND ${table.manageSettings} IN (0, 1) AND ${table.viewWorlds} IN (0, 1) AND ${table.viewBackups} IN (0, 1) AND ${table.createBackups} IN (0, 1)`),
  check('server_access_grants_dependencies_check', sql`(${table.sendConsoleCommands} = 0 AND ${table.controlLifecycle} = 0) AND (${table.viewServer} = 1 OR (${table.viewLogs} = 0 AND ${table.startServer} = 0 AND ${table.stopServer} = 0 AND ${table.restartServer} = 0 AND ${table.viewPlayers} = 0 AND ${table.moderatePlayers} = 0 AND ${table.viewMods} = 0 AND ${table.manageMods} = 0 AND ${table.viewFiles} = 0 AND ${table.manageFiles} = 0 AND ${table.viewSettings} = 0 AND ${table.manageSettings} = 0 AND ${table.viewWorlds} = 0 AND ${table.viewBackups} = 0 AND ${table.createBackups} = 0)) AND (${table.moderatePlayers} = 0 OR ${table.viewPlayers} = 1) AND (${table.manageMods} = 0 OR ${table.viewMods} = 1) AND (${table.manageFiles} = 0 OR ${table.viewFiles} = 1) AND (${table.manageSettings} = 0 OR ${table.viewSettings} = 1) AND (${table.createBackups} = 0 OR ${table.viewBackups} = 1)`),
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

export const localServerStructuredEvents = sqliteTable('local_server_structured_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  consoleEntryId: integer('console_entry_id'),
  occurredAt: text('occurred_at').notNull(),
  category: text('category', { enum: ['server', 'player', 'moderation'] }).notNull(),
  eventType: text('event_type').notNull(),
  description: text('description').notNull(),
  rawMessage: text('raw_message'),
  confidence: text('confidence', { enum: ['high', 'medium'] }).notNull(),
  source: text('source', { enum: ['owned-log', 'panel-process'] }).notNull(),
}, (table) => [
  index('local_server_structured_events_server_time_idx').on(table.serverId, table.occurredAt),
  index('local_server_structured_events_console_idx').on(table.consoleEntryId),
  check('local_server_structured_events_category_check', sql`${table.category} IN ('server', 'player', 'moderation')`),
  check('local_server_structured_events_confidence_check', sql`${table.confidence} IN ('high', 'medium')`),
  check('local_server_structured_events_source_check', sql`${table.source} IN ('owned-log', 'panel-process')`),
])

export const localServerResourceSamples = sqliteTable('local_server_resource_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  minuteStart: text('minute_start').notNull(),
  sampledAt: text('sampled_at').notNull(),
  cpuPercent: real('cpu_percent'),
  memoryRssBytes: integer('memory_rss_bytes'),
  playersOnline: integer('players_online'),
  playersMax: integer('players_max'),
  uptimeSeconds: integer('uptime_seconds'),
}, (table) => [
  uniqueIndex('local_server_resource_samples_server_minute_unique').on(table.serverId, table.minuteStart),
  index('local_server_resource_samples_minute_idx').on(table.minuteStart),
  check('local_server_resource_samples_cpu_check', sql`${table.cpuPercent} IS NULL OR (${table.cpuPercent} >= 0 AND ${table.cpuPercent} <= 100)`),
  check('local_server_resource_samples_rss_check', sql`${table.memoryRssBytes} IS NULL OR ${table.memoryRssBytes} >= 0`),
  check('local_server_resource_samples_players_check', sql`${table.playersOnline} IS NULL OR (${table.playersOnline} >= 0 AND (${table.playersMax} IS NULL OR ${table.playersMax} >= ${table.playersOnline}))`),
  check('local_server_resource_samples_uptime_check', sql`${table.uptimeSeconds} IS NULL OR ${table.uptimeSeconds} >= 0`),
])

export const localServerSessions = sqliteTable('local_server_sessions', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  outcome: text('outcome', { enum: ['running', 'stopped', 'crashed', 'interrupted'] }).notNull(),
  uptimeSeconds: integer('uptime_seconds'),
}, (table) => [
  index('local_server_sessions_server_start_idx').on(table.serverId, table.startedAt),
  index('local_server_sessions_end_idx').on(table.serverId, table.endedAt),
  uniqueIndex('local_server_sessions_active_unique').on(table.serverId).where(sql`${table.endedAt} IS NULL`),
  check('local_server_sessions_outcome_check', sql`${table.outcome} IN ('running', 'stopped', 'crashed', 'interrupted')`),
  check('local_server_sessions_uptime_check', sql`${table.uptimeSeconds} IS NULL OR ${table.uptimeSeconds} >= 0`),
])

export const serverInstallOperations = sqliteTable('server_install_operations', {
  id: text('id').primaryKey(),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  serverId: text('server_id').references(() => localServers.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  directoryName: text('directory_name').notNull(),
  software: text('software', { enum: ['vanilla', 'fabric', 'paper'] }).notNull(),
  loader: text('loader', { enum: ['forge', 'neoforge'] }),
  version: text('version').notNull(),
  requestJson: text('request_json').notNull(),
  status: text('status', { enum: ['pending', 'downloading', 'validating', 'completed', 'failed'] }).notNull(),
  progress: integer('progress').notNull(),
  phase: text('phase').notNull(),
  installerLog: text('installer_log').notNull().default(''),
  artifactUrl: text('artifact_url'),
  artifactSize: integer('artifact_size'),
  artifactSha1: text('artifact_sha1'),
  artifactSha256: text('artifact_sha256'),
  artifactChecksumType: text('artifact_checksum_type', { enum: ['sha1', 'sha256'] }),
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
  processPort: integer('process_port'),
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
  sessionId: text('session_id').references(() => localServerSessions.id, { onDelete: 'set null' }),
  occurredAt: text('occurred_at').notNull(),
  source: text('source', { enum: ['stdout', 'stderr', 'system', 'command'] }).notNull(),
  severity: text('severity', { enum: ['info', 'warn', 'error', 'debug'] }).notNull(),
  message: text('message').notNull(),
}, (table) => [
  index('local_server_console_entries_order_idx').on(table.serverId, table.id),
  index('local_server_console_entries_session_order_idx').on(table.sessionId, table.id),
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

export const localServerFileTrash = sqliteTable('local_server_file_trash', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  originalPath: text('original_path').notNull(),
  storedName: text('stored_name').notNull(),
  kind: text('kind', { enum: ['file', 'folder'] }).notNull(),
  sizeBytes: integer('size_bytes'),
  deletedAt: text('deleted_at').notNull(),
  restoredAt: text('restored_at'),
}, (table) => [
  index('local_server_file_trash_server_time_idx').on(table.serverId, table.deletedAt),
  check('local_server_file_trash_kind_check', sql`${table.kind} IN ('file', 'folder')`),
])

export const localServerFileRecoveries = sqliteTable('local_server_file_recoveries', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  originalPath: text('original_path').notNull(),
  fileName: text('file_name').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('local_server_file_recoveries_server_time_idx').on(table.serverId, table.createdAt),
])

export const localServerBackups = sqliteTable('local_server_backups', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  kind: text('kind', { enum: ['manual', 'pre-restore'] }).notNull(),
  origin: text('origin', { enum: ['manual', 'scheduled', 'system'] }).notNull().default('manual'),
  directoryName: text('directory_name').notNull(),
  createdAt: text('created_at').notNull(),
  archiveSizeBytes: integer('archive_size_bytes').notNull(),
  manifestSizeBytes: integer('manifest_size_bytes').notNull(),
  worldPathsJson: text('world_paths_json').notNull(),
  archiveSha256: text('archive_sha256').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  entryCount: integer('entry_count').notNull(),
  fileCount: integer('file_count').notNull(),
  totalFileBytes: integer('total_file_bytes').notNull(),
  excludedCount: integer('excluded_count').notNull(),
}, (table) => [
  uniqueIndex('local_server_backups_directory_unique').on(table.serverId, table.directoryName),
  index('local_server_backups_server_time_idx').on(table.serverId, table.createdAt),
  check('local_server_backups_kind_check', sql`${table.kind} IN ('manual', 'pre-restore')`),
  check('local_server_backups_origin_check', sql`${table.origin} IN ('manual', 'scheduled', 'system')`),
  check('local_server_backups_archive_size_check', sql`${table.archiveSizeBytes} >= 0`),
  check('local_server_backups_manifest_size_check', sql`${table.manifestSizeBytes} >= 0`),
  check('local_server_backups_entry_count_check', sql`${table.entryCount} >= 0 AND ${table.fileCount} >= 0 AND ${table.excludedCount} >= 0`),
  check('local_server_backups_total_bytes_check', sql`${table.totalFileBytes} >= 0`),
])

export const backupSettings = sqliteTable('backup_settings', {
  id: integer('id').primaryKey(),
  maxArchiveBytes: integer('max_archive_bytes').notNull(),
  storageQuotaBytes: integer('storage_quota_bytes'),
  maxEntries: integer('max_entries').notNull(),
  maxDurationMinutes: integer('max_duration_minutes').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('backup_settings_singleton_check', sql`${table.id} = 1`),
  check('backup_settings_archive_check', sql`${table.maxArchiveBytes} BETWEEN 1048576 AND 274877906944`),
  check('backup_settings_quota_check', sql`${table.storageQuotaBytes} IS NULL OR ${table.storageQuotaBytes} BETWEEN 1048576 AND 1099511627776`),
  check('backup_settings_entries_check', sql`${table.maxEntries} BETWEEN 1 AND 250000`),
  check('backup_settings_duration_check', sql`${table.maxDurationMinutes} BETWEEN 1 AND 360`),
])

export const localServerBackupRestores = sqliteTable('local_server_backup_restores', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  backupId: text('backup_id').notNull().references(() => localServerBackups.id),
  safetyBackupId: text('safety_backup_id').notNull().references(() => localServerBackups.id),
  actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  status: text('status', { enum: ['prepared', 'completed', 'rolled-back', 'recovery-required'] }).notNull(),
  stagingName: text('staging_name').notNull(),
  rollbackName: text('rollback_name').notNull(),
  errorCode: text('error_code'),
}, (table) => [
  index('local_server_backup_restores_server_time_idx').on(table.serverId, table.startedAt),
  index('local_server_backup_restores_status_idx').on(table.status, table.startedAt),
  check('local_server_backup_restores_status_check', sql`${table.status} IN ('prepared', 'completed', 'rolled-back', 'recovery-required')`),
])

export const localServerAutomation = sqliteTable('local_server_automation', {
  serverId: text('server_id').primaryKey().references(() => localServers.id, { onDelete: 'cascade' }),
  backupEnabled: integer('backup_enabled', { mode: 'boolean' }).notNull().default(false),
  frequency: text('frequency', { enum: ['daily', 'weekly'] }).notNull().default('daily'),
  localTime: text('local_time').notNull().default('03:00'),
  weekday: integer('weekday'),
  timeZone: text('time_zone').notNull(),
  nextRunAt: text('next_run_at'),
  lastRunAt: text('last_run_at'),
  lastStatus: text('last_status', { enum: ['completed', 'failed', 'missed'] }),
  lastError: text('last_error'),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('local_server_automation_enabled_check', sql`${table.backupEnabled} IN (0, 1)`),
  check('local_server_automation_frequency_check', sql`${table.frequency} IN ('daily', 'weekly')`),
  check('local_server_automation_time_check', sql`${table.localTime} GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(${table.localTime}, 1, 2) BETWEEN '00' AND '23'`),
  check('local_server_automation_weekday_check', sql`${table.weekday} IS NULL OR (${table.weekday} >= 0 AND ${table.weekday} <= 6)`),
  check('local_server_automation_frequency_weekday_check', sql`(${table.frequency} = 'daily' AND ${table.weekday} IS NULL) OR (${table.frequency} = 'weekly' AND ${table.weekday} IS NOT NULL)`),
  check('local_server_automation_status_check', sql`${table.lastStatus} IS NULL OR ${table.lastStatus} IN ('completed', 'failed', 'missed')`),
])

export const localServerAutomationJobs = sqliteTable('local_server_automation_jobs', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['backup'] }).notNull(),
  scheduledFor: text('scheduled_for').notNull(),
  status: text('status', { enum: ['running', 'completed', 'failed', 'missed'] }).notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  backupId: text('backup_id').references(() => localServerBackups.id, { onDelete: 'set null' }),
  errorMessage: text('error_message'),
  acknowledgedAt: text('acknowledged_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('local_server_automation_jobs_schedule_unique').on(table.serverId, table.kind, table.scheduledFor),
  index('local_server_automation_jobs_time_idx').on(table.serverId, table.createdAt),
  index('local_server_automation_jobs_status_idx').on(table.status, table.createdAt),
  check('local_server_automation_jobs_kind_check', sql`${table.kind} = 'backup'`),
  check('local_server_automation_jobs_status_check', sql`${table.status} IN ('running', 'completed', 'failed', 'missed')`),
])

export const localServerRestartSchedules = sqliteTable('local_server_restart_schedules', {
  serverId: text('server_id').primaryKey().references(() => localServers.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  frequency: text('frequency', { enum: ['daily', 'weekly'] }).notNull().default('daily'),
  localTime: text('local_time').notNull().default('03:00'),
  weekday: integer('weekday'),
  timeZone: text('time_zone').notNull(),
  onlyWhenEmpty: integer('only_when_empty', { mode: 'boolean' }).notNull().default(true),
  waitPolicy: text('wait_policy', { enum: ['skip', 'retry'] }).notNull().default('skip'),
  retryIntervalMinutes: integer('retry_interval_minutes').notNull().default(5),
  waitDeadlineMinutes: integer('wait_deadline_minutes').notNull().default(30),
  nextRunAt: text('next_run_at'),
  lastRunAt: text('last_run_at'),
  lastStatus: text('last_status', { enum: ['executed', 'skipped', 'deferred', 'failed', 'interrupted', 'missed'] }),
  lastOutcome: text('last_outcome'),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  check('local_server_restart_schedule_enabled_check', sql`${table.enabled} IN (0, 1)`),
  check('local_server_restart_schedule_frequency_check', sql`${table.frequency} IN ('daily', 'weekly')`),
  check('local_server_restart_schedule_time_check', sql`${table.localTime} GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(${table.localTime}, 1, 2) BETWEEN '00' AND '23'`),
  check('local_server_restart_schedule_weekday_check', sql`${table.weekday} IS NULL OR (${table.weekday} >= 0 AND ${table.weekday} <= 6)`),
  check('local_server_restart_schedule_weekday_required_check', sql`(${table.frequency} = 'daily' AND ${table.weekday} IS NULL) OR (${table.frequency} = 'weekly' AND ${table.weekday} IS NOT NULL)`),
  check('local_server_restart_schedule_empty_check', sql`${table.onlyWhenEmpty} IN (0, 1)`),
  check('local_server_restart_schedule_wait_check', sql`${table.waitPolicy} IN ('skip', 'retry')`),
  check('local_server_restart_schedule_retry_bounds_check', sql`${table.retryIntervalMinutes} BETWEEN 1 AND 30 AND ${table.waitDeadlineMinutes} BETWEEN 1 AND 180 AND ${table.retryIntervalMinutes} <= ${table.waitDeadlineMinutes}`),
  check('local_server_restart_schedule_status_check', sql`${table.lastStatus} IS NULL OR ${table.lastStatus} IN ('executed', 'skipped', 'deferred', 'failed', 'interrupted', 'missed')`),
])

export const localServerRestartJobs = sqliteTable('local_server_restart_jobs', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => localServers.id, { onDelete: 'cascade' }),
  scheduledFor: text('scheduled_for').notNull(),
  status: text('status', { enum: ['running', 'executed', 'skipped', 'deferred', 'failed', 'interrupted', 'missed'] }).notNull(),
  outcome: text('outcome').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  nextAttemptAt: text('next_attempt_at'),
  deadlineAt: text('deadline_at').notNull(),
  errorMessage: text('error_message'),
  acknowledgedAt: text('acknowledged_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('local_server_restart_jobs_slot_unique').on(table.serverId, table.scheduledFor),
  index('local_server_restart_jobs_server_time_idx').on(table.serverId, table.createdAt),
  index('local_server_restart_jobs_due_idx').on(table.status, table.nextAttemptAt),
  check('local_server_restart_jobs_status_check', sql`${table.status} IN ('running', 'executed', 'skipped', 'deferred', 'failed', 'interrupted', 'missed')`),
  check('local_server_restart_jobs_outcome_check', sql`${table.outcome} IN ('pending', 'completed', 'players-online', 'player-count-unknown', 'server-offline', 'unmanaged', 'conflict', 'pending-restore', 'pending-removal', 'deadline-reached', 'missed', 'interrupted', 'restart-failed', 'schedule-changed')`),
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
