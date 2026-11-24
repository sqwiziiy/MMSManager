import { activityResponseSchema } from '@mmsmanager/shared'
import type { ActivityQuery, ActivityResponse } from '@mmsmanager/shared'
import { apiRequest } from './client'

export function getActivity(query: Partial<ActivityQuery> = {}, signal?: AbortSignal): Promise<ActivityResponse> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const suffix = params.size ? `?${params.toString()}` : ''
  return apiRequest(`/api/v1/activity${suffix}`, activityResponseSchema, { signal })
}
