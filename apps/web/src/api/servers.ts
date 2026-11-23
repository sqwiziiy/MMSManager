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
} from '@mmsmanager/shared'
import type { JavaRuntime, LocalServerSummary, ServerImportPreview, ServerInventory } from '@mmsmanager/shared'
import type { InstallCatalog, InstallOperation, InstallSoftware, ServerInstallRequest } from '@mmsmanager/shared'

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
