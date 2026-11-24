import { useEffect, useState } from 'react'
import type { MachineStorage } from '@mmsmanager/shared'
import { getMachineStorage } from '../api/machine'

export function useMachineStorage() {
  const [storage, setStorage] = useState<MachineStorage | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await getMachineStorage()
        if (active) { setStorage(result); setError(false) }
      } catch {
        if (active) setError(true)
      } finally { inFlight = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 30_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  return { storage, error }
}

export function primaryStorageVolume(storage: MachineStorage | null) {
  const volumes = storage?.volumes ?? []
  const priorities = ['server-data', 'application-data', 'home', 'system', 'local'] as const
  return priorities.map((role) => volumes.find((volume) => volume.roles.includes(role))).find(Boolean) ?? null
}
