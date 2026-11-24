import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_MONITORING_SETTINGS, monitoringSettingsSchema } from '@mmsmanager/shared'
import type { MonitoringSettings } from '@mmsmanager/shared'

export { DEFAULT_MONITORING_SETTINGS }

function parseConfig(value: unknown): MonitoringSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be an object.')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'version' && key !== 'monitoring')) throw new Error('Configuration contains unsupported fields.')
  if (record['version'] !== 1) throw new Error('Unsupported configuration version.')
  if (!record['monitoring'] || typeof record['monitoring'] !== 'object' || Array.isArray(record['monitoring'])) {
    throw new Error('Monitoring settings must be an object.')
  }
  const monitoring = record['monitoring'] as Record<string, unknown>
  if (Object.keys(monitoring).some((key) => !['fastSampleMs', 'historySaveMs', 'diskRefreshMs', 'statusPollMs'].includes(key))) {
    throw new Error('Monitoring settings contain unsupported fields.')
  }
  return monitoringSettingsSchema.parse({
    ...monitoring,
    statusPollMs: monitoring['statusPollMs'] === undefined ? DEFAULT_MONITORING_SETTINGS.statusPollMs : monitoring['statusPollMs'],
  })
}

export class AppConfigStore {
  readonly path: string
  private value: MonitoringSettings = DEFAULT_MONITORING_SETTINGS

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, 'app-config.json')
  }

  async load(): Promise<MonitoringSettings> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.path), 0o700)
    try {
      const stats = await lstat(this.path)
      if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Application configuration must be a regular file.')
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      this.value = parseConfig(parsed)
      const savedSettings = parsed && typeof parsed === 'object' && 'monitoring' in parsed
        ? (parsed as { monitoring?: Record<string, unknown> }).monitoring
        : undefined
      if (savedSettings && savedSettings['statusPollMs'] === undefined) await this.persist(this.value)
      await chmod(this.path, 0o600)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        await this.persist(DEFAULT_MONITORING_SETTINGS)
        return this.value
      }
      throw new Error('The application configuration is invalid or cannot be read. Existing file was left unchanged.', { cause: error })
    }
    return this.value
  }

  get(): MonitoringSettings {
    return { ...this.value }
  }

  async update(settings: MonitoringSettings): Promise<MonitoringSettings> {
    const validated = monitoringSettingsSchema.parse(settings)
    await this.persist(validated)
    return this.get()
  }

  private async persist(settings: MonitoringSettings): Promise<void> {
    const validated = monitoringSettingsSchema.parse(settings)
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    const payload = `${JSON.stringify({ version: 1, monitoring: validated }, null, 2)}\n`
    await writeFile(temporaryPath, payload, { flag: 'wx', mode: 0o600 })
    try {
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, this.path)
      await chmod(this.path, 0o600)
      this.value = validated
    } catch (error) {
      const { rm } = await import('node:fs/promises')
      await rm(temporaryPath, { force: true })
      throw error
    }
  }
}
