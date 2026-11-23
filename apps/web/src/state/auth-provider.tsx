import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthMe } from '@mmsmanager/shared'
import { ApiRequestError, completeSetup as sendSetup, getAuthMe, getPublicHealth, signIn as sendSignIn, signOut as sendSignOut } from '../api/auth'
import { AuthContext } from './auth-context'
import type { AuthPhase } from './auth-context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>('loading')
  const [snapshot, setSnapshot] = useState<AuthMe | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setPhase('loading')
    setError(null)
    try {
      const health = await getPublicHealth()
      if (health.setupRequired) {
        setSnapshot(null)
        setPhase('setup-required')
        return
      }
      try {
        const current = await getAuthMe()
        setSnapshot(current)
        setPhase('authenticated')
      } catch (requestError) {
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          setSnapshot(null)
          setPhase('anonymous')
        } else {
          throw requestError
        }
      }
    } catch {
      setSnapshot(null)
      setPhase('unavailable')
      setError('The local API could not be reached. Check that MMSManager is running, then retry.')
    }
  }, [])

  const signIn = useCallback(async (username: string, password: string): Promise<AuthMe> => {
    await sendSignIn(username, password)
    const current = await getAuthMe()
    setSnapshot(current)
    setError(null)
    setPhase('authenticated')
    return current
  }, [])

  const completeSetup = useCallback(async (input: { token: string; username: string; displayName: string; password: string; confirmPassword: string }): Promise<AuthMe> => {
    await sendSetup(input)
    const current = await getAuthMe()
    setSnapshot(current)
    setError(null)
    setPhase('authenticated')
    return current
  }, [])

  const signOut = useCallback(async () => {
    try { await sendSignOut() } finally {
      setSnapshot(null)
      setPhase('anonymous')
    }
  }, [])

  const replaceSnapshot = useCallback((next: AuthMe) => {
    setSnapshot(next)
    setPhase('authenticated')
  }, [])

  const expireSession = useCallback(() => {
    setSnapshot(null)
    setPhase('anonymous')
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const onExpired = () => expireSession()
    window.addEventListener('mmsmanager:session-expired', onExpired)
    return () => window.removeEventListener('mmsmanager:session-expired', onExpired)
  }, [expireSession])

  const value = useMemo(() => ({ phase, snapshot, error, refresh, signIn, completeSetup, signOut, replaceSnapshot, expireSession }), [phase, snapshot, error, refresh, signIn, completeSetup, signOut, replaceSnapshot, expireSession])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
