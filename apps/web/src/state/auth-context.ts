import { createContext } from 'react'
import type { AuthMe } from '@mmsmanager/shared'

export type AuthPhase = 'loading' | 'setup-required' | 'anonymous' | 'authenticated' | 'unavailable'

export type AuthContextValue = {
  phase: AuthPhase
  snapshot: AuthMe | null
  error: string | null
  refresh: () => Promise<void>
  signIn: (username: string, password: string) => Promise<AuthMe>
  completePasswordChange: (input: { currentPassword: string; newPassword: string; confirmPassword: string }) => Promise<AuthMe>
  completeSetup: (input: { token: string; username: string; displayName: string; password: string; confirmPassword: string }) => Promise<AuthMe>
  signOut: () => Promise<void>
  replaceSnapshot: (snapshot: AuthMe) => void
  expireSession: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
