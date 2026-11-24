import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './client.js'

describe('SQLite migration recovery', () => {
  it('applies the Stage 5D and 5E ledgers with bounded lookup indexes in a temporary database', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mmsmanager-stage-5d-migration-'))
    const databasePath = join(temp, 'state.sqlite')
    try {
      const opened = await openDatabase({ path: databasePath })
      try {
        const tables = opened.native.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name)
        const indexes = opened.native.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => (row as { name: string }).name)
        const backupColumns = opened.native.prepare("PRAGMA table_info('local_server_backups')").all().map((row) => (row as { name: string }).name)
        expect(tables).toContain('local_server_structured_events')
        expect(tables).toContain('local_server_resource_samples')
        expect(tables).toContain('local_server_sessions')
        expect(tables).toContain('local_server_backups')
        expect(tables).toContain('local_server_backup_restores')
        expect(indexes).toContain('local_server_structured_events_server_time_idx')
        expect(indexes).toContain('local_server_resource_samples_server_minute_unique')
        expect(indexes).toContain('local_server_sessions_active_unique')
        expect(indexes).toContain('local_server_backups_server_time_idx')
        expect(indexes).toContain('local_server_backup_restores_status_idx')
        expect(backupColumns).toContain('manifest_size_bytes')
        expect(backupColumns).toContain('world_paths_json')
        expect(opened.native.pragma('integrity_check', { simple: true })).toBe('ok')
      } finally { opened.native.close() }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('creates and verifies a private online backup before an additive migration', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'mmsmanager-migration-'))
    const migrationsFolder = join(temp, 'migrations')
    const databasePath = join(temp, 'state.sqlite')
    const writeJournal = async (count: number) => writeFile(join(migrationsFolder, 'meta', '_journal.json'), JSON.stringify({
      version: '7', dialect: 'sqlite',
      entries: Array.from({ length: count }, (_, index) => ({ idx: index, version: '6', when: index + 1, tag: '000' + index + '_fixture', breakpoints: true })),
    }))
    try {
      await mkdir(join(migrationsFolder, 'meta'), { recursive: true })
      await writeFile(join(migrationsFolder, '0000_fixture.sql'), 'CREATE TABLE fixture (value TEXT NOT NULL);\n')
      await writeJournal(1)
      const first = await openDatabase({ path: databasePath, migrationsFolder })
      first.native.exec("INSERT INTO fixture (value) VALUES ('preserved')")
      first.native.close()

      await writeFile(join(migrationsFolder, '0001_fixture.sql'), 'CREATE TABLE added (value TEXT);\n')
      await writeJournal(2)
      const second = await openDatabase({ path: databasePath, migrationsFolder })
      try {
        expect(second.native.prepare("SELECT value FROM fixture").get()).toEqual({ value: 'preserved' })
        expect(second.native.prepare("SELECT name FROM sqlite_master WHERE name = 'added'").get()).toEqual({ name: 'added' })
      } finally { second.native.close() }

      const backups = (await readdir(temp)).filter((name) => name.endsWith('.backup'))
      expect(backups).toHaveLength(1)
      const backupPath = join(temp, backups[0]!)
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600)
      const backup = new Database(backupPath, { readonly: true, fileMustExist: true })
      try {
        expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
        expect(backup.prepare('SELECT value FROM fixture').get()).toEqual({ value: 'preserved' })
        expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'added'").get()).toBeUndefined()
      } finally { backup.close() }
      expect((await readFile(join(migrationsFolder, '0001_fixture.sql'), 'utf8'))).toContain('CREATE TABLE added')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})
