import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppConfigStore, DEFAULT_MONITORING_SETTINGS } from './app-config.js'

let directory: string | undefined

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('private versioned application config', () => {
  it('creates defaults outside the repository with owner-only permissions and reopens them', async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-config-'))
    const store = new AppConfigStore(directory)
    expect(await store.load()).toEqual(DEFAULT_MONITORING_SETTINGS)
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect(await readFile(store.path, 'utf8')).toContain('"version": 1')
    const changed = await store.update({ fastSampleMs: 2_000, historySaveMs: 15_000, diskRefreshMs: 45_000, statusPollMs: 20_000 })
    expect(changed).toEqual({ fastSampleMs: 2_000, historySaveMs: 15_000, diskRefreshMs: 45_000, statusPollMs: 20_000 })
    expect(await new AppConfigStore(directory).load()).toEqual(changed)
  })

  it('adds the status poll default when reopening an older version-one config', async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-config-migrate-'))
    const store = new AppConfigStore(directory)
    await writeFile(store.path, '{"version":1,"monitoring":{"fastSampleMs":2000,"historySaveMs":15000,"diskRefreshMs":45000}}\n')
    expect(await store.load()).toEqual({ fastSampleMs: 2_000, historySaveMs: 15_000, diskRefreshMs: 45_000, statusPollMs: 15_000 })
    expect(await readFile(store.path, 'utf8')).toContain('"statusPollMs": 15000')
  })

  it('rejects invalid settings and preserves an invalid existing file for diagnosis', async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-config-'))
    const store = new AppConfigStore(directory)
    await store.load()
    await expect(store.update({ fastSampleMs: 500, historySaveMs: 10_000, diskRefreshMs: 30_000, statusPollMs: 15_000 })).rejects.toThrow()
    await writeFile(store.path, '{"version":1,"monitoring":{"fastSampleMs":500}}\n')
    await expect(new AppConfigStore(directory).load()).rejects.toThrow('configuration is invalid')
    expect(await readFile(store.path, 'utf8')).toContain('fastSampleMs":500')
  })
})
