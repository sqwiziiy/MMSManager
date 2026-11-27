import { randomUUID } from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import type { ServerTemplate, ServerTemplateInput } from '@mmsmanager/shared'
import type { AppDatabase } from '../db/client.js'
import { localServerEvents, serverTemplates } from '../db/schema.js'

export class ServerTemplateError extends Error {
  constructor(readonly code: 'TEMPLATE_NOT_FOUND' | 'TEMPLATE_NAME_CONFLICT', message: string) { super(message) }
}

export class ServerTemplateService {
  constructor(private readonly db: AppDatabase, private readonly now: () => number = Date.now) {}

  list(): ServerTemplate[] {
    return this.db.select().from(serverTemplates).orderBy(asc(serverTemplates.name)).all().map((row) => this.toPublic(row))
  }

  get(templateId: string): ServerTemplate | null {
    const row = this.db.select().from(serverTemplates).where(eq(serverTemplates.id, templateId)).get()
    return row ? this.toPublic(row) : null
  }

  create(input: ServerTemplateInput, actorUserId: string): ServerTemplate {
    const id = randomUUID()
    const at = new Date(this.now()).toISOString()
    try {
      this.db.transaction((tx) => {
        tx.insert(serverTemplates).values({
          id, name: input.name,
          software: input.software === 'forge' || input.software === 'neoforge' ? 'vanilla' : input.software,
          loader: input.software === 'forge' || input.software === 'neoforge' ? input.software : null,
          version: input.version, minMemoryMb: input.minMemoryMb, maxMemoryMb: input.maxMemoryMb,
          createdBy: actorUserId, updatedBy: actorUserId, createdAt: at, updatedAt: at,
        }).run()
        tx.insert(localServerEvents).values({ serverId: null, actorUserId, action: 'workspace-template-created', outcome: 'success', occurredAt: at, detail: '{}' }).run()
      })
    } catch (error) {
      if (this.isUniqueConflict(error)) throw new ServerTemplateError('TEMPLATE_NAME_CONFLICT', 'A template with that name already exists.')
      throw error
    }
    return this.get(id)!
  }

  update(templateId: string, input: ServerTemplateInput, actorUserId: string): ServerTemplate {
    const previous = this.get(templateId)
    if (!previous) throw new ServerTemplateError('TEMPLATE_NOT_FOUND', 'The server template was not found.')
    const at = new Date(this.now()).toISOString()
    try {
      this.db.transaction((tx) => {
        tx.update(serverTemplates).set({
          name: input.name,
          software: input.software === 'forge' || input.software === 'neoforge' ? 'vanilla' : input.software,
          loader: input.software === 'forge' || input.software === 'neoforge' ? input.software : null,
          version: input.version, minMemoryMb: input.minMemoryMb, maxMemoryMb: input.maxMemoryMb,
          updatedBy: actorUserId, updatedAt: at,
        }).where(eq(serverTemplates.id, templateId)).run()
        tx.insert(localServerEvents).values({ serverId: null, actorUserId, action: 'workspace-template-updated', outcome: 'success', occurredAt: at, detail: '{}' }).run()
      })
    } catch (error) {
      if (this.isUniqueConflict(error)) throw new ServerTemplateError('TEMPLATE_NAME_CONFLICT', 'A template with that name already exists.')
      throw error
    }
    return this.get(templateId)!
  }

  duplicate(templateId: string, actorUserId: string): ServerTemplate {
    const source = this.get(templateId)
    if (!source) throw new ServerTemplateError('TEMPLATE_NOT_FOUND', 'The server template was not found.')
    const base = `${source.name.slice(0, 52).trim()} copy`
    for (let suffix = 1; suffix <= 99; suffix += 1) {
      const name = suffix === 1 ? base : `${source.name.slice(0, 57 - String(suffix).length).trim()} ${suffix}`
      if (this.db.select({ id: serverTemplates.id }).from(serverTemplates).where(sql`lower(${serverTemplates.name}) = lower(${name})`).get()) continue
      try {
        return this.create({ name, software: source.software, version: source.version, minMemoryMb: source.minMemoryMb, maxMemoryMb: source.maxMemoryMb }, actorUserId)
      } catch (error) {
        if (!(error instanceof ServerTemplateError) || error.code !== 'TEMPLATE_NAME_CONFLICT') throw error
      }
    }
    throw new ServerTemplateError('TEMPLATE_NAME_CONFLICT', 'A unique copy name could not be created. Rename an existing template and try again.')
  }

  delete(templateId: string, actorUserId: string): void {
    if (!this.get(templateId)) throw new ServerTemplateError('TEMPLATE_NOT_FOUND', 'The server template was not found.')
    const at = new Date(this.now()).toISOString()
    this.db.transaction((tx) => {
      tx.insert(localServerEvents).values({ serverId: null, actorUserId, action: 'workspace-template-deleted', outcome: 'success', occurredAt: at, detail: '{}' }).run()
      tx.delete(serverTemplates).where(eq(serverTemplates.id, templateId)).run()
    })
  }

  private isUniqueConflict(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT')
  }

  private toPublic(row: typeof serverTemplates.$inferSelect): ServerTemplate {
    return { id: row.id, name: row.name, software: row.loader ?? row.software, version: row.version, minMemoryMb: row.minMemoryMb, maxMemoryMb: row.maxMemoryMb, createdAt: row.createdAt, updatedAt: row.updatedAt }
  }
}
