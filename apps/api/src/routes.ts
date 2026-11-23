import cors from '@fastify/cors'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import {
  calendarQuerySchema,
  dateParamSchema,
  historyQuerySchema,
  machineCalendarSchema,
  machineCurrentSchema,
  machineDaySchema,
  machineHealthSchema,
  machineHistorySchema,
} from '@mmsmanager/shared'
import { API_HOST, WEB_ORIGIN } from './config.js'
import type { AppDatabase } from './db/client.js'
import type { MachineCollector } from './machine/collector.js'
import { MachineHistoryService } from './machine/history.js'
import { validateCalendarDate } from './time.js'

class InvalidRequestError extends Error {}

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new InvalidRequestError('Invalid request parameters')
  return parsed.data
}

export async function createApiApp(options: {
  db: AppDatabase
  collector: MachineCollector
  timeZone: string
  now?: () => number
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 })
  const history = new MachineHistoryService(options.db, options.timeZone, options.now)
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === WEB_ORIGIN),
    methods: ['GET'],
    allowedHeaders: ['content-type'],
    credentials: false,
    maxAge: 600,
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof InvalidRequestError || error instanceof RangeError) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: error.message } })
    }
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'The local data request failed.' } })
  })

  app.get('/api/v1/health', async () => machineHealthSchema.parse(history.getHealth(options.collector.health)))
  app.get('/api/v1/machine/current', async () => machineCurrentSchema.parse(history.getCurrent(options.collector.health)))
  app.get('/api/v1/machine/history', async (request) => {
    const query = parse(historyQuerySchema, request.query)
    return machineHistorySchema.parse(history.getHistory(query.from, query.to, query.limit))
  })
  app.get('/api/v1/machine/calendar', async (request) => {
    const query = parse(calendarQuerySchema, request.query)
    return machineCalendarSchema.parse(history.getCalendar(query.year, query.month))
  })
  app.get('/api/v1/machine/day/:date', async (request) => {
    const params = parse(dateParamSchema, request.params)
    validateCalendarDate(params.date)
    return machineDaySchema.parse(history.getDay(params.date))
  })

  await app.ready()
  return app
}

export { API_HOST }
