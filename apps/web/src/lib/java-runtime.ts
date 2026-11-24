import type { JavaRuntime } from '@mmsmanager/shared'

export function javaRuntimeLabel(runtime: JavaRuntime, runtimes: JavaRuntime[]): string {
  const base = `${runtime.vendor ?? 'Java'} ${runtime.major} · ${runtime.version}`
  const matches = runtimes.filter((item) => item.vendor === runtime.vendor && item.major === runtime.major && item.version === runtime.version)
  if (matches.length < 2) return base
  const index = matches.findIndex((item) => item.path === runtime.path)
  return `${base} · Runtime ${index + 1}`
}
