import {
  adminUsersSchema,
  adminUserResultSchema,
  apiAckSchema,
  userDeleteResultSchema,
  auditRecordsSchema,
  authMeSchema,
  publicHealthSchema,
  workspacePreferencesSchema,
} from '@mmsmanager/shared'
import type { AuthMe, LandingPage, UserPreferencesUpdate, UserRole } from '@mmsmanager/shared'
import { apiRequest } from './client'
export { ApiRequestError } from './client'

async function readResponse<T>(path: string, schema: { parse: (input: unknown) => T }, init: RequestInit = {}): Promise<T> {
  const suppressSessionExpiry = path.endsWith('/auth/me') || path.endsWith('/auth/login') || path.endsWith('/auth/setup')
  return apiRequest(path, schema, init, { suppressSessionExpiry })
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

export function updateUserPreferences(input: UserPreferencesUpdate) {
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

export function deleteAdminUser(userId: string, confirmation: string) {
  return readResponse(`/api/v1/admin/users/${encodeURIComponent(userId)}`, userDeleteResultSchema, { method: 'DELETE', body: JSON.stringify({ confirmation }) })
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
