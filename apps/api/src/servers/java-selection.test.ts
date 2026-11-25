import { describe, expect, it } from 'vitest'
import type { JavaRuntime } from './java.js'
import { classifyJavaMinimum, manualJavaOverrideFingerprint, selectAutomaticJavaRuntime } from './java-selection.js'

const java = (major: number, path = `/fixture/java-${major}`): JavaRuntime => ({
  path, version: `${major}.0.1`, major, vendor: 'Fixture', source: 'discovered',
})

describe('server Java selection', () => {
  it('prefers the exact declared minimum over newer installed Java versions', () => {
    const selected = selectAutomaticJavaRuntime(21, [java(25), java(21), java(23)])
    expect(selected).toEqual({ runtime: java(21), reason: 'automatic-exact-minimum' })
  })

  it('uses the lowest installed version that meets a declared minimum when no exact version exists', () => {
    const selected = selectAutomaticJavaRuntime(21, [java(25), java(23), java(24)])
    expect(selected).toEqual({ runtime: java(23), reason: 'automatic-lowest-meeting-minimum' })
  })

  it('does not choose a runtime for an unknown requirement or when no installed runtime meets it', () => {
    expect(selectAutomaticJavaRuntime(null, [java(21)])).toEqual({ runtime: null, reason: 'automatic-requirement-unknown' })
    expect(selectAutomaticJavaRuntime(21, [java(8), java(17)])).toEqual({ runtime: null, reason: 'automatic-no-runtime' })
    expect(classifyJavaMinimum(null, 21)).toBe('unknown')
    expect(classifyJavaMinimum(21, 8)).toBe('below-minimum')
    expect(classifyJavaMinimum(21, 21)).toBe('meets-minimum')
  })

  it('ties a manual exception to the server requirement and checked executable identity', () => {
    const identity = { serverId: 'fixture', software: 'vanilla', serverVersion: '1.21.4', declaredMinimumMajor: 21, runtime: java(8) }
    const original = manualJavaOverrideFingerprint(identity)
    expect(manualJavaOverrideFingerprint({ ...identity, serverVersion: '1.21.5' })).not.toBe(original)
    expect(manualJavaOverrideFingerprint({ ...identity, declaredMinimumMajor: 17 })).not.toBe(original)
    expect(manualJavaOverrideFingerprint({ ...identity, runtime: java(8, '/fixture/other-java') })).not.toBe(original)
    expect(manualJavaOverrideFingerprint({ ...identity, runtime: { ...java(8), version: '8.0.2' } })).not.toBe(original)
  })
})
