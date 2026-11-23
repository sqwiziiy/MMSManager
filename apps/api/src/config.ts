import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const API_HOST = '127.0.0.1'
export const WEB_ORIGIN = 'http://127.0.0.1:5173'
export const COLLECTOR_INTERVAL_MS = 10_000
export const RAW_RETENTION_DAYS = 7
export const MINUTE_RETENTION_DAYS = 90
export const EVENT_RETENTION_DAYS = 90
export const MAX_HISTORY_DAYS = 31
export const TELEMETRY_SOURCE = 'systeminformation' as const

export function getDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['MMSMANAGER_DATA_DIR']
  if (configured) return resolve(configured)
  const stateHome = env['XDG_STATE_HOME'] || join(homedir(), '.local', 'state')
  return resolve(stateHome, 'mmsmanager')
}

export function getDisplayTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const value = env['MMSMANAGER_TIME_ZONE'] || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
  } catch {
    throw new Error('MMSMANAGER_TIME_ZONE must be a valid IANA timezone')
  }
  return value
}

export function getApiPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MMSMANAGER_API_PORT']
  if (!raw) return 4174
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('MMSMANAGER_API_PORT must be an integer between 1024 and 65535')
  }
  return port
}
