import { useContext } from 'react'
import { MachineMonitorContext } from './machine-monitor-context'
import type { MachineMonitorValue } from './machine-monitor-context'

export function useMachineMonitor(): MachineMonitorValue {
  const value = useContext(MachineMonitorContext)
  if (!value) throw new Error('useMachineMonitor must be used inside MachineMonitorProvider')
  return value
}
