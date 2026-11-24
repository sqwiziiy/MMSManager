import {
  javaRuntimeListSchema,
  javaRuntimeSchema,
  installCatalogSchema,
  installOperationListSchema,
  installOperationResultSchema,
  localServerListSchema,
  serverImportPreviewSchema,
  serverImportResultSchema,
  serverInventorySchema,
  serverConsoleResponseSchema,
  serverRuntimeResultSchema,
  serverStatusResultSchema,
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
} from '@mmsmanager/shared'
import type { JavaRuntime, LocalServerSummary, ServerImportPreview, ServerInventory, ServerConsoleEntry, ServerRuntime, ServerStatus, ServerPlayerList, ServerPlayerAction, ServerPlayerActionResult, ServerPropertiesResponse, ServerPropertiesRestorePreview, ServerPropertiesUpdate, ServerFileList, ServerFileRead, ServerFileRecovery, ServerFileTrash, ServerWorlds, ServerHistoryCalendar, ServerHistoryDay, ServerHistoryScope, ServerBackupsInventory, ServerBackup, ServerBackupPreview, ServerBackupRestoreResult } from '@mmsmanager/shared'
import type { InstallCatalog, InstallOperation, InstallSoftware, ServerInstallRequest } from '@mmsmanager/shared'
import type { ServerModsInventory } from '@mmsmanager/shared'

async function request<T>(url: string, schema: { parse: (value: unknown) => T }, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  const method = (init.method ?? 'GET').toUpperCase()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    headers.set('content-type', 'application/json')
    const csrf = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('mmsmanager_csrf='))?.slice('mmsmanager_csrf='.length)
    if (csrf) headers.set('x-mms-csrf', csrf)
  }
  const response = await fetch(url, { ...init, method, headers, credentials: 'same-origin' })
  if (response.status === 401) window.dispatchEvent(new Event('mmsmanager:session-expired'))
  const raw: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const body = raw as { error?: { message?: unknown } } | null
    throw new Error(typeof body?.error?.message === 'string' ? body.error.message : 'The local server request could not be completed.')
  }
  return schema.parse(raw)
}

export async function getLocalServers(signal?: AbortSignal): Promise<LocalServerSummary[]> {
  const response = await request('/api/v1/servers', localServerListSchema, { signal })
  return response.servers
}

export async function getServerStatus(serverId: string, signal?: AbortSignal): Promise<ServerStatus> {
  const response = await request('/api/v1/servers/' + encodeURIComponent(serverId) + '/status', serverStatusResultSchema, { signal })
  return response.status
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

export async function getServerRuntime(serverId: string, signal?: AbortSignal): Promise<ServerRuntime> {
  const response = await request(`/api/v1/servers/${encodeURIComponent(serverId)}/runtime`, serverRuntimeResultSchema, { signal })
  return response.runtime
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
  const response = await fetch(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/backups/${encodeURIComponent(backupId)}/download`, {
    method: 'GET', credentials: 'same-origin', headers: { accept: 'application/octet-stream' },
  })
  if (response.status === 401) window.dispatchEvent(new Event('mmsmanager:session-expired'))
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: unknown } } | null
    throw new Error(typeof body?.error?.message === 'string' ? body.error.message : 'The backup download could not be completed.')
  }
  return response.blob()
}

export async function getServerConsole(serverId: string, after = 0, signal?: AbortSignal): Promise<{ entries: ServerConsoleEntry[]; nextAfter: number | null }> {
  const query = new URLSearchParams({ after: String(after), limit: '200' })
  return request(`/api/v1/servers/${encodeURIComponent(serverId)}/console?${query}`, serverConsoleResponseSchema, { signal })
}

export async function startLocalServer(serverId: string): Promise<ServerRuntime> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/start`, serverRuntimeResultSchema, { method: 'POST', body: JSON.stringify({}) })
  return response.runtime
}

export async function stopLocalServer(serverId: string): Promise<ServerRuntime> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/stop`, serverRuntimeResultSchema, { method: 'POST', body: JSON.stringify({}) })
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

export async function updateServerProperties(serverId: string, update: ServerPropertiesUpdate): Promise<ServerPropertiesResponse> {
  const response = await request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/properties`, serverPropertiesResultSchema, { method: 'PATCH', body: JSON.stringify(update) })
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

export async function moveServerFile(serverId: string, sourcePath: string, destinationPath: string): Promise<ServerFileList> {
  return request(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/move`, serverFileListSchema, { method: 'POST', body: JSON.stringify({ sourcePath, destinationPath }) })
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

function csrfToken(): string | null {
  const item = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('mmsmanager_csrf='))
  if (!item) return null
  try { return decodeURIComponent(item.slice('mmsmanager_csrf='.length)) } catch { return null }
}

export function uploadServerFile(serverId: string, directory: string, file: File, onProgress: (percent: number) => void): Promise<ServerFileList> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = new URLSearchParams({ path: directory })
    xhr.open('POST', `/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/upload?${query}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('accept', 'application/json')
    const csrf = csrfToken()
    if (csrf) xhr.setRequestHeader('x-mms-csrf', csrf)
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))) }
    xhr.onerror = () => reject(new Error('The file upload could not reach the local API.'))
    xhr.onabort = () => reject(new Error('The file upload was cancelled.'))
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event('mmsmanager:session-expired'))
      let raw: unknown = null
      try { raw = JSON.parse(xhr.responseText) as unknown } catch { /* handled as a local API error */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        const body = raw as { error?: { message?: unknown } } | null
        reject(new Error(typeof body?.error?.message === 'string' ? body.error.message : 'The file upload could not be completed.'))
        return
      }
      try { onProgress(100); resolve(serverFileListSchema.parse(raw)) }
      catch { reject(new Error('The local API returned an invalid server file inventory.')) }
    }
    const body = new FormData()
    body.append('file', file, file.name)
    xhr.send(body)
  })
}

export async function downloadServerFile(serverId: string, path: string): Promise<void> {
  const query = new URLSearchParams({ path })
  const response = await fetch(`/api/v1/admin/servers/${encodeURIComponent(serverId)}/files/download?${query}`, { credentials: 'same-origin', headers: { accept: 'application/octet-stream' } })
  if (response.status === 401) window.dispatchEvent(new Event('mmsmanager:session-expired'))
  if (!response.ok) {
    const raw = await response.json().catch(() => null) as { error?: { message?: unknown } } | null
    throw new Error(typeof raw?.error?.message === 'string' ? raw.error.message : 'The file download could not be completed.')
  }
  const fileName = decodeURIComponent(response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? 'server-file')
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
    request.open('POST', `/api/v1/admin/servers/${encodeURIComponent(serverId)}/mods`)
    request.withCredentials = true
    request.setRequestHeader('accept', 'application/json')
    const csrf = csrfToken()
    if (csrf) request.setRequestHeader('x-mms-csrf', csrf)
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))) }
    request.onerror = () => reject(new Error('The mod upload could not reach the local API.'))
    request.onabort = () => reject(new Error('The mod upload was cancelled.'))
    request.onload = () => {
      if (request.status === 401) window.dispatchEvent(new Event('mmsmanager:session-expired'))
      let raw: unknown = null
      try { raw = JSON.parse(request.responseText) as unknown } catch { /* handled as a local API error */ }
      if (request.status < 200 || request.status >= 300) {
        const error = raw as { error?: { message?: unknown } } | null
        reject(new Error(typeof error?.error?.message === 'string' ? error.error.message : 'The mod upload could not be completed.'))
        return
      }
      try {
        onProgress(100)
        resolve(serverModsInventoryResultSchema.parse(raw).mods)
      } catch { reject(new Error('The local API returned an invalid mod inventory.')) }
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
