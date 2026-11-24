import { dirname } from 'node:path'
import { API_HOST, getApiPort, getDisplayTimeZone, getWebOrigin, secureCookiesEnabled } from './config.js'
import { openDatabase } from './db/client.js'
import { createApiApp } from './routes.js'
import { MachineCollector } from './machine/collector.js'
import { SystemInformationReader } from './machine/reader.js'
import { AuthService } from './auth/service.js'
import { AvatarStore } from './auth/avatar-store.js'
import { ServerRegistry } from './servers/registry.js'
import { JavaRuntimeRegistry } from './servers/java.js'
import { ServerProcessManager } from './servers/processes.js'

async function main(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('Stage 2 local machine monitoring currently supports Linux hosts only')
  }

  const timeZone = getDisplayTimeZone()
  const database = await openDatabase()
  const apiPort = getApiPort()
  const dataDirectory = dirname(database.path)
  const auth = new AuthService(database.native, dataDirectory)
  await auth.prepare()
  const avatars = new AvatarStore(dataDirectory)
  await avatars.prepare()
  const servers = new ServerRegistry(database.db, dataDirectory)
  await servers.prepare()
  const javaRuntimes = new JavaRuntimeRegistry()
  const processes = new ServerProcessManager(database.db, servers)
  const collector = new MachineCollector(database.db, new SystemInformationReader(), timeZone)
  const app = await createApiApp({
    db: database.db,
    collector,
    timeZone,
    auth,
    avatars,
    servers,
    javaRuntimes,
    processes,
    webOrigin: getWebOrigin(),
    apiPort,
    secureCookies: secureCookiesEnabled(),
    rateLimitMax: process.env['MMSMANAGER_E2E'] === '1' ? 5_000 : undefined,
  })
  await app.listen({ host: API_HOST, port: apiPort })
  collector.start()
  console.info(`MMSManager local API listening on http://${API_HOST}:${apiPort}`)
  if (auth.getSetupRequired()) console.info(`First administrator setup is required. Read the one-time credential locally from: ${auth.bootstrapPath}`)

  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await processes.shutdown()
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
