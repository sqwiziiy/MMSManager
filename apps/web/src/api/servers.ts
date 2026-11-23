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
} from '@mmsmanager/shared'
import type { JavaRuntime, LocalServerSummary, ServerImportPreview, ServerInventory, ServerConsoleEntry, ServerRuntime, ServerStatus, ServerPlayerList, ServerPlayerAction, ServerPlayerActionResult, ServerPropertiesResponse, ServerPropertiesUpdate } from '@mmsmanager/shared'
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

export async function getServerMods(serverId: string, signal?: AbortSignal): Promise<ServerModsInventory> {
  const response = await request(`/api/v1/servers/${encodeURIComponent(serverId)}/mods`, serverModsInventoryResultSchema, { signal })
  return response.mods
}

function csrfToken(): string | null {
  const item = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('mmsmanager_csrf='))
  if (!item) return null
  try { return decodeURIComponent(item.slice('mmsmanager_csrf='.length)) } catch { return null }
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
