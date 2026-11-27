import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { serverTemplateInputSchema } from '@mmsmanager/shared'
import { openDatabase } from '../db/client.js'
import { users } from '../db/schema.js'
import { ActivityFeedService } from '../activity/feed.js'
import { ServerTemplateError, ServerTemplateService } from './templates.js'

describe('persisted local server templates', () => {
  let directory: string
  let databasePath: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let templates: ServerTemplateService
  let actorId: string
  const at = '2026-11-24T10:00:00.000Z'

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mmsmanager-templates-'))
    databasePath = join(directory, 'mmsmanager.sqlite')
    opened = await openDatabase({ path: databasePath })
    templates = new ServerTemplateService(opened.db, () => Date.parse(at))
    actorId = randomUUID()
    await opened.db.insert(users).values({ id: actorId, username: 'template-admin', usernameKey: 'template-admin', displayName: 'Template Admin', role: 'administrator', passwordHash: 'fixture-only-password-hash', createdAt: at, updatedAt: at, passwordChangedAt: at })
  })

  afterEach(async () => {
    opened.native.close()
    await rm(directory, { recursive: true, force: true })
  })

  const input = (name = 'Weekend realm') => serverTemplateInputSchema.parse({ name, software: 'paper', version: '1.21.4', minMemoryMb: 2048, maxMemoryMb: 8192 })

  it('creates, lists, updates, duplicates and deletes only safe configuration fields', async () => {
    const created = templates.create(input(), actorId)
    expect(created).toMatchObject({ name: 'Weekend realm', software: 'paper', version: '1.21.4', minMemoryMb: 2048, maxMemoryMb: 8192 })
    expect(Object.keys(created).sort()).toEqual(['createdAt', 'id', 'maxMemoryMb', 'minMemoryMb', 'name', 'software', 'updatedAt', 'version'])
    const copy = templates.duplicate(created.id, actorId)
    expect(copy).toMatchObject({ name: 'Weekend realm copy', version: created.version, minMemoryMb: created.minMemoryMb })
    const renamed = templates.update(copy.id, input('Night build'), actorId)
    expect(renamed.name).toBe('Night build')
    expect(templates.list().map((item) => item.name)).toEqual(['Night build', 'Weekend realm'])
    templates.delete(created.id, actorId)
    expect(templates.list().map((item) => item.id)).toEqual([copy.id])
    expect(new ActivityFeedService(opened.db).list({ category: 'system', limit: 10 }, 'member').events.map((item) => item.title)).toEqual([
      'Server template deleted', 'Server template updated', 'Server template created', 'Server template created',
    ])
  })

  it('enforces unique names case-insensitively and rejects unsafe fields', () => {
    templates.create(input('Main world'), actorId)
    expect(() => templates.create(input('main WORLD'), actorId)).toThrow(ServerTemplateError)
    expect(() => serverTemplateInputSchema.parse({ ...input(), path: '/private/world', onlineMode: false, javaPath: '/usr/bin/java', eulaAccepted: true })).toThrow()
    expect(() => serverTemplateInputSchema.parse({ ...input(), maxMemoryMb: 256 })).toThrow()
  })

  it('keeps saved templates after reopening the temporary database', async () => {
    const created = templates.create(input(), actorId)
    opened.native.close()
    opened = await openDatabase({ path: databasePath })
    templates = new ServerTemplateService(opened.db, () => Date.parse(at))
    expect(templates.get(created.id)).toMatchObject({ id: created.id, name: 'Weekend realm' })
  })

  it.each(['forge', 'neoforge'] as const)('stores %s as a distinct server-software template across edits and duplication', (software) => {
    const nativeInput = (name: string) => serverTemplateInputSchema.parse({ name, software, version: software === 'forge' ? '1.20.1' : '1.21.1', minMemoryMb: 1024, maxMemoryMb: 4096 })
    const created = templates.create(nativeInput(`${software} template`), actorId)
    expect(created).toMatchObject({ software, version: software === 'forge' ? '1.20.1' : '1.21.1' })
    const duplicate = templates.duplicate(created.id, actorId)
    expect(duplicate.software).toBe(software)
    expect(templates.update(duplicate.id, nativeInput(`${software} updated`), actorId).software).toBe(software)
  })
})
