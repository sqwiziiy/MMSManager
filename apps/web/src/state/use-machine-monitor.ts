import { useContext } from 'react'
import { MachineCurrentContext, MachineHistoryContext, MachineStatusContext } from './machine-monitor-context'
import type { MachineMonitorValue, MachineStatusSlice } from './machine-monitor-context'

export function useMachineMonitor(): MachineMonitorValue {
  const current = useContext(MachineCurrentContext)
  const history = useContext(MachineHistoryContext)
  const status = useContext(MachineStatusContext)
  if (!current || !history || !status) throw new Error('useMachineMonitor must be used inside MachineMonitorProvider')
  return { ...current, ...history, apiStatus: status.apiStatus }
}

export function useMachineHistory(): Pick<MachineMonitorValue, 'history' | 'historyError'> {
  const value = useContext(MachineHistoryContext)
  if (!value) throw new Error('useMachineHistory must be used inside MachineMonitorProvider')
  return value
}

export function useMachineStatus(): MachineStatusSlice {
  const value = useContext(MachineStatusContext)
  if (!value) throw new Error('useMachineStatus must be used inside MachineMonitorProvider')
  return value
}
