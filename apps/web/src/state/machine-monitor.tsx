import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { getMachineCurrent, getMachineHistory } from '../api/machine'
import { initialState, MachineMonitorContext } from './machine-monitor-context'

const POLL_INTERVAL_MS = 10_000
const HISTORY_REFRESH_MS = 60_000

export function MachineMonitorProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState)
  const stateRef = useRef(state)
  const inFlight = useRef(false)
  const lastHistoryRefresh = useRef(0)
  const active = useRef(false)

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
      if (!active.current) return
      const next = {
        apiStatus: 'online' as const,
        current,
        history,
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
    const timer = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => {
      active.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const refreshNow = useCallback(() => { void refresh(true) }, [refresh])
  const value = useMemo(() => ({ ...state, refreshNow }), [state, refreshNow])
  return <MachineMonitorContext.Provider value={value}>{children}</MachineMonitorContext.Provider>
}
