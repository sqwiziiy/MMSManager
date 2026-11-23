import { and, asc, avg, count, countDistinct, desc, eq, gte, inArray, isNotNull, isNull, lt, max, min, or, sql } from 'drizzle-orm'
import type { AppDatabase } from '../db/client.js'
import { localServerResourceSamples, localServers, localServerSessions, localServerStructuredEvents } from '../db/schema.js'
import { dateInTimeZone, localDayWindow, validateCalendarDate, utcMinuteBucket } from '../time.js'
import type { ServerHistoryCalendar, ServerHistoryDay, ServerHistoryEvent, ServerHistoryScope, ServerHistorySession } from '@mmsmanager/shared'

const MAX_STRUCTURED_EVENTS_PER_SERVER = 20_000
const STRUCTURED_EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000
const MAX_RESOURCE_SAMPLES_PER_SERVER = 45_000
const RESOURCE_SAMPLE_RETENTION_MS = 31 * 24 * 60 * 60 * 1000
const MAX_SESSIONS_PER_SERVER = 10_000
const SESSION_RETENTION_MS = 730 * 24 * 60 * 60 * 1000
const MAX_DAY_EVENTS = 500
const MAX_DAY_SESSIONS = 200
const MAX_DAY_POINTS = 3000
const MINUTE_MS = 60_000

export type StructuredEventInput = {
  serverId: string
  consoleEntryId?: number | null
  occurredAt: string
  category: 'server' | 'player' | 'moderation'
  eventType: string
  description: string
  rawMessage?: string | null
  confidence: 'high' | 'medium'
  source: 'owned-log' | 'panel-process'
}

export type OwnedLogEvent = Omit<StructuredEventInput, 'serverId' | 'consoleEntryId' | 'occurredAt' | 'rawMessage' | 'source'>

export function parseOwnedServerLogLine(raw: string): OwnedLogEvent | null {
  const line = raw
    .replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '')
    .replace(/^\[[^\]]{1,128}\]:\s*/, '')
    .trim()
  if (/^Done \([^)]{1,80}\)! For help, type ["']help["']\.?$/.test(line)) {
    return { category: 'server', eventType: 'server_ready', description: 'The server reported that it is ready.', confidence: 'high' }
  }
  if (/^Stopping server\.?$/.test(line)) {
    return { category: 'server', eventType: 'server_shutdown_started', description: 'The server log reported that shutdown started.', confidence: 'medium' }
  }
  if (/^Restarting server\.?$/.test(line)) {
    return { category: 'server', eventType: 'server_restart_started', description: 'The server log reported that a restart started.', confidence: 'medium' }
  }
  let match = /^([A-Za-z0-9_]{3,16}) joined the game\.?$/.exec(line)
  if (match) return { category: 'player', eventType: 'player_joined', description: match[1] + ' joined the server.', confidence: 'high' }
  match = /^([A-Za-z0-9_]{3,16}) left the game\.?$/.exec(line)
  if (match) return { category: 'player', eventType: 'player_left', description: match[1] + ' left the server.', confidence: 'high' }
  const moderation: Array<[RegExp, string, string]> = [
    [/^Kicked ([A-Za-z0-9_]{3,16}) from the game(?::|\s|$)/i, 'player_kicked', 'was kicked'],
    [/^Banned (?:player )?([A-Za-z0-9_]{3,16})(?:\s|$)/i, 'player_banned', 'was banned'],
    [/^Pardoned player ([A-Za-z0-9_]{3,16})(?:\s|$)/i, 'player_pardoned', 'was pardoned'],
    [/^Made ([A-Za-z0-9_]{3,16}) a server operator(?:\s|$)/i, 'player_operator_added', 'was made a server operator'],
    [/^Made ([A-Za-z0-9_]{3,16}) no longer a server operator(?:\s|$)/i, 'player_operator_removed', 'was removed as a server operator'],
    [/^Added ([A-Za-z0-9_]{3,16}) to the whitelist(?:\s|$)/i, 'player_whitelisted', 'was added to the whitelist'],
    [/^Removed ([A-Za-z0-9_]{3,16}) from the whitelist(?:\s|$)/i, 'player_unwhitelisted', 'was removed from the whitelist'],
  ]
  for (const [pattern, eventType, action] of moderation) {
    match = pattern.exec(line)
    if (match) return { category: 'moderation', eventType, description: match[1] + ' ' + action + '.', confidence: 'high' }
  }
  return null
}

export function recordStructuredServerEvent(db: AppDatabase, input: StructuredEventInput, now = Date.now): number {
  const result = db.insert(localServerStructuredEvents).values({
    serverId: input.serverId,
    consoleEntryId: input.consoleEntryId ?? null,
    occurredAt: input.occurredAt,
    category: input.category,
    eventType: input.eventType,
    description: input.description.slice(0, 300),
    rawMessage: input.rawMessage === undefined || input.rawMessage === null ? null : input.rawMessage.slice(0, 8192),
    confidence: input.confidence,
    source: input.source,
  }).run()
  const cutoff = new Date(now() - STRUCTURED_EVENT_RETENTION_MS).toISOString()
  db.delete(localServerStructuredEvents).where(and(eq(localServerStructuredEvents.serverId, input.serverId), lt(localServerStructuredEvents.occurredAt, cutoff))).run()
  const oldest = db.select({ id: localServerStructuredEvents.id }).from(localServerStructuredEvents)
    .where(eq(localServerStructuredEvents.serverId, input.serverId)).orderBy(desc(localServerStructuredEvents.id))
    .limit(1).offset(MAX_STRUCTURED_EVENTS_PER_SERVER - 1).get()
  if (oldest) db.delete(localServerStructuredEvents).where(and(eq(localServerStructuredEvents.serverId, input.serverId), lt(localServerStructuredEvents.id, oldest.id))).run()
  return Number(result.lastInsertRowid)
}

export function startServerSession(db: AppDatabase, serverId: string, startedAt: string, id: string): string {
  const active = db.select({ id: localServerSessions.id }).from(localServerSessions)
    .where(and(eq(localServerSessions.serverId, serverId), isNull(localServerSessions.endedAt))).get()
  if (active) return active.id
  db.insert(localServerSessions).values({ id, serverId, startedAt, endedAt: null, outcome: 'running', uptimeSeconds: null }).run()
  return id
}

export function finishServerSession(db: AppDatabase, serverId: string, endedAt: string, outcome: 'stopped' | 'crashed' | 'interrupted'): void {
  const active = db.select().from(localServerSessions)
    .where(and(eq(localServerSessions.serverId, serverId), isNull(localServerSessions.endedAt))).get()
  if (!active) return
  const uptimeSeconds = Math.max(0, Math.floor((Date.parse(endedAt) - Date.parse(active.startedAt)) / 1000))
  db.update(localServerSessions).set({ endedAt, outcome, uptimeSeconds }).where(eq(localServerSessions.id, active.id)).run()
  const cutoff = new Date(Date.parse(endedAt) - SESSION_RETENTION_MS).toISOString()
  db.delete(localServerSessions).where(and(eq(localServerSessions.serverId, serverId), isNotNull(localServerSessions.endedAt), lt(localServerSessions.endedAt, cutoff))).run()
  const oldest = db.select({ endedAt: localServerSessions.endedAt }).from(localServerSessions)
    .where(and(eq(localServerSessions.serverId, serverId), isNotNull(localServerSessions.endedAt)))
    .orderBy(desc(localServerSessions.endedAt)).limit(1).offset(MAX_SESSIONS_PER_SERVER - 1).get()
  if (oldest?.endedAt) db.delete(localServerSessions).where(and(
    eq(localServerSessions.serverId, serverId), isNotNull(localServerSessions.endedAt), lt(localServerSessions.endedAt, oldest.endedAt),
  )).run()
}

export function recordServerResourceSample(db: AppDatabase, serverId: string, sampledAt: string, values: {
  cpuPercent?: number | null
  memoryRssBytes?: number | null
  playersOnline?: number | null
  playersMax?: number | null
  uptimeSeconds?: number | null
}, now = Date.now): void {
  const minuteStart = utcMinuteBucket(sampledAt)
  const fields = {
    ...(values.cpuPercent == null ? {} : { cpuPercent: values.cpuPercent }),
    ...(values.memoryRssBytes == null ? {} : { memoryRssBytes: Math.floor(values.memoryRssBytes) }),
    ...(values.playersOnline == null ? {} : { playersOnline: values.playersOnline }),
    ...(values.playersMax == null ? {} : { playersMax: values.playersMax }),
    ...(values.uptimeSeconds == null ? {} : { uptimeSeconds: Math.max(0, Math.floor(values.uptimeSeconds)) }),
  }
  if (Object.keys(fields).length === 0) return
  db.insert(localServerResourceSamples).values({
    serverId, minuteStart, sampledAt,
    cpuPercent: fields.cpuPercent ?? null,
    memoryRssBytes: fields.memoryRssBytes ?? null,
    playersOnline: fields.playersOnline ?? null,
    playersMax: fields.playersMax ?? null,
    uptimeSeconds: fields.uptimeSeconds ?? null,
  }).onConflictDoUpdate({
    target: [localServerResourceSamples.serverId, localServerResourceSamples.minuteStart],
    set: { sampledAt, ...fields },
  }).run()
  const cutoff = new Date(now() - RESOURCE_SAMPLE_RETENTION_MS).toISOString()
  db.delete(localServerResourceSamples).where(and(eq(localServerResourceSamples.serverId, serverId), lt(localServerResourceSamples.minuteStart, cutoff))).run()
  const oldest = db.select({ id: localServerResourceSamples.id }).from(localServerResourceSamples)
    .where(eq(localServerResourceSamples.serverId, serverId)).orderBy(desc(localServerResourceSamples.minuteStart))
    .limit(1).offset(MAX_RESOURCE_SAMPLES_PER_SERVER - 1).get()
  if (oldest) db.delete(localServerResourceSamples).where(and(eq(localServerResourceSamples.serverId, serverId), lt(localServerResourceSamples.id, oldest.id))).run()
}

function scopeWhere(scope: ServerHistoryScope, serverIds: string[]) {
  if (scope !== 'all') return eq(localServerResourceSamples.serverId, scope)
  return serverIds.length ? inArray(localServerResourceSamples.serverId, serverIds) : eq(localServerResourceSamples.serverId, '')
}
function eventScopeWhere(scope: ServerHistoryScope, serverIds: string[]) {
  if (scope !== 'all') return eq(localServerStructuredEvents.serverId, scope)
  return serverIds.length ? inArray(localServerStructuredEvents.serverId, serverIds) : eq(localServerStructuredEvents.serverId, '')
}
function sessionScopeWhere(scope: ServerHistoryScope, serverIds: string[]) {
  if (scope !== 'all') return eq(localServerSessions.serverId, scope)
  return serverIds.length ? inArray(localServerSessions.serverId, serverIds) : eq(localServerSessions.serverId, '')
}
function expectedMinutes(durationMs: number): number { return Math.max(1, Math.floor(durationMs / MINUTE_MS)) }
function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
function dayStatus(date: string, sampleCount: number, ratio: number, timeZone: string, now: number): ServerHistoryDay['status'] {
  if (date > dateInTimeZone(now, timeZone)) return 'future'
  if (sampleCount === 0) return 'no-data'
  return ratio >= 0.8 ? 'observed' : 'partial'
}

export class ServerHistoryService {
  constructor(private readonly db: AppDatabase, readonly timeZone: string, private readonly now: () => number = Date.now) {}

  getCalendar(scope: ServerHistoryScope, year: number, month: number): ServerHistoryCalendar {
    const servers = this.registeredServerIds(scope)
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const days: ServerHistoryCalendar['days'] = []
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = year.toString().padStart(4, '0') + '-' + month.toString().padStart(2, '0') + '-' + day.toString().padStart(2, '0')
      const window = localDayWindow(date, this.timeZone)
      const aggregate = this.db.select({
        sampleCount: count(localServerResourceSamples.id),
        coveredMinutes: countDistinct(localServerResourceSamples.minuteStart),
        firstSampleAt: min(localServerResourceSamples.sampledAt),
        lastSampleAt: max(localServerResourceSamples.sampledAt),
      }).from(localServerResourceSamples).where(and(
        scopeWhere(scope, servers), gte(localServerResourceSamples.minuteStart, window.from), lt(localServerResourceSamples.minuteStart, window.to),
      )).get()
      const eventAggregate = this.db.select({ eventCount: count(localServerStructuredEvents.id) }).from(localServerStructuredEvents)
        .where(and(eventScopeWhere(scope, servers), gte(localServerStructuredEvents.occurredAt, window.from), lt(localServerStructuredEvents.occurredAt, window.to))).get()
      const sampleCount = aggregate?.sampleCount ?? 0
      const expected = expectedMinutes(window.durationMs)
      const coveragePercent = Math.min(100, ((aggregate?.coveredMinutes ?? 0) / expected) * 100)
      days.push({
        date,
        status: dayStatus(date, sampleCount, coveragePercent / 100, this.timeZone, this.now()),
        sampleCount,
        eventCount: eventAggregate?.eventCount ?? 0,
        firstSampleAt: aggregate?.firstSampleAt ?? null,
        lastSampleAt: aggregate?.lastSampleAt ?? null,
        coveragePercent,
      })
    }
    return { scope, year, month, timeZone: this.timeZone, days }
  }

  getDay(scope: ServerHistoryScope, date: string): ServerHistoryDay {
    validateCalendarDate(date)
    const window = localDayWindow(date, this.timeZone)
    const servers = this.registeredServerIds(scope)
    const aggregate = this.db.select({
      sampleCount: count(localServerResourceSamples.id),
      coveredMinutes: countDistinct(localServerResourceSamples.minuteStart),
      firstSampleAt: min(localServerResourceSamples.sampledAt),
      lastSampleAt: max(localServerResourceSamples.sampledAt),
      cpuAveragePercent: avg(localServerResourceSamples.cpuPercent),
      cpuMaximumPercent: max(localServerResourceSamples.cpuPercent),
      memoryPeakBytes: max(localServerResourceSamples.memoryRssBytes),
      playersPeak: max(localServerResourceSamples.playersOnline),
    }).from(localServerResourceSamples).where(and(
      scopeWhere(scope, servers), gte(localServerResourceSamples.minuteStart, window.from), lt(localServerResourceSamples.minuteStart, window.to),
    )).get()
    const sampleCount = aggregate?.sampleCount ?? 0
    const expected = expectedMinutes(window.durationMs)
    const coveragePercent = Math.min(100, ((aggregate?.coveredMinutes ?? 0) / expected) * 100)
    const status = dayStatus(date, sampleCount, coveragePercent / 100, this.timeZone, this.now())
    const future = status === 'future'
    const pointRows = future ? [] : this.db.select({
      minuteStart: localServerResourceSamples.minuteStart,
      sampleCount: count(localServerResourceSamples.id),
      serverCount: countDistinct(localServerResourceSamples.serverId),
      cpuAveragePercent: avg(localServerResourceSamples.cpuPercent),
      memoryPeakBytes: max(localServerResourceSamples.memoryRssBytes),
      playersPeak: max(localServerResourceSamples.playersOnline),
      uptimePeakSeconds: max(localServerResourceSamples.uptimeSeconds),
    }).from(localServerResourceSamples).where(and(
      scopeWhere(scope, servers), gte(localServerResourceSamples.minuteStart, window.from), lt(localServerResourceSamples.minuteStart, window.to),
    )).groupBy(localServerResourceSamples.minuteStart).orderBy(asc(localServerResourceSamples.minuteStart)).limit(MAX_DAY_POINTS).all()
    const points = pointRows.map((row) => ({
      observedAt: row.minuteStart,
      sampleCount: row.sampleCount,
      serverCount: row.serverCount,
      cpuAveragePercent: numberOrNull(row.cpuAveragePercent),
      memoryPeakBytes: row.memoryPeakBytes,
      playersPeak: row.playersPeak,
      uptimePeakSeconds: row.uptimePeakSeconds,
    }))
    const eventWhere = and(eventScopeWhere(scope, servers), gte(localServerStructuredEvents.occurredAt, window.from), lt(localServerStructuredEvents.occurredAt, window.to))
    const eventCount = future ? 0 : this.db.select({ total: count(localServerStructuredEvents.id) }).from(localServerStructuredEvents).where(eventWhere).get()?.total ?? 0
    const eventRows = future ? [] : this.db.select({
      id: localServerStructuredEvents.id,
      serverId: localServerStructuredEvents.serverId,
      serverName: localServers.name,
      occurredAt: localServerStructuredEvents.occurredAt,
      category: localServerStructuredEvents.category,
      eventType: localServerStructuredEvents.eventType,
      description: localServerStructuredEvents.description,
      rawMessage: localServerStructuredEvents.rawMessage,
      confidence: localServerStructuredEvents.confidence,
      source: localServerStructuredEvents.source,
    }).from(localServerStructuredEvents).innerJoin(localServers, eq(localServers.id, localServerStructuredEvents.serverId)).where(eventWhere)
      .orderBy(asc(localServerStructuredEvents.occurredAt)).limit(MAX_DAY_EVENTS).all().map((row) => ({
      ...row,
      category: row.category as ServerHistoryEvent['category'],
      confidence: row.confidence as ServerHistoryEvent['confidence'],
      source: row.source as ServerHistoryEvent['source'],
    }))
    const nowIso = new Date(this.now()).toISOString()
    const sessionWhere = and(sessionScopeWhere(scope, servers), lt(localServerSessions.startedAt, window.to),
      or(isNull(localServerSessions.endedAt), gte(localServerSessions.endedAt, window.from)))
    const sessionAggregate = future ? null : this.db.select({
      sessionCount: count(localServerSessions.id),
      uptimeSeconds: sql<number>`coalesce(sum(CASE WHEN min(coalesce(${localServerSessions.endedAt}, ${nowIso}), ${window.to}) <= max(${localServerSessions.startedAt}, ${window.from}) THEN 0 ELSE round((julianday(min(coalesce(${localServerSessions.endedAt}, ${nowIso}), ${window.to})) - julianday(max(${localServerSessions.startedAt}, ${window.from}))) * 86400) END), 0)`,
    }).from(localServerSessions).where(sessionWhere).get()
    const sessionRows = future ? [] : this.db.select({
      id: localServerSessions.id,
      serverId: localServerSessions.serverId,
      serverName: localServers.name,
      startedAt: localServerSessions.startedAt,
      endedAt: localServerSessions.endedAt,
      outcome: localServerSessions.outcome,
      uptimeSeconds: localServerSessions.uptimeSeconds,
    }).from(localServerSessions).innerJoin(localServers, eq(localServers.id, localServerSessions.serverId)).where(sessionWhere)
      .orderBy(asc(localServerSessions.startedAt)).limit(MAX_DAY_SESSIONS).all()
    const sessions: ServerHistorySession[] = sessionRows.map((row) => {
      const start = Math.max(Date.parse(row.startedAt), Date.parse(window.from))
      const end = Math.min(Date.parse(row.endedAt ?? nowIso), Date.parse(window.to))
      return {
        ...row,
        outcome: row.outcome as ServerHistorySession['outcome'],
        durationInDaySeconds: Math.max(0, Math.floor((end - start) / 1000)),
      }
    })
    const summary = future || sampleCount === 0 ? null : {
      sampleCount,
      firstSampleAt: aggregate?.firstSampleAt ?? null,
      lastSampleAt: aggregate?.lastSampleAt ?? null,
      coveragePercent,
      cpuAveragePercent: numberOrNull(aggregate?.cpuAveragePercent),
      cpuMaximumPercent: aggregate?.cpuMaximumPercent ?? null,
      memoryPeakBytes: aggregate?.memoryPeakBytes ?? null,
      playersPeak: aggregate?.playersPeak ?? null,
      uptimeSeconds: Math.max(0, Math.floor(sessionAggregate?.uptimeSeconds ?? 0)),
      sessionCount: sessionAggregate?.sessionCount ?? 0,
    }
    return {
      scope,
      date,
      timeZone: this.timeZone,
      status,
      summary,
      points,
      events: eventRows as ServerHistoryEvent[],
      eventsTruncated: eventCount > MAX_DAY_EVENTS,
      sessions,
      sessionsTruncated: (sessionAggregate?.sessionCount ?? 0) > MAX_DAY_SESSIONS,
      window,
    }
  }

  private registeredServerIds(scope: ServerHistoryScope): string[] {
    const conditions = [eq(localServers.source, 'created'), eq(localServers.managed, true)]
    if (scope !== 'all') conditions.push(eq(localServers.id, scope))
    const rows = this.db.select({ id: localServers.id }).from(localServers).where(and(...conditions)).all()
    if (scope !== 'all' && rows.length === 0) throw new RangeError('Server history is available only for a panel-managed server.')
    return rows.map((row) => row.id)
  }
}
