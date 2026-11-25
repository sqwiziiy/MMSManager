import {
  javaRuntimeListSchema,
  javaRuntimeSchema,
  installCatalogSchema,
  installOperationListSchema,
  installOperationResultSchema,
  localServerListSchema,
  serverAccessAdminResultSchema,
  serverAccessSelfResultSchema,
  serverAccessUpdateSchema,
  serverImportPreviewSchema,
  serverImportResultSchema,
  serverMetadataUpdateSchema,
  serverInventorySchema,
  serverConsoleResponseSchema,
  serverConsoleSessionsResponseSchema,
  serverRuntimeResultSchema,
  serverRuntimeSettingsResultSchema,
  serverAutomationResultSchema,
  serverStatusResultSchema,
  dashboardPlayerSummaryResultSchema,
  serverPlayerListResultSchema,
  serverPlayerActionResultSchema,
  serverPropertiesResultSchema,
  serverModsInventoryResultSchema,
  serverFileListSchema,
  serverFileReadSchema,
  serverFileTrashListSchema,
  serverFileTrashResultSchema,
  serverFileRecoveryListSchema,
  serverPropertiesRestorePreviewResultSchema,
  serverPropertiesRestoreResultSchema,
  serverWorldsResultSchema,
  serverBackupsResultSchema,
  serverBackupCreateResultSchema,
  serverBackupPreviewResultSchema,
  serverBackupRestoreResultSchema,
  serverHistoryCalendarResultSchema,
  serverHistoryDayResultSchema,
  serverZipImportUploadResultSchema,
  serverZipImportPublishSchema,
  serverZipImportPublishResultSchema,
  serverRemovalRequestSchema,
  serverRemovalRetrySchema,
  serverRemovalOperationListSchema,
  serverRemovalResultSchema,
} from '@mmsmanager/shared'
import type { JavaRuntime, LocalServerSummary, ServerImportPreview, ServerInventory, ServerConsoleResponse, ServerConsoleSession, ServerRuntime, ServerRuntimeSettings, ServerRuntimeSettingsUpdate, ServerAutomation, ServerAutomationUpdate, ServerStatus, ServerPlayerList, ServerPlayerAction, ServerPlayerActionResult, ServerPropertiesResponse, ServerPropertiesRestorePreview, ServerPropertiesUpdate, ServerFileList, ServerFileRead, ServerFileRecovery, ServerFileTrash, ServerWorlds, ServerHistoryCalendar, ServerHistoryDay, ServerHistoryScope, ServerBackupsInventory, ServerBackup, ServerBackupPreview, ServerBackupRestoreResult, ServerMetadataUpdate, ServerAccessPermissions, ServerAccessGrantUser, ServerZipImportPreview, ServerRemovalOperation } from '@mmsmanager/shared'
import type { DashboardPlayerSummary, InstallCatalog, InstallOperation, InstallSoftware, ServerInstallRequest } from '@mmsmanager/shared'
import type { ServerModsInventory } from '@mmsmanager/shared'
import { apiCsrfToken, apiErrorFromPayload, apiInvalidResponseError, apiNetworkError, apiRequest, apiRequestHeaders, apiRequestResponse, reportSessionExpiry } from './client'

function request<T>(url: string, schema: { parse: (value: unknown) => T }, init: RequestInit = {}): Promise<T> {
  return apiRequest(url, schema, init)
}

export async function getLocalServers(signal?: AbortSignal): Promise<LocalServerSummary[]> {
  const response = await request('/api/v1/servers', localServerListSchema, { signal })
  return response.servers
}

export async function uploadServerZip(file: File, onProgress: (loaded: number, total: number | null) => void, signal?: AbortSignal): Promise<ServerZipImportPreview> {
  const path = '/api/v1/admin/server-imports/zip'
  const form = new FormData()
  form.append('archive', file, file.name)
  const headers = apiRequestHeaders(path, { method: 'POST', body: form })
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    xhr.open('POST', path)
    xhr.withCredentials = true
    headers.forEach((value, key) => xhr.setRequestHeader(key, value))
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : null)
    xhr.onerror = () => { cleanup(); reject(apiNetworkError('The ZIP upload could not reach the local API.')) }
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled.', 'AbortError')) }
    xhr.onload = () => {
      cleanup()
      reportSessionExpiry(xhr.status, path)
      let payload: unknown
      try { payload = JSON.parse(xhr.responseText) } catch { payload = null }
      if (xhr.status < 200 || xhr.status >= 300) { reject(apiErrorFromPayload(xhr.status, payload, undefined, xhr.getResponseHeader('x-mms-request-id'))); return }
      try { resolve(serverZipImportUploadResultSchema.parse(payload).preview) }
      catch { reject(apiInvalidResponseError()) }
    }
    if (signal?.aborted) { xhr.abort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    xhr.send(form)
  })
}

export async function publishServerZip(input: {
  token: string; name: string; javaPath: string; minMemoryMb: number; maxMemoryMb: number;
  acceptEula: boolean; trustExecutable: true; startAfterImport: boolean
}): Promise<{ server: LocalServerSummary; started: boolean; startError: string | null }> {
  const parsed = serverZipImportPublishSchema.parse(input)
  return request('/api/v1/admin/server-imports/' + encodeURIComponent(parsed.token) + '/publish', serverZipImportPublishResultSchema, {
    method: 'POST', body: JSON.stringify(parsed),
  })
}

export async function removeLocalServer(serverId: string, input: { mode: 'unregister' | 'permanent'; confirmation: string }): Promise<ServerRemovalOperation> {
  const parsed = serverRemovalRequestSchema.parse(input)
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/remove`, serverRemovalResultSchema, { method: 'POST', body: JSON.stringify(parsed) })
  return response.operation
}

export async function getServerRemovalHistory(signal?: AbortSignal): Promise<ServerRemovalOperation[]> {
  const response = await request('/api/v1/admin/server-removals', serverRemovalOperationListSchema, { signal })
  return response.operations
}

export async function retryServerRemoval(id: string, confirmation: string): Promise<ServerRemovalOperation> {
  const body = serverRemovalRetrySchema.parse({ confirmation })
  const response = await request(`/api/v1/admin/server-removals/${encodeURIComponent(id)}/retry`, serverRemovalResultSchema, { method: 'POST', body: JSON.stringify(body) })
  return response.operation
}

export async function getMyServerAccess(serverId: string, signal?: AbortSignal): Promise<{ administrator: boolean; permissions: ServerAccessPermissions }> {
  return request(`/api/v1/servers/${encodeURIComponent(serverId)}/access`, serverAccessSelfResultSchema, { signal })
}

export async function getServerAccessUsers(serverId: string, signal?: AbortSignal): Promise<ServerAccessGrantUser[]> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/access`, serverAccessAdminResultSchema, { signal })
  return response.users
}

export async function updateServerAccess(serverId: string, userId: string, permissions: ServerAccessPermissions): Promise<ServerAccessGrantUser[]> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/access`, serverAccessAdminResultSchema, {
    method: 'PUT', body: JSON.stringify(serverAccessUpdateSchema.parse({ userId, permissions })),
  })
  return response.users
}

export async function getServerStatus(serverId: string, signal?: AbortSignal): Promise<ServerStatus> {
  const response = await request('/api/v1/servers/' + encodeURIComponent(serverId) + '/status', serverStatusResultSchema, { signal })
  return response.status
}

export async function getDashboardPlayerSummary(signal?: AbortSignal): Promise<DashboardPlayerSummary> {
  const response = await request('/api/v1/dashboard/players', dashboardPlayerSummaryResultSchema, { signal })
  return response.summary
}

export async function getAuthoritativePlayers(serverId: string, signal?: AbortSignal): Promise<ServerPlayerList> {
  const response = await request('/api/v1/admin/servers/' + encodeURIComponent(serverId) + '/players', serverPlayerListResultSchema, { signal })
  return response.players
}

export async function sendPlayerAction(serverId: string, action: ServerPlayerAction, username: string | null): Promise<ServerPlayerActionResult> {
  return request('/api/v1/admin/servers/' + encodeURIComponent(serverId) + '/player-actions', serverPlayerActionResultSchema, { method: 'POST', body: JSON.stringify(username === null ? { action } : { action, username }) })
}

export function getServerInventory(signal?: AbortSignal): Promise<ServerInventory> {
  return request('/api/v1/admin/servers', serverInventorySchema, { signal })
}

export function inspectServerImport(path: string): Promise<ServerImportPreview> {
  return request('/api/v1/admin/servers/import/inspect', serverImportPreviewSchema, { method: 'POST', body: JSON.stringify({ path }) })
}

export function registerServerImport(input: { path: string; name: string; minMemoryMb: number; maxMemoryMb: number }): Promise<{ server: LocalServerSummary }> {
  return request('/api/v1/admin/servers/import', serverImportResultSchema, { method: 'POST', body: JSON.stringify(input) })
}

export async function updateServerMetadata(serverId: string, input: ServerMetadataUpdate): Promise<LocalServerSummary> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/metadata`, serverImportResultSchema, { method: 'PATCH', body: JSON.stringify(serverMetadataUpdateSchema.parse(input)) })
  return response.server
}

export async function getJavaRuntimes(signal?: AbortSignal): Promise<JavaRuntime[]> {
  const response = await request('/api/v1/admin/java', javaRuntimeListSchema, { signal })
  return response.runtimes
}

export async function scanJavaRuntimes(): Promise<JavaRuntime[]> {
  const response = await request('/api/v1/admin/java/scan', javaRuntimeListSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.runtimes
}

export function probeJavaRuntime(path: string): Promise<JavaRuntime> {
  return request('/api/v1/admin/java/probe', javaRuntimeSchema, { method: 'POST', body: JSON.stringify({ path }) })
}

export function getInstallCatalog(software: InstallSoftware, version?: string, signal?: AbortSignal): Promise<InstallCatalog> {
  const query = new URLSearchParams({ software })
  if (version) query.set('version', version)
  return request(`/api/v1/admin/server-installs/catalog?${query}`, installCatalogSchema, { signal })
}

export async function listInstallOperations(signal?: AbortSignal): Promise<InstallOperation[]> {
  const response = await request('/api/v1/admin/server-installs', installOperationListSchema, { signal })
  return response.operations
}

export async function createServerInstall(input: ServerInstallRequest): Promise<InstallOperation> {
  const response = await request('/api/v1/admin/server-installs', installOperationResultSchema, { method: 'POST', body: JSON.stringify(input) })
  return response.operation
}

export async function getServerInstall(operationId: string, signal?: AbortSignal): Promise<InstallOperation> {
  const response = await request(`/api/v1/admin/server-installs/${encodeURIComponent(operationId)}`, installOperationResultSchema, { signal })
  return response.operation
}

export async function cancelServerInstall(operationId: string): Promise<InstallOperation> {
  const response = await request(`/api/v1/admin/server-installs/${encodeURIComponent(operationId)}/cancel`, installOperationResultSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.operation
}

export async function getServerRuntime(serverId: string, signal?: AbortSignal): Promise<ServerRuntime> {
  const response = await request(`/api/v1/servers/${encodeURIComponent(serverId)}/runtime`, serverRuntimeResultSchema, { signal })
  return response.runtime
}

export async function getServerRuntimeSettings(serverId: string, signal?: AbortSignal): Promise<ServerRuntimeSettings> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/runtime-settings`, serverRuntimeSettingsResultSchema, { signal })
  return response.settings
}

export async function updateServerRuntimeSettings(serverId: string, input: ServerRuntimeSettingsUpdate): Promise<ServerRuntimeSettings> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/runtime-settings`, serverRuntimeSettingsResultSchema, { method: 'PUT', body: JSON.stringify(input) })
  return response.settings
}

export async function getServerAutomation(serverId: string, signal?: AbortSignal): Promise<ServerAutomation> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/automation`, serverAutomationResultSchema, { signal })
  return response.automation
}

export async function updateServerAutomation(serverId: string, input: ServerAutomationUpdate): Promise<ServerAutomation> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/automation`, serverAutomationResultSchema, { method: 'PUT', body: JSON.stringify(input) })
  return response.automation
}

export async function acknowledgeServerAutomationJob(serverId: string, jobId: string): Promise<ServerAutomation> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/automation/jobs/${encodeURIComponent(jobId)}/acknowledge`, serverAutomationResultSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.automation
}

export async function getServerBackups(serverId: string, signal?: AbortSignal): Promise<ServerBackupsInventory> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/backups`, serverBackupsResultSchema, { signal })
}

export async function createServerBackup(serverId: string): Promise<ServerBackup> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/backups`, serverBackupCreateResultSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.backup
}

export async function previewServerBackup(serverId: string, backupId: string): Promise<ServerBackupPreview> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupId)}/preview`, serverBackupPreviewResultSchema)
  return response.preview
}

export async function restoreServerBackup(serverId: string, backupId: string, confirmation: string): Promise<ServerBackupRestoreResult> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupId)}/restore`, serverBackupRestoreResultSchema, { method: 'POST', body: JSON.stringify({ confirmation }) })
}

export async function downloadServerBackup(serverId: string, backupId: string): Promise<Blob> {
  const response = await apiRequestResponse(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupId)}/download`, {
    method: 'GET', headers: { accept: 'application/octet-stream' },
  })
  return response.blob()
}

export async function getServerConsoleSessions(serverId: string, signal?: AbortSignal): Promise<ServerConsoleSession[]> {
  const response = await request(`/api/v1/servers/${encodeURIComponent(serverId)}/console/sessions`, serverConsoleSessionsResponseSchema, { signal })
  return response.sessions
}

export async function getServerConsole(serverId: string, options: { after?: number; before?: number; sessionId?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ServerConsoleResponse> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 200) })
  if (options.after !== undefined) query.set('after', String(options.after))
  if (options.before !== undefined) query.set('before', String(options.before))
  if (options.sessionId) query.set('sessionId', options.sessionId)
  return request(`/api/v1/servers/${encodeURIComponent(serverId)}/console?${query}`, serverConsoleResponseSchema, { signal: options.signal })
}

export async function startLocalServer(serverId: string): Promise<ServerRuntime> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/start`, serverRuntimeResultSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.runtime
}

export async function stopLocalServer(serverId: string): Promise<ServerRuntime> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/stop`, serverRuntimeResultSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.runtime
}

export async function restartLocalServer(serverId: string): Promise<ServerRuntime> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/restart`, serverRuntimeResultSchema, {
    method: 'POST', body: JSON.stringify({}), signal: AbortSignal.timeout(125_000),
  })
  return response.runtime
}

export async function confirmLocalServerStopped(serverId: string): Promise<ServerRuntime> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/confirm-stopped`, serverRuntimeResultSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.runtime
}

export async function sendLocalServerCommand(serverId: string, command: string): Promise<void> {
  await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/console`, { parse: () => undefined }, { method: 'POST', body: JSON.stringify({ command }) })
}

export async function getServerProperties(serverId: string, signal?: AbortSignal): Promise<ServerPropertiesResponse> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/properties`, serverPropertiesResultSchema, { signal })
  return response.properties
}

export type ServerPropertiesConfirmations = {
  confirmOnlineModeChange?: boolean
  confirmLevelNameChange?: boolean
  confirmWorldGenerationChange?: boolean
  confirmResourcePackChange?: boolean
  confirmGamePortChange?: boolean
}

export async function updateServerProperties(
  serverId: string,
  update: ServerPropertiesUpdate,
  expectedSha256: string,
  advancedProperties: Record<string, string> = {},
  confirmations: ServerPropertiesConfirmations = {},
): Promise<ServerPropertiesResponse> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/properties`, serverPropertiesResultSchema, {
    method: 'PATCH', body: JSON.stringify({ ...update, advancedProperties, expectedSha256, ...confirmations }),
  })
  return response.properties
}

export async function previewServerPropertiesRestore(serverId: string, backupId: string): Promise<ServerPropertiesRestorePreview> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/properties/backups/${encodeURIComponent(backupId)}/preview`, serverPropertiesRestorePreviewResultSchema)
  return response.preview
}

export async function restoreServerProperties(serverId: string, backupId: string, expectedCurrentSha256: string): Promise<{ properties: ServerPropertiesResponse; recoveryBackupId: string | null }> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/properties/backups/${encodeURIComponent(backupId)}/restore`, serverPropertiesRestoreResultSchema, { method: 'POST', body: JSON.stringify({ expectedCurrentSha256 }) })
}

export async function getServerWorlds(serverId: string, signal?: AbortSignal): Promise<ServerWorlds> {
  return (await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/worlds`, serverWorldsResultSchema, { signal })).worlds
}

export async function getServerHistoryCalendar(scope: ServerHistoryScope, year: number, month: number, signal?: AbortSignal): Promise<ServerHistoryCalendar> {
  const query = new URLSearchParams({ scope, year: String(year), month: String(month) })
  return (await request('/api/v1/admin/server-history/calendar?' + query, serverHistoryCalendarResultSchema, { signal })).calendar
}

export async function getServerHistoryDay(scope: ServerHistoryScope, date: string, signal?: AbortSignal): Promise<ServerHistoryDay> {
  const query = new URLSearchParams({ scope, date })
  return (await request('/api/v1/admin/server-history/day?' + query, serverHistoryDayResultSchema, { signal })).day
}

export async function getServerFiles(serverId: string, path = '', signal?: AbortSignal): Promise<ServerFileList> {
  const query = new URLSearchParams({ path })
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files?${query}`, serverFileListSchema, { signal })
}

export async function readServerFile(serverId: string, path: string): Promise<ServerFileRead> {
  const query = new URLSearchParams({ path })
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/read?${query}`, serverFileReadSchema)
}

export async function createServerFile(serverId: string, path: string, kind: 'file' | 'folder', text?: string): Promise<ServerFileList> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/create`, serverFileListSchema, { method: 'POST', body: JSON.stringify(text === undefined ? { path, kind } : { path, kind, text }) })
}

export async function renameServerFile(serverId: string, path: string, newName: string): Promise<ServerFileList> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/rename`, serverFileListSchema, { method: 'POST', body: JSON.stringify({ path, newName }) })
}

export async function moveServerFile(serverId: string, sourcePath: string, destinationDirectory: string): Promise<ServerFileList> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/move`, serverFileListSchema, { method: 'POST', body: JSON.stringify({ sourcePath, destinationDirectory }) })
}

export async function trashServerFile(serverId: string, path: string): Promise<{ item: ServerFileTrash; inventory: ServerFileList }> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files`, serverFileTrashResultSchema, { method: 'DELETE', body: JSON.stringify({ path }) })
}

export async function getServerFileTrash(serverId: string): Promise<ServerFileTrash[]> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/trash`, serverFileTrashListSchema)
  return response.items
}

export async function restoreTrashedServerFile(serverId: string, id: string): Promise<ServerFileList> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/trash/${encodeURIComponent(id)}/restore`, serverFileListSchema, { method: 'POST', body: JSON.stringify({ id }) })
}

export async function saveServerFileText(serverId: string, path: string, text: string, expectedSha256: string): Promise<ServerFileRead> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files`, serverFileReadSchema, { method: 'PUT', body: JSON.stringify({ path, text, expectedSha256 }) })
}

export async function getServerFileRecoveries(serverId: string, path: string): Promise<ServerFileRecovery[]> {
  const query = new URLSearchParams({ path })
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/recoveries?${query}`, serverFileRecoveryListSchema)
  return response.items
}

export async function restoreServerFileRecovery(serverId: string, id: string, expectedCurrentSha256: string): Promise<ServerFileRead> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/recoveries/${encodeURIComponent(id)}/restore`, serverFileReadSchema, { method: 'POST', body: JSON.stringify({ expectedCurrentSha256 }) })
}

export async function getServerMods(serverId: string, signal?: AbortSignal): Promise<ServerModsInventory> {
  const response = await request(`/api/v1/servers/${encodeURIComponent(serverId)}/mods`, serverModsInventoryResultSchema, { signal })
  return response.mods
}

export type ServerFileUploadItem = { file: File; relativePath: string }
export type ServerFileUploadRequest = { promise: Promise<ServerFileList>; cancel: () => void }

export function uploadServerFiles(
  serverId: string,
  directory: string,
  files: ServerFileUploadItem[],
  directories: string[],
  onProgress: (percent: number) => void,
): ServerFileUploadRequest {
  const xhr = new XMLHttpRequest()
  const query = new URLSearchParams({ path: directory })
  const url = `/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/upload-batch?${query}`
  xhr.open('POST', url)
  xhr.withCredentials = true
  xhr.timeout = 15 * 60 * 1000
  xhr.setRequestHeader('accept', 'application/json')
  const csrf = apiCsrfToken()
  if (csrf) xhr.setRequestHeader('x-mms-csrf', csrf)
  xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))) }
  const promise = new Promise<ServerFileList>((resolve, reject) => {
    xhr.onerror = () => reject(apiNetworkError('The file upload could not reach the local API.'))
    xhr.ontimeout = () => reject(new Error('The upload took too long. Refresh the folder to check whether the complete batch was saved.'))
    xhr.onabort = () => reject(new Error('Upload cancelled. Refresh the folder to check whether the complete batch was saved.'))
    xhr.onload = () => {
      reportSessionExpiry(xhr.status, url)
      let raw: unknown = null
      try { raw = JSON.parse(xhr.responseText) as unknown } catch { /* handled as a local API error */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(apiErrorFromPayload(xhr.status, raw, 'The file upload could not be completed.'))
        return
      }
      try { onProgress(100); resolve(serverFileListSchema.parse(raw)) }
      catch { reject(apiInvalidResponseError()) }
    }
    const body = new FormData()
    body.append('manifest', JSON.stringify({ files: files.map((item) => item.relativePath), directories }))
    for (const item of files) body.append('file', item.file, item.relativePath)
    xhr.send(body)
  })
  return { promise, cancel: () => xhr.abort() }
}

export async function downloadServerFile(serverId: string, path: string): Promise<void> {
  const query = new URLSearchParams({ path })
  const response = await apiRequestResponse(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/download?${query}`, { headers: { accept: 'application/octet-stream' } })
  let fileName = 'server-file'
  const encodedName = response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encodedName) { try { fileName = decodeURIComponent(encodedName) } catch { /* keep the safe fallback name */ } }
  const objectUrl = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

export function uploadServerMod(serverId: string, file: File, onProgress: (percent: number) => void): Promise<ServerModsInventory> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    const url = `/api/v1/admin/servers/${encodeURIComponent(serverId)}/mods`
    request.open('POST', url)
    request.withCredentials = true
    request.setRequestHeader('accept', 'application/json')
    const csrf = apiCsrfToken()
    if (csrf) request.setRequestHeader('x-mms-csrf', csrf)
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))) }
    request.onerror = () => reject(apiNetworkError('The mod upload could not reach the local API.'))
    request.onabort = () => reject(new Error('The mod upload was cancelled.'))
    request.onload = () => {
      reportSessionExpiry(request.status, url)
      let raw: unknown = null
      try { raw = JSON.parse(request.responseText) as unknown } catch { /* handled as a local API error */ }
      if (request.status < 200 || request.status >= 300) {
        reject(apiErrorFromPayload(request.status, raw, 'The mod upload could not be completed.'))
        return
      }
      try {
        onProgress(100)
        resolve(serverModsInventoryResultSchema.parse(raw).mods)
      } catch { reject(apiInvalidResponseError()) }
    }
    const body = new FormData()
    body.append('file', file, file.name)
    request.send(body)
  })
}

async function modMutation(serverId: string, suffix: string): Promise<ServerModsInventory> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/mods/${suffix}`, serverModsInventoryResultSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.mods
}

export function setServerModEnabled(serverId: string, fileName: string, enabled: boolean): Promise<ServerModsInventory> {
  return modMutation(serverId, `${encodeURIComponent(fileName)}/${enabled ? 'enable' : 'disable'}`)
}
export function quarantineServerMod(serverId: string, fileName: string): Promise<ServerModsInventory> {
  return modMutation(serverId, `${encodeURIComponent(fileName)}/quarantine`)
}
export function restoreQuarantinedMod(serverId: string, id: string): Promise<ServerModsInventory> {
  return modMutation(serverId, `quarantine/${encodeURIComponent(id)}/restore`)
}
