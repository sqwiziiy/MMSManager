import { monitoringSettingsSchema } from '@mmsmanager/shared'
import type { MonitoringSettings } from '@mmsmanager/shared'
import { apiRequest } from './client'

export function getMonitoringSettings(signal?: AbortSignal): Promise<MonitoringSettings> {
  return apiRequest('/api/v1/admin/monitoring-settings', monitoringSettingsSchema, { signal })
}

export function updateMonitoringSettings(settings: MonitoringSettings): Promise<MonitoringSettings> {
  return apiRequest('/api/v1/admin/monitoring-settings', monitoringSettingsSchema, {
    method: 'PATCH',
    body: JSON.stringify(settings),
  })
}
