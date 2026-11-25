import type { UserPreferences, UserPreferencesUpdate } from '@mmsmanager/shared'
import type { UiPreferences } from './locale-context'

export function saveUiPreferencesInput(preferences: UiPreferences, compactNavigation: boolean, defaultLanding: UserPreferences['defaultLanding']): UserPreferencesUpdate {
  return { ...preferences, compactNavigation, defaultLanding }
}
