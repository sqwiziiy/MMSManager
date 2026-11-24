import { createContext } from 'react'
import type { MachineCurrent, MachineHistory, MachineResourcePoint } from '@mmsmanager/shared'

export type MonitorState = {
  apiStatus: 'checking' | 'online' | 'offline'
  current: MachineCurrent | null
  history: MachineHistory | null
  livePoints: MachineResourcePoint[]
  error: string | null
  historyError: string | null
  refreshedAt: number | null
}

export type MachineMonitorValue = MonitorState & { refreshNow: () => void }
export type MachineCurrentSlice = Pick<MonitorState, 'current' | 'livePoints' | 'error' | 'refreshedAt'> & { refreshNow: () => void }
export type MachineHistorySlice = Pick<MonitorState, 'history' | 'historyError'>
export type MachineStatusSlice = Pick<MonitorState, 'apiStatus' | 'error'> & { machineStatus: MachineCurrent['status'] | null; refreshNow: () => void }

export const initialState: MonitorState = {
  apiStatus: 'checking',
  current: null,
  history: null,
  livePoints: [],
  error: null,
  historyError: null,
  refreshedAt: null,
}

export const MachineCurrentContext = createContext<MachineCurrentSlice | null>(null)
export const MachineHistoryContext = createContext<MachineHistorySlice | null>(null)
export const MachineStatusContext = createContext<MachineStatusSlice | null>(null)
