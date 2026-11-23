import { createContext } from 'react'
import type { MachineCurrent, MachineHistory } from '@mmsmanager/shared'

export type MonitorState = {
  apiStatus: 'checking' | 'online' | 'offline'
  current: MachineCurrent | null
  history: MachineHistory | null
  error: string | null
  historyError: string | null
  refreshedAt: number | null
}

export type MachineMonitorValue = MonitorState & { refreshNow: () => void }

export const initialState: MonitorState = {
  apiStatus: 'checking',
  current: null,
  history: null,
  error: null,
  historyError: null,
  refreshedAt: null,
}

export const MachineMonitorContext = createContext<MachineMonitorValue | null>(null)
