import {
  machineCalendarSchema,
  machineCurrentSchema,
  machineDaySchema,
  machineHistorySchema,
} from '@mmsmanager/shared'
import type { MachineCalendar, MachineCurrent, MachineDay, MachineHistory } from '@mmsmanager/shared'
import { apiRequest } from './client'

function readResponse<T>(url: string, schema: { parse: (value: unknown) => T }, signal?: AbortSignal): Promise<T> {
  return apiRequest(url, schema, { signal })
}

export function getMachineCurrent(signal?: AbortSignal): Promise<MachineCurrent> {
  return readResponse('/api/v1/machine/current', machineCurrentSchema, signal)
}

export function getMachineHistory(from: Date, to: Date, limit = 360, signal?: AbortSignal): Promise<MachineHistory> {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), limit: String(limit) })
  return readResponse(`/api/v1/machine/history?${query}`, machineHistorySchema, signal)
}

export function getMachineCalendar(year: number, month: number, signal?: AbortSignal): Promise<MachineCalendar> {
  const query = new URLSearchParams({ year: String(year), month: String(month) })
  return readResponse(`/api/v1/machine/calendar?${query}`, machineCalendarSchema, signal)
}

export function getMachineDay(date: string, signal?: AbortSignal): Promise<MachineDay> {
  return readResponse(`/api/v1/machine/day/${encodeURIComponent(date)}`, machineDaySchema, signal)
}

export function isRequestCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
