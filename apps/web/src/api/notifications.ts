import { notificationsResponseSchema } from '@mmsmanager/shared'
import type { NotificationsResponse } from '@mmsmanager/shared'
import { apiRequest } from './client'

export function getNotifications(signal?: AbortSignal): Promise<NotificationsResponse> {
  return apiRequest('/api/v1/notifications', notificationsResponseSchema, { signal })
}

export function markNotificationRead(eventId: string): Promise<NotificationsResponse> {
  return apiRequest(`/api/v1/notifications/${encodeURIComponent(eventId)}/read`, notificationsResponseSchema, {
    method: 'PATCH', body: JSON.stringify({}),
  })
}
