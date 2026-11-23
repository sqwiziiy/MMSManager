import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { localServers, localServerResourceSamples, localServerSessions, localServerStructuredEvents } from '../db/schema.js'
import { openDatabase } from '../db/client.js'
import {
  finishServerSession, parseOwnedServerLogLine, recordServerResourceSample, recordStructuredServerEvent,
  ServerHistoryService, startServerSession,
} from './history.js'

describe('managed server history', () => {
  let temp: string
  let opened: Awaited<ReturnType<typeof openDatabase>>
  let serverId: string

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'mmsmanager-history-'))
    opened = await openDatabase({ path: join(temp, 'state.sqlite') })
    serverId = randomUUID()
    const at = '2026-03-01T00:00:00.000Z'
    await opened.db.insert(localServers).values({
      id: serverId, name: 'History Fixture', directory: join(temp, 'servers', 'history'), source: 'created',
      software: 'vanilla', version: '1.21.4', jarName: 'server.jar', javaPath: null, javaMajor: 21,
      minMemoryMb: 512, maxMemoryMb: 2048, port: 25565, eula: 'accepted', managed: true,
      worldFolders: '[]', createdBy: null, createdAt: at, updatedAt: at,
    }).run()
  })

  afterEach(async () => {
    opened.native.close()
    await rm(temp, { recursive: true, force: true })
  })

  it('parses only recognized readiness, lifecycle, player and moderation lines', () => {
    expect(parseOwnedServerLogLine('[12:34:56] [Server thread/INFO]: Done (1.2s)! For help, type "help"')).toMatchObject({ eventType: 'server_ready', confidence: 'high' })
    expect(parseOwnedServerLogLine('[Server thread/INFO]: MiraWoods joined the game')).toMatchObject({ category: 'player', eventType: 'player_joined' })
    expect(parseOwnedServerLogLine('[Server thread/INFO]: Kicked Alex_123 from the game: test')).toMatchObject({ category: 'moderation', eventType: 'player_kicked' })
    expect(parseOwnedServerLogLine('Stopping server.')).toMatchObject({ eventType: 'server_shutdown_started', confidence: 'medium' })
    expect(parseOwnedServerLogLine('[Server thread/INFO]: player-name joined the game')).toBeNull()
    expect(parseOwnedServerLogLine('[Server thread/INFO]: unrelated or malformed output')).toBeNull()
    expect(parseOwnedServerLogLine('')).toBeNull()
  })

  it('upserts one resource sample per UTC minute and keeps independent measurements', () => {
    const now = () => Date.parse('2026-03-29T01:00:00.000Z')
    recordServerResourceSample(opened.db, serverId, '2026-03-29T00:05:00.000Z', { cpuPercent: 18.5, memoryRssBytes: 1024, uptimeSeconds: 180 }, now)
    recordServerResourceSample(opened.db, serverId, '2026-03-29T00:05:40.000Z', { playersOnline: 3, playersMax: 20 }, now)
    const rows = opened.db.select().from(localServerResourceSamples).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ cpuPercent: 18.5, memoryRssBytes: 1024, playersOnline: 3, playersMax: 20, uptimeSeconds: 180 })
  })

  it('closes sessions with measured duration and preserves a single active session', () => {
    const id = randomUUID()
    expect(startServerSession(opened.db, serverId, '2026-03-29T00:00:00.000Z', id)).toBe(id)
    expect(startServerSession(opened.db, serverId, '2026-03-29T00:01:00.000Z', randomUUID())).toBe(id)
    finishServerSession(opened.db, serverId, '2026-03-29T00:10:30.000Z', 'stopped')
    expect(opened.db.select().from(localServerSessions).all()).toEqual([expect.objectContaining({
      id, outcome: 'stopped', endedAt: '2026-03-29T00:10:30.000Z', uptimeSeconds: 630,
    })])
  })

  it('expires completed uptime sessions beyond the two-year retention window', () => {
    opened.db.insert(localServerSessions).values({
      id: randomUUID(), serverId, startedAt: '2023-12-31T23:00:00.000Z', endedAt: '2024-01-01T01:00:00.000Z',
      outcome: 'stopped', uptimeSeconds: 7200,
    }).run()
    startServerSession(opened.db, serverId, '2026-03-29T00:00:00.000Z', randomUUID())
    finishServerSession(opened.db, serverId, '2026-03-29T00:10:00.000Z', 'stopped')
    expect(opened.db.select().from(localServerSessions).where(eq(localServerSessions.serverId, serverId)).all()).toHaveLength(1)
  })

  it('aggregates real samples, events and uptime over a 23-hour local DST day', () => {
    const now = () => Date.parse('2026-04-02T00:00:00.000Z')
    recordServerResourceSample(opened.db, serverId, '2026-03-29T00:05:00.000Z', { cpuPercent: 4, memoryRssBytes: 1000, playersOnline: 2, playersMax: 20, uptimeSeconds: 100 }, now)
    recordServerResourceSample(opened.db, serverId, '2026-03-29T21:55:00.000Z', { cpuPercent: 8, memoryRssBytes: 2000, playersOnline: 5, playersMax: 20, uptimeSeconds: 82_000 }, now)
    recordStructuredServerEvent(opened.db, {
      serverId, occurredAt: '2026-03-29T10:00:00.000Z', category: 'player', eventType: 'player_joined',
      description: 'MiraWoods joined the server.', rawMessage: '[Server thread/INFO]: MiraWoods joined the game', confidence: 'high', source: 'owned-log',
    }, () => Date.parse('2026-04-02T00:00:00.000Z'))
    startServerSession(opened.db, serverId, '2026-03-28T22:00:00.000Z', randomUUID())
    finishServerSession(opened.db, serverId, '2026-03-30T00:00:00.000Z', 'stopped')

    const history = new ServerHistoryService(opened.db, 'Europe/Paris', () => Date.parse('2026-04-02T00:00:00.000Z'))
    const day = history.getDay(serverId, '2026-03-29')
    expect(day.window.durationMs).toBe(23 * 60 * 60 * 1000)
    expect(day.status).toBe('partial')
    expect(day.summary).toMatchObject({ sampleCount: 2, cpuAveragePercent: 6, cpuMaximumPercent: 8, memoryPeakBytes: 2000, playersPeak: 5, uptimeSeconds: 82_800, sessionCount: 1 })
    expect(day.points).toHaveLength(2)
    expect(day.events).toMatchObject([{ eventType: 'player_joined', rawMessage: expect.stringContaining('joined the game') }])
    expect(day.sessions[0]?.durationInDaySeconds).toBe(82_800)
    expect(history.getCalendar(serverId, 2026, 3).days.find((entry) => entry.date === '2026-03-29')).toMatchObject({ status: 'partial', sampleCount: 2, eventCount: 1 })
    expect(history.getDay(serverId, '2026-03-30')).toMatchObject({ status: 'no-data', summary: null, points: [], events: [] })
  })

  it('restricts all-server aggregates to managed created servers and expires stale records', () => {
    const importedId = randomUUID()
    const at = '2025-01-01T00:00:00.000Z'
    opened.db.insert(localServers).values({
      id: importedId, name: 'Imported Fixture', directory: join(temp, 'imported'), source: 'imported', software: 'unknown',
      version: null, jarName: null, javaPath: null, javaMajor: null, minMemoryMb: 512, maxMemoryMb: 1024,
      port: null, eula: 'unknown', managed: false, worldFolders: '[]', createdBy: null, createdAt: at, updatedAt: at,
    }).run()
    recordStructuredServerEvent(opened.db, { serverId, occurredAt: at, category: 'server', eventType: 'old', description: 'old', confidence: 'medium', source: 'panel-process' }, () => Date.parse('2026-04-01T00:00:00.000Z'))
    recordServerResourceSample(opened.db, serverId, at, { cpuPercent: 1 }, () => Date.parse('2026-04-01T00:00:00.000Z'))
    expect(opened.db.select().from(localServerStructuredEvents).all()).toHaveLength(0)
    expect(opened.db.select().from(localServerResourceSamples).all()).toHaveLength(0)
    const history = new ServerHistoryService(opened.db, 'Europe/Paris', () => Date.parse('2026-04-01T00:00:00.000Z'))
    expect(history.getCalendar('all', 2026, 3).days.every((entry) => entry.sampleCount === 0)).toBe(true)
    expect(() => history.getCalendar(importedId, 2026, 3)).toThrow(/panel-managed/)
  })
})
