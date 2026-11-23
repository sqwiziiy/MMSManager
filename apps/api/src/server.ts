import { API_HOST, getApiPort, getDisplayTimeZone } from './config.js'
import { openDatabase } from './db/client.js'
import { createApiApp } from './routes.js'
import { MachineCollector } from './machine/collector.js'
import { SystemInformationReader } from './machine/reader.js'

async function main(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('Stage 2 local machine monitoring currently supports Linux hosts only')
  }

  const timeZone = getDisplayTimeZone()
  const database = await openDatabase()
  const collector = new MachineCollector(database.db, new SystemInformationReader(), timeZone)
  const app = await createApiApp({ db: database.db, collector, timeZone })
  await app.listen({ host: API_HOST, port: getApiPort() })
  collector.start()
  console.info(`MMSManager read-only API listening on http://${API_HOST}:${getApiPort()}`)

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await collector.stop()
    await app.close()
    database.native.close()
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup error'
  console.error(`MMSManager local API failed to start: ${message}`)
  process.exitCode = 1
})
