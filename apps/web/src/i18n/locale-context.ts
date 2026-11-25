import { createContext, useContext } from 'react'
import type { UserPreferences } from '@mmsmanager/shared'

export type UiLanguage = 'en' | 'ru'
export type UiPreferences = Pick<UserPreferences, 'language' | 'theme' | 'accent' | 'density' | 'reducedMotion'>

type UiContextValue = {
  preferences: UiPreferences
  language: UiLanguage
  setLanguage: (language: UiLanguage) => void
  setPreview: (preferences: Partial<UiPreferences>) => void
  clearPreview: () => void
}

export const UiContext = createContext<UiContextValue | null>(null)

export function useUiPreferences(): UiContextValue {
  const context = useContext(UiContext)
  if (!context) throw new Error('useUiPreferences must be used inside LocaleProvider')
  return context
}
