import { createHash } from 'node:crypto'
import type { JavaRuntime } from './java.js'

export type JavaSelectionReason =
  | 'manual-selection'
  | 'automatic-exact-minimum'
  | 'automatic-lowest-meeting-minimum'
  | 'automatic-requirement-unknown'
  | 'automatic-no-runtime'
  | 'automatic-scan-unavailable'
export type JavaMinimumCompatibility = 'meets-minimum' | 'unknown' | 'below-minimum'

export function classifyJavaMinimum(requiredMajor: number | null, selectedMajor: number | null): JavaMinimumCompatibility {
  if (requiredMajor === null || selectedMajor === null) return 'unknown'
  return selectedMajor < requiredMajor ? 'below-minimum' : 'meets-minimum'
}

export function selectAutomaticJavaRuntime(requiredMajor: number | null, runtimes: readonly JavaRuntime[]): {
  runtime: JavaRuntime | null
  reason: JavaSelectionReason
} {
  if (requiredMajor === null) return { runtime: null, reason: 'automatic-requirement-unknown' }
  const available = runtimes.filter((runtime) => Number.isSafeInteger(runtime.major) && runtime.major >= requiredMajor)
    .sort((left, right) => left.major - right.major || left.path.localeCompare(right.path))
  const exact = available.find((runtime) => runtime.major === requiredMajor)
  if (exact) return { runtime: exact, reason: 'automatic-exact-minimum' }
  const lowest = available[0]
  return lowest
    ? { runtime: lowest, reason: 'automatic-lowest-meeting-minimum' }
    : { runtime: null, reason: 'automatic-no-runtime' }
}

export function manualJavaOverrideFingerprint(identity: {
  serverId: string
  software: string
  serverVersion: string | null
  declaredMinimumMajor: number | null
  runtime: Pick<JavaRuntime, 'path' | 'major' | 'version'>
}): string {
  return createHash('sha256').update(JSON.stringify({
    serverId: identity.serverId,
    software: identity.software,
    serverVersion: identity.serverVersion,
    declaredMinimumMajor: identity.declaredMinimumMajor,
    runtimePath: identity.runtime.path,
    runtimeMajor: identity.runtime.major,
    runtimeVersion: identity.runtime.version,
  })).digest('hex')
}
