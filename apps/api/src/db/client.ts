import { existsSync } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import * as schema from './schema.js'
import { getDataDirectory } from '../config.js'

export type AppDatabase = ReturnType<typeof drizzle<typeof schema>>

export async function openDatabase(options: {
  path?: string
  migrationsFolder?: string
} = {}): Promise<{ native: Database.Database; db: AppDatabase; path: string }> {
  const databasePath = options.path ?? join(getDataDirectory(), 'mmsmanager.sqlite')
  const existed = databasePath !== ':memory:' && existsSync(databasePath)
  if (databasePath !== ':memory:') {
    const directory = databasePath.substring(0, databasePath.lastIndexOf('/'))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }

  const native = new Database(databasePath)
  native.pragma('foreign_keys = ON')
  native.pragma('busy_timeout = 5000')
  native.pragma('journal_mode = WAL')
  try {
    const db = drizzle({ client: native, schema })
    const migrationsFolder = options.migrationsFolder ?? fileURLToPath(new URL('../../drizzle/', import.meta.url))
    const newest = readMigrationFiles({ migrationsFolder }).at(-1)?.folderMillis
    if (existed && newest !== undefined) {
      const hasLedger = native.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get()
      const applied = hasLedger ? (native.prepare('SELECT MAX(created_at) AS newest FROM __drizzle_migrations').get() as { newest: number | null }).newest : null
      if (applied === null || Number(applied) < newest) {
        const backupPath = join(dirname(databasePath), `${basename(databasePath)}.pre-migration-${newest}-${randomUUID()}.backup`)
        await native.backup(backupPath)
        await chmod(backupPath, 0o600)
        const verification = new Database(backupPath, { readonly: true, fileMustExist: true })
        try {
          if (verification.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('The pre-migration SQLite backup failed its integrity check.')
        } finally { verification.close() }
      }
    }
    await migrate(db, { migrationsFolder })
    if (databasePath !== ':memory:') await chmod(databasePath, 0o600)
    return { native, db, path: databasePath }
  } catch (error) {
    native.close()
    throw error
  }
}
