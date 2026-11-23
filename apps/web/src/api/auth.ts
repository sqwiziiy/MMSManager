import {
  adminUsersSchema,
  adminUserResultSchema,
  apiAckSchema,
  auditRecordsSchema,
  authMeSchema,
  publicHealthSchema,
  workspacePreferencesSchema,
} from '@mmsmanager/shared'
import type { AuthMe, LandingPage, UserRole } from '@mmsmanager/shared'

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) {
    super(message)
  }
}

function csrfCookie(): string | null {
  if (typeof document === 'undefined') return null
  const value = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('mmsmanager_csrf='))
  return value?.slice('mmsmanager_csrf='.length) ?? null
}

async function readResponse<T>(path: string, schema: { parse: (input: unknown) => T }, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  const method = (init.method ?? 'GET').toUpperCase()
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const formData = typeof FormData !== 'undefined' && init.body instanceof FormData
  if (init.body && !formData && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (unsafe && !path.endsWith('/auth/setup') && !path.endsWith('/auth/login')) {
    const csrf = csrfCookie()
    if (csrf) headers.set('x-mms-csrf', csrf)
  }

  const response = await fetch(path, { ...init, method, headers, credentials: 'same-origin' })
  if (response.status === 401 && !path.endsWith('/auth/me') && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('mmsmanager:session-expired'))
  }
  const raw: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const body = raw as { error?: { message?: unknown; code?: unknown } } | null
    const message = typeof body?.error?.message === 'string' ? body.error.message : 'The request could not be completed.'
    const code = typeof body?.error?.code === 'string' ? body.error.code : null
    throw new ApiRequestError(response.status, message, code)
  }
  return schema.parse(raw)
}

export function getPublicHealth() {
  return readResponse('/api/v1/health', publicHealthSchema)
}

export function getAuthMe() {
  return readResponse('/api/v1/auth/me', authMeSchema)
}

export function signIn(username: string, password: string) {
  return readResponse('/api/v1/auth/login', apiAckSchema, { method: 'POST', body: JSON.stringify({ username, password }) })
}

export function completeSetup(input: { token: string; username: string; displayName: string; password: string; confirmPassword: string }) {
  return readResponse('/api/v1/auth/setup', apiAckSchema, { method: 'POST', body: JSON.stringify(input) })
}

export function signOut() {
  return readResponse('/api/v1/auth/logout', apiAckSchema, { method: 'POST', body: JSON.stringify({}) })
}

export function changePassword(input: { currentPassword: string; newPassword: string; confirmPassword: string }) {
  return readResponse('/api/v1/auth/change-password', apiAckSchema, { method: 'POST', body: JSON.stringify(input) })
}

export function updateProfile(displayName: string) {
  return readResponse('/api/v1/profile', authMeSchema, { method: 'PATCH', body: JSON.stringify({ displayName }) })
}

export function updateUserPreferences(input: { compactNavigation: boolean; defaultLanding: LandingPage }) {
  return readResponse('/api/v1/profile/preferences', authMeSchema, { method: 'PATCH', body: JSON.stringify(input) })
}

export function uploadAvatar(file: File) {
  const form = new FormData()
  form.append('avatar', file)
  return readResponse('/api/v1/profile/avatar', authMeSchema, { method: 'POST', body: form })
}

export function removeAvatar() {
  return readResponse('/api/v1/profile/avatar', authMeSchema, { method: 'DELETE' })
}

export function listAdminUsers() {
  return readResponse('/api/v1/admin/users', adminUsersSchema)
}

export function createAdminUser(input: { username: string; displayName: string; password: string; role: UserRole }) {
  return readResponse('/api/v1/admin/users', adminUserResultSchema, { method: 'POST', body: JSON.stringify(input) })
}

export function updateAdminUser(userId: string, input: { role: UserRole; enabled: boolean }) {
  return readResponse(`/api/v1/admin/users/${encodeURIComponent(userId)}`, adminUserResultSchema, { method: 'PATCH', body: JSON.stringify(input) })
}

export function resetAdminUserPassword(userId: string, password: string) {
  return readResponse(`/api/v1/admin/users/${encodeURIComponent(userId)}/password`, apiAckSchema, { method: 'POST', body: JSON.stringify({ password }) })
}

export function getWorkspacePreferences() {
  return readResponse('/api/v1/admin/workspace', workspacePreferencesSchema)
}

export function updateWorkspacePreferences(input: { displayName: string; defaultLanding: LandingPage }) {
  return readResponse('/api/v1/admin/workspace', workspacePreferencesSchema, { method: 'PATCH', body: JSON.stringify(input) })
}

export function getAuditEvents() {
  return readResponse('/api/v1/admin/audit', auditRecordsSchema)
}

export type AuthSnapshot = AuthMe
