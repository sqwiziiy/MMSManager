import { z } from 'zod'

const nullablePercent = z.number().finite().min(0).max(100).nullable()
const nullableBytes = z.number().finite().nonnegative().nullable()
const datePattern = /^\d{4}-\d{2}-\d{2}$/

export const machineMetricSampleSchema = z.object({
  id: z.number().int().positive().nullable(),
  collectedAt: z.string().datetime({ offset: true }),
  cpuPercent: nullablePercent,
  coreCount: z.number().int().positive().nullable(),
  loadAverage: z.object({ one: z.number().finite(), five: z.number().finite(), fifteen: z.number().finite() }).nullable(),
  memory: z.object({
    usedBytes: nullableBytes,
    availableBytes: nullableBytes,
    totalBytes: nullableBytes,
    swapUsedBytes: nullableBytes,
    swapTotalBytes: nullableBytes,
    usedPercent: nullablePercent,
  }),
  storage: z.object({
    device: z.string().nullable(),
    mount: z.string().nullable(),
    usedBytes: nullableBytes,
    availableBytes: nullableBytes,
    totalBytes: nullableBytes,
    usedPercent: nullablePercent,
  }).nullable(),
  network: z.object({
    interface: z.string().nullable(),
    rxBytesPerSecond: nullableBytes,
    txBytesPerSecond: nullableBytes,
    rxTransferredBytes: nullableBytes,
    txTransferredBytes: nullableBytes,
  }),
  sampleStatus: z.enum(['ok', 'partial', 'error']),
  unavailableFields: z.array(z.string()),
  source: z.literal('systeminformation'),
})

export const machineHostSchema = z.object({
  id: z.literal('local'),
  hostname: z.string(),
  platform: z.string(),
  distro: z.string().nullable(),
  release: z.string().nullable(),
  architecture: z.string(),
  cpuModel: z.string().nullable(),
  coreCount: z.number().int().positive().nullable(),
  uptimeSeconds: z.number().finite().nonnegative().nullable(),
  source: z.literal('systeminformation'),
})

export const machineHealthSchema = z.object({
  service: z.literal('mmsmanager-local-api'),
  status: z.literal('ok'),
  timeZone: z.string(),
  collector: z.object({
    running: z.boolean(),
    intervalMs: z.number().int().positive(),
    lastSampleAt: z.string().datetime({ offset: true }).nullable(),
    lastSuccessfulAt: z.string().datetime({ offset: true }).nullable(),
  }),
})

export const machineCurrentSchema = z.object({
  status: z.enum(['live', 'stale', 'collecting']),
  timeZone: z.string(),
  host: machineHostSchema.nullable(),
  sample: machineMetricSampleSchema.nullable(),
  lastSuccessfulAt: z.string().datetime({ offset: true }).nullable(),
  intervalMs: z.number().int().positive(),
  provenance: z.literal('LOCAL_HOST'),
})

export const machineResourcePointSchema = z.object({
  observedAt: z.string().datetime({ offset: true }),
  sampleCount: z.number().int().positive(),
  cpuPercent: nullablePercent,
  memoryUsedBytes: nullableBytes,
  memoryTotalBytes: nullableBytes,
  memoryPercent: nullablePercent,
  storageUsedBytes: nullableBytes,
  storageTotalBytes: nullableBytes,
  storagePercent: nullablePercent,
  rxBytesPerSecond: nullableBytes,
  txBytesPerSecond: nullableBytes,
})

export const machineHistorySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  timeZone: z.string(),
  resolution: z.enum(['raw', 'minute']),
  points: z.array(machineResourcePointSchema),
})

export const machineCalendarDaySchema = z.object({
  date: z.string().regex(datePattern),
  status: z.enum(['observed', 'partial', 'no-data', 'future']),
  sampleCount: z.number().int().nonnegative(),
  firstSampleAt: z.string().datetime({ offset: true }).nullable(),
  lastSampleAt: z.string().datetime({ offset: true }).nullable(),
  coveragePercent: z.number().finite().min(0).max(100),
})

export const machineCalendarSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  timeZone: z.string(),
  days: z.array(machineCalendarDaySchema),
})

export const machineEventSchema = z.object({
  id: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  category: z.enum(['collector', 'sample']),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  source: z.literal('local-backend'),
})

export const machineDaySummarySchema = z.object({
  sampleCount: z.number().int().nonnegative(),
  firstSampleAt: z.string().datetime({ offset: true }).nullable(),
  lastSampleAt: z.string().datetime({ offset: true }).nullable(),
  coveragePercent: z.number().finite().min(0).max(100),
  cpuAveragePercent: nullablePercent,
  cpuMaximumPercent: nullablePercent,
  memoryPeakUsedBytes: nullableBytes,
  memoryTotalBytes: nullableBytes,
  memoryPeakPercent: nullablePercent,
  storageSnapshotUsedBytes: nullableBytes,
  storagePeakUsedBytes: nullableBytes,
  storageTotalBytes: nullableBytes,
  networkReceivedBytes: nullableBytes,
  networkTransmittedBytes: nullableBytes,
})

export const machineDaySchema = z.object({
  date: z.string().regex(datePattern),
  timeZone: z.string(),
  status: z.enum(['observed', 'partial', 'no-data', 'future']),
  summary: machineDaySummarySchema.nullable(),
  points: z.array(machineResourcePointSchema),
  events: z.array(machineEventSchema),
  window: z.object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    durationMs: z.number().int().positive(),
  }),
})

export const calendarQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
})

export const dateParamSchema = z.object({ date: z.string().regex(datePattern) })

export const historyQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(500).default(360),
})

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

export type MachineMetricSample = z.infer<typeof machineMetricSampleSchema>
export type MachineHost = z.infer<typeof machineHostSchema>
export type MachineHealth = z.infer<typeof machineHealthSchema>
export type MachineCurrent = z.infer<typeof machineCurrentSchema>
export type MachineResourcePoint = z.infer<typeof machineResourcePointSchema>
export type MachineHistory = z.infer<typeof machineHistorySchema>
export type MachineCalendarDay = z.infer<typeof machineCalendarDaySchema>
export type MachineCalendar = z.infer<typeof machineCalendarSchema>
export type MachineEvent = z.infer<typeof machineEventSchema>
export type MachineDay = z.infer<typeof machineDaySchema>
