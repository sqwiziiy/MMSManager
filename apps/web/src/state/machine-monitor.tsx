import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { MachineResourcePoint } from '@mmsmanager/shared'
import { getMachineCurrent, getMachineHistory } from '../api/machine'
import { initialState, MachineCurrentContext, MachineHistoryContext, MachineStatusContext } from './machine-monitor-context'

const HISTORY_REFRESH_MS = 60_000

export function MachineMonitorProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState)
  const stateRef = useRef(state)
  const inFlight = useRef(false)
  const lastHistoryRefresh = useRef(0)
  const active = useRef(false)
  const [pollIntervalMs, setPollIntervalMs] = useState(1_000)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const refresh = useCallback(async (forceHistory = false) => {
    if (inFlight.current) return
    inFlight.current = true
    const now = Date.now()
    const shouldRefreshHistory = forceHistory || lastHistoryRefresh.current === 0 || now - lastHistoryRefresh.current >= HISTORY_REFRESH_MS
    try {
      const current = await getMachineCurrent()
      setPollIntervalMs(current.intervalMs)
      let history = stateRef.current.history
      let historyError: string | null = null
      if (shouldRefreshHistory) {
        try {
          history = await getMachineHistory(new Date(now - 24 * 60 * 60 * 1000), new Date(now))
          lastHistoryRefresh.current = now
        } catch {
          historyError = 'Persisted history is unavailable right now.'
        }
      }
      let livePoints = stateRef.current.livePoints
      if (current.sample && current.status === 'live') {
        const sample = current.sample
        const point: MachineResourcePoint = {
          observedAt: sample.collectedAt,
          sampleCount: 1,
          cpuSampleCount: sample.cpuPercent === null ? 0 : 1,
          networkSampleCount: sample.network.rxBytesPerSecond === null || sample.network.txBytesPerSecond === null ? 0 : 1,
          bucketSeconds: Math.max(1, Math.ceil(current.intervalMs / 1000)),
          coveragePercent: 100,
          cpuPercent: sample.cpuPercent,
          memoryUsedBytes: sample.memory.usedBytes,
          memoryTotalBytes: sample.memory.totalBytes,
          memoryPercent: sample.memory.usedPercent,
          storageUsedBytes: sample.storage?.usedBytes ?? null,
          storageTotalBytes: sample.storage?.totalBytes ?? null,
          storagePercent: sample.storage?.usedPercent ?? null,
          rxBytesPerSecond: sample.network.rxBytesPerSecond,
          txBytesPerSecond: sample.network.txBytesPerSecond,
        }
        livePoints = [...livePoints.filter((item) => item.observedAt !== point.observedAt), point]
          .filter((item) => Date.parse(item.observedAt) >= now - 5 * 60_000)
          .slice(-300)
      }
      if (!active.current) return
      const next = {
        apiStatus: 'online' as const,
        current,
        history,
        livePoints,
        error: null,
        historyError,
        refreshedAt: now,
      }
      stateRef.current = next
      setState(next)
    } catch {
      if (!active.current) return
      const next = {
        ...stateRef.current,
        apiStatus: 'offline' as const,
        error: 'The local monitoring API is unavailable.',
        refreshedAt: now,
      }
      stateRef.current = next
      setState(next)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    active.current = true
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, pollIntervalMs)
    return () => {
      active.current = false
      window.clearInterval(timer)
    }
  }, [refresh, pollIntervalMs])

  const refreshNow = useCallback(() => { void refresh(true) }, [refresh])
  const current = state.current
  const livePoints = state.livePoints
  const error = state.error
  const refreshedAt = state.refreshedAt
  const history = state.history
  const historyError = state.historyError
  const apiStatus = state.apiStatus
  const machineStatus = current?.status ?? null
  const currentValue = useMemo(() => ({ current, livePoints, error, refreshedAt, refreshNow }), [current, livePoints, error, refreshedAt, refreshNow])
  const historyValue = useMemo(() => ({ history, historyError }), [history, historyError])
  const statusValue = useMemo(() => ({ apiStatus, machineStatus, error, refreshNow }), [apiStatus, machineStatus, error, refreshNow])
  return <MachineCurrentContext.Provider value={currentValue}><MachineHistoryContext.Provider value={historyValue}><MachineStatusContext.Provider value={statusValue}>{children}</MachineStatusContext.Provider></MachineHistoryContext.Provider></MachineCurrentContext.Provider>
}
