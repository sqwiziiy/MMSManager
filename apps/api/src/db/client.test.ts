import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from './client.js'

describe('SQLite migration recovery', () => {
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
