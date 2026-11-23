export function formatBytes(bytes: number | null, precision = 1): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'Unavailable'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let amount = bytes
  let unit = 'B'
  for (const next of units) {
    amount /= 1024
    unit = next
    if (amount < 1024) break
  }
  return `${amount.toFixed(precision)} ${unit}`
}

export function formatRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return 'Unavailable'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'Unavailable' : `${Math.round(value)}%`
}

export function formatTimestamp(value: string | null | undefined, timeZone?: string): string {
  if (!value) return 'Waiting for first sample'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value))
}

export function formatConfiguredDate(value: string, timeZone: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, ...options }).format(new Date(value))
}
