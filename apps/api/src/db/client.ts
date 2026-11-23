import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.js'
import { getDataDirectory } from '../config.js'

export type AppDatabase = ReturnType<typeof drizzle<typeof schema>>

export async function openDatabase(options: {
  path?: string
  migrationsFolder?: string
} = {}): Promise<{ native: Database.Database; db: AppDatabase; path: string }> {
  const databasePath = options.path ?? join(getDataDirectory(), 'mmsmanager.sqlite')
  if (databasePath !== ':memory:') {
    const directory = databasePath.substring(0, databasePath.lastIndexOf('/'))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }

  const native = new Database(databasePath)
  native.pragma('foreign_keys = ON')
  native.pragma('busy_timeout = 5000')
  native.pragma('journal_mode = WAL')
  const db = drizzle({ client: native, schema })
  const migrationsFolder = options.migrationsFolder ?? fileURLToPath(new URL('../../drizzle/', import.meta.url))
  await migrate(db, { migrationsFolder })

  if (databasePath !== ':memory:') await chmod(databasePath, 0o600)
  return { native, db, path: databasePath }
}
