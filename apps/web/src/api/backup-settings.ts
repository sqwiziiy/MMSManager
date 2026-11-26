import { backupSettingsResultSchema, backupSettingsSchema } from '@mmsmanager/shared'
import type { BackupSettings, BackupSettingsResult } from '@mmsmanager/shared'
import { apiRequest } from './client'

export function getBackupSettings(signal?: AbortSignal): Promise<BackupSettingsResult> {
  return apiRequest('/api/v1/admin/backup-settings', backupSettingsResultSchema, { signal })
}

export function updateBackupSettings(settings: BackupSettings): Promise<BackupSettingsResult> {
  return apiRequest('/api/v1/admin/backup-settings', backupSettingsResultSchema, {
    method: 'PATCH',
    body: JSON.stringify(backupSettingsSchema.parse(settings)),
  })
}
