import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, CalendarDays, ChevronLeft, ChevronRight, Clock3, Cpu, HardDrive, MemoryStick, RefreshCw, Wifi } from 'lucide-react'
import type { LocalServerSummary, MachineCalendar, MachineDay, ServerHistoryCalendar, ServerHistoryDay, ServerHistoryScope } from '@mmsmanager/shared'
import { Badge, Button, Card, PageHeading, SectionHeading } from '../components/ui'
import { LiveResourceChart, CalendarMonthHeading } from '../components/live-chart'
import { currentLocale, pluralCount, translateText } from '../i18n/catalog'
import { getMachineCalendar, getMachineDay, isRequestCancelled } from '../api/machine'
import { getLocalServers, getServerHistoryCalendar, getServerHistoryDay } from '../api/servers'
import { useMachineHistory, useMachineStatus } from '../state/use-machine-monitor'
import { useAuth } from '../state/use-auth'
import { formatBytes, formatConfiguredDate, formatPercent, formatTimestamp } from '../lib/format'

function weekdayLabels() {
  return Array.from({ length: 7 }, (_, index) => {
  const monday = new Date(Date.UTC(2024, 0, 1 + index, 12))
  return new Intl.DateTimeFormat(currentLocale(), { weekday: 'short', timeZone: 'UTC' }).format(monday)
  })
}

function todayInZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values['year']}-${values['month']}-${values['day']}`
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year!, month! - 1, day!))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
}

function monthKey(value: string | null): string | null {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null
  return value
}

function dateLabel(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return formatConfiguredDate(new Date(Date.UTC(year!, month! - 1, day!, 12)).toISOString(), timeZone, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
}

function shiftMonth(year: number, month: number, amount: number): { year: number; month: number; key: string } {
  const next = new Date(Date.UTC(year, month - 1 + amount, 1))
  const nextYear = next.getUTCFullYear()
  const nextMonth = next.getUTCMonth() + 1
  return { year: nextYear, month: nextMonth, key: `${nextYear}-${nextMonth.toString().padStart(2, '0')}` }
}

export function MachineHistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const [servers, setServers] = useState<LocalServerSummary[]>([])
  useEffect(() => {
    if (!isAdmin) { setServers([]); return }
    const controller = new AbortController()
    void getLocalServers(controller.signal).then(setServers).catch(() => setServers([]))
    return () => controller.abort()
  }, [isAdmin])
  const managedServers = servers.filter((server) => server.source === 'created' && server.managed)
  const requestedSource = searchParams.get('source') ?? 'local'
  const matchingServer = managedServers.find((server) => server.id === requestedSource)
  const source: 'local' | ServerHistoryScope = requestedSource === 'all' && isAdmin
    ? 'all'
    : isAdmin && matchingServer ? matchingServer.id : 'local'
  const selectedServer = source === 'local' || source === 'all' ? null : managedServers.find((server) => server.id === source) ?? null
  function changeSource(value: string) {
    const next = new URLSearchParams(searchParams)
    if (value === 'local') next.delete('source')
    else next.set('source', value)
    setSearchParams(next, { preventScrollReset: true })
  }
  const sourceFilter = <HistorySourceFilter value={source} servers={managedServers} isAdmin={isAdmin} onChange={changeSource} />
  if (source === 'local') return <LocalMachineHistoryPage sourceFilter={sourceFilter} />
  return <ServerHistoryPage sourceFilter={sourceFilter} scope={source} serverName={source === 'all' ? 'All managed servers' : selectedServer?.name ?? 'Managed server'} />
}

function LocalMachineHistoryPage({ sourceFilter }: { sourceFilter: ReactNode }) {
  const weekdays = weekdayLabels()
  const { history } = useMachineHistory()
  const { apiStatus, error, refreshNow } = useMachineStatus()
  const [searchParams, setSearchParams] = useSearchParams()
  const timeZone = history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = todayInZone(timeZone)
  const rawDate = searchParams.get('date')
  const explicitDateIsInvalid = rawDate !== null && !validDate(rawDate)
  const month = monthKey(searchParams.get('month')) ?? (validDate(rawDate) ? rawDate.slice(0, 7) : today.slice(0, 7))
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const selectedDate = validDate(rawDate) ? rawDate : searchParams.get('month') ? null : today
  const [calendar, setCalendar] = useState<MachineCalendar | null>(null)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [calendarLoading, setCalendarLoading] = useState(true)
  const [day, setDay] = useState<MachineDay | null>(null)
  const [dayError, setDayError] = useState<string | null>(null)
  const [dayLoading, setDayLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setCalendar(null)
    setCalendarError(null)
    setCalendarLoading(true)
    void getMachineCalendar(year, monthNumber, controller.signal)
      .then((result) => { setCalendar(result); setCalendarLoading(false) })
      .catch((error: unknown) => {
        if (!isRequestCancelled(error)) {
          setCalendarError('The local history calendar is unavailable.')
          setCalendarLoading(false)
        }
      })
    return () => controller.abort()
  }, [year, monthNumber, reloadKey])

  useEffect(() => {
    if (!selectedDate || explicitDateIsInvalid) {
      setDay(null)
      setDayError(null)
      setDayLoading(false)
      return
    }
    const controller = new AbortController()
    setDay(null)
    setDayError(null)
    setDayLoading(true)
    void getMachineDay(selectedDate, controller.signal)
      .then((result) => { setDay(result); setDayLoading(false) })
      .catch((error: unknown) => {
        if (!isRequestCancelled(error)) {
          setDayError('The selected day could not be loaded.')
          setDayLoading(false)
        }
      })
    return () => controller.abort()
  }, [selectedDate, explicitDateIsInvalid, reloadKey])

  const cells = useMemo(() => {
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
    const firstWeekday = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7
    return [...Array.from({ length: firstWeekday }, () => null), ...Array.from({ length: daysInMonth }, (_, index) => index + 1)]
  }, [year, monthNumber])
  const calendarDays = new Map(calendar?.days.map((item) => [item.date, item]) ?? [])

  function chooseDate(date: string) {
    const next = new URLSearchParams(searchParams)
    next.set('date', date)
    next.set('month', date.slice(0, 7))
    setSearchParams(next, { preventScrollReset: true })
  }

  function chooseMonth(nextMonth: { year: number; month: number; key: string }) {
    const next = new URLSearchParams(searchParams)
    next.delete('date')
    next.set('month', nextMonth.key)
    if (selectedDate?.startsWith(nextMonth.key)) next.set('date', selectedDate)
    setSearchParams(next, { preventScrollReset: true })
  }

  function goToday() {
    const next = new URLSearchParams(searchParams)
    next.set('month', today.slice(0, 7))
    next.set('date', today)
    setSearchParams(next, { preventScrollReset: true })
  }

  const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1))
  const statusText = translateText(day?.status === 'observed' ? 'Observed' : day?.status === 'partial' ? 'Partial day' : day?.status === 'future' ? 'Future date' : 'No data', currentLocale())

  return <div className="page-stack machine-history-page">
    <PageHeading eyebrow="Local machine · persisted history" title="Machine history" description="Browse real readings saved by this local backend. Dates follow the configured timezone." actions={<Badge tone={apiStatus === 'online' ? 'good' : 'warn'}><span data-no-translate>{timeZone}</span></Badge>} />
    {sourceFilter}

    {(calendarError || apiStatus === 'offline') && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Machine history is unavailable</strong><small>{calendarError ?? error ?? 'The local API is offline.'}</small></span><Button icon={RefreshCw} onClick={() => { refreshNow(); setCalendarError(null); setReloadKey((value) => value + 1) }}>Retry</Button></div>}
    {explicitDateIsInvalid && <div className="history-inline-error" role="alert">This history link contains an invalid calendar date.</div>}

    <div className="history-layout">
      <Card className="history-calendar-card">
        <div className="history-calendar-toolbar">
          <button className="icon-button" aria-label="Previous month" title="Previous month" onClick={() => chooseMonth(shiftMonth(year, monthNumber, -1))}><ChevronLeft size={18} /></button>
          <h2>{CalendarMonthHeading({ year, month: monthNumber, timeZone })}</h2>
          <button className="icon-button" aria-label="Next month" title="Next month" onClick={() => chooseMonth(shiftMonth(year, monthNumber, 1))}><ChevronRight size={18} /></button>
          <Button kind="quiet" icon={CalendarDays} onClick={goToday}>Today</Button>
        </div>
        {calendarLoading && <div className="calendar-loading" role="status">Loading saved readings for this month…</div>}
        {calendarError && <div className="history-inline-error" role="alert">The local history calendar could not be loaded.</div>}
        <div className="machine-calendar-grid" role="grid" aria-label={translateText(`${CalendarMonthHeading({ year, month: monthNumber, timeZone })} machine history`, currentLocale())}>
          {weekdays.map((weekday) => <div className="calendar-weekday" role="columnheader" key={weekday}>{weekday}</div>)}
          {cells.map((dateNumber, index) => {
            if (dateNumber === null) return <div className="calendar-day-empty" role="gridcell" aria-hidden="true" key={`empty-${index}`} />
            const date = `${year}-${monthNumber.toString().padStart(2, '0')}-${dateNumber.toString().padStart(2, '0')}`
            const record = calendarDays.get(date)
            const status = record?.status ?? (date > today ? 'future' : 'no-data')
            const sampleCount = record?.sampleCount ?? 0
            const currentDay = date === today
            const selected = selectedDate === date
            const label = translateText(`${dateLabel(date, timeZone)}. ${status === 'observed' ? 'Data observed' : status === 'partial' ? 'Partial data' : status === 'future' ? 'Future date' : 'No data'}${sampleCount ? `, ${sampleCount} samples` : ''}`, currentLocale())
            return <div className="calendar-day-cell" role="gridcell" key={date}>
              <button className={`calendar-day ${status} ${currentDay ? 'today' : ''} ${selected ? 'selected' : ''}`} aria-label={label} aria-pressed={selected} onClick={() => chooseDate(date)}>
                <span className="calendar-day-number">{dateNumber}</span>
                <span className="calendar-day-meta" data-no-translate={sampleCount > 0 ? '' : undefined}>{sampleCount > 0 ? sampleCount.toLocaleString(currentLocale()) : status === 'future' ? translateText('Future', currentLocale()) : '—'}</span>
                <span className="calendar-day-marker" aria-hidden="true" />
              </button>
            </div>
          })}
        </div>
        <div className="calendar-legend"><span><i className="observed" />Observed readings</span><span><i className="partial" />Partial collection</span><span><i className="no-data" />No samples</span></div>
        <div className="calendar-month-note">One local calendar day can be 23 or 25 hours when daylight saving changes.</div>
      </Card>

      <Card className="history-day-card">
        {!selectedDate && <div className="history-day-empty"><span className="history-day-icon"><CalendarDays size={20} /></span><h2>Select a day</h2><p>Choose a date to see its persisted machine readings and collection coverage.</p></div>}
        {dayLoading && <div className="history-day-empty" role="status"><span className="history-day-icon"><RefreshCw size={18} /></span><h2>Loading day</h2><p>Reading stored local machine history.</p></div>}
        {dayError && <div className="history-day-empty" role="alert"><span className="history-day-icon"><Wifi size={18} /></span><h2>Day is unavailable</h2><p>{dayError}</p></div>}
        {day && selectedDate && !dayLoading && !dayError && <>
          <div className="history-day-heading"><div><div className="card-kicker"><Clock3 size={14} /><span data-no-translate>{day.timeZone}</span></div><h2>{dateLabel(selectedDate, day.timeZone)}</h2></div><Badge tone={day.status === 'observed' ? 'good' : day.status === 'partial' ? 'warn' : 'neutral'}>{statusText}</Badge></div>
          {day.status === 'future' && <div className="history-status-note"><CalendarDays size={17} /><span><strong>Future date</strong><small>Readings will appear after the local collector reaches this day.</small></span></div>}
          {day.status === 'no-data' && <div className="history-status-note"><CalendarDays size={17} /><span><strong>No machine samples saved</strong><small>History begins when the collector starts. No earlier readings are backfilled.</small></span></div>}
          {day.summary && <>
            {day.status === 'partial' && <div className="history-status-note partial-note"><Clock3 size={17} /><span><strong>Partial collection · {Math.round(day.summary.coveragePercent)}% observed</strong><small>This day has missing time or fewer readings than the configured sampling cadence expects.</small></span></div>}
            <div className="day-summary-grid">
              <DayStat icon={Activity} label="CPU average / max" value={`${formatPercent(day.summary.cpuAveragePercent)} / ${formatPercent(day.summary.cpuMaximumPercent)}`} detail="Observed samples" />
              <DayStat icon={MemoryStick} label="Peak memory" value={<span data-no-translate>{formatBytes(day.summary.memoryPeakUsedBytes)}</span>} detail={formatPercent(day.summary.memoryPeakPercent)} />
              <DayStat icon={HardDrive} label="Storage snapshot" value={<span data-no-translate>{formatBytes(day.summary.storageSnapshotUsedBytes)}</span>} detail={<><span data-no-translate>{formatBytes(day.summary.storagePeakUsedBytes)}</span> {translateText('observed peak', currentLocale())}</>} />
              <DayStat icon={Wifi} label="Network received" value={<span data-no-translate>{formatBytes(day.summary.networkReceivedBytes)}</span>} detail={<><span data-no-translate>{formatBytes(day.summary.networkTransmittedBytes)}</span> {translateText('transmitted', currentLocale())}</>} />
              <DayStat icon={CalendarDays} label="Samples" value={day.summary.sampleCount.toLocaleString(currentLocale())} detail={`${Math.round(day.summary.coveragePercent)}% expected coverage`} />
              <DayStat icon={Clock3} label="Coverage window" value={formatTimestamp(day.summary.firstSampleAt, day.timeZone)} detail={`through ${formatTimestamp(day.summary.lastSampleAt, day.timeZone)}`} />
            </div>
            <Card className="history-day-chart"><SectionHeading title="CPU by minute" description="Each point comes from persisted minute rollups." /><LiveResourceChart points={day.points} metric="cpuPercent" label="CPU utilization" timeZone={day.timeZone} /></Card>
          </>}
          <div className="history-events"><SectionHeading title="Local backend events" description="Only real collector events are shown." />{day.events.length ? day.events.map((event) => <div className="history-event-row" key={event.id}><span className={`activity-marker marker-${event.severity === 'error' ? 'warn' : event.severity === 'info' ? 'good' : 'warn'}`} /><time>{formatTimestamp(event.occurredAt, day.timeZone)}</time><strong>{event.message}</strong></div>) : <p className="history-events-empty">No collector events recorded for this day.</p>}</div>
        </>}
      </Card>
    </div>
    <div className="history-footnote"><span className="footnote-dot" /> Machine history uses saved host readings. Server history is shown separately.</div>
    {calendar && <span className="sr-only" aria-live="polite">{pluralCount(calendar.days.filter((item) => item.sampleCount > 0).length, currentLocale(), {
      en: ['day contains saved readings in this month.', 'days contain saved readings in this month.'],
      ru: ['день содержит сохранённые замеры в этом месяце.', 'дня содержат сохранённые замеры в этом месяце.', 'дней содержат сохранённые замеры в этом месяце.'],
    })}</span>}
    <span className="sr-only">Showing month beginning {monthStart.toLocaleDateString(currentLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' })}.</span>
  </div>
}

function HistorySourceFilter({ value, servers, isAdmin, onChange }: {
  value: 'local' | ServerHistoryScope
  servers: LocalServerSummary[]
  isAdmin: boolean
  onChange: (value: string) => void
}) {
  const description = value === 'local'
    ? 'Host measurements stay separate from Minecraft process samples.'
    : 'Managed-server samples and parsed owned-process events only.'
  return <div className="history-filter-row">
    <label htmlFor="history-source">History source</label>
    <select id="history-source" aria-label="History source" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="local">Local machine · HOST</option>
      {isAdmin && <option value="all">All managed servers · SERVER</option>}
      {isAdmin && servers.map((server) => <option key={server.id} value={server.id} data-no-translate>{server.name}</option>)}
    </select>
    <span>{description}</span>
  </div>
}

function ServerHistoryPage({ sourceFilter, scope, serverName }: { sourceFilter: ReactNode; scope: ServerHistoryScope; serverName: string }) {
  const weekdays = weekdayLabels()
  const [searchParams, setSearchParams] = useSearchParams()
  const [calendar, setCalendar] = useState<ServerHistoryCalendar | null>(null)
  const [calendarError, setCalendarError] = useState<string | null>(null)
  const [calendarLoading, setCalendarLoading] = useState(true)
  const [day, setDay] = useState<ServerHistoryDay | null>(null)
  const [dayError, setDayError] = useState<string | null>(null)
  const [dayLoading, setDayLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const timeZone = calendar?.timeZone ?? day?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = todayInZone(timeZone)
  const rawDate = searchParams.get('date')
  const explicitDateIsInvalid = rawDate !== null && !validDate(rawDate)
  const month = monthKey(searchParams.get('month')) ?? (validDate(rawDate) ? rawDate.slice(0, 7) : today.slice(0, 7))
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const selectedDate = validDate(rawDate) ? rawDate : searchParams.get('month') ? null : today

  useEffect(() => {
    const controller = new AbortController()
    setCalendar(null); setCalendarError(null); setCalendarLoading(true)
    void getServerHistoryCalendar(scope, year, monthNumber, controller.signal).then((result) => {
      setCalendar(result); setCalendarLoading(false)
    }).catch((error: unknown) => {
      if (!isRequestCancelled(error)) { setCalendarError('The server history calendar is unavailable.'); setCalendarLoading(false) }
    })
    return () => controller.abort()
  }, [scope, year, monthNumber, reloadKey])

  useEffect(() => {
    if (!selectedDate || explicitDateIsInvalid) { setDay(null); setDayError(null); setDayLoading(false); return }
    const controller = new AbortController()
    setDay(null); setDayError(null); setDayLoading(true)
    void getServerHistoryDay(scope, selectedDate, controller.signal).then((result) => {
      setDay(result); setDayLoading(false)
    }).catch((error: unknown) => {
      if (!isRequestCancelled(error)) { setDayError('The selected server-history day could not be loaded.'); setDayLoading(false) }
    })
    return () => controller.abort()
  }, [scope, selectedDate, explicitDateIsInvalid, reloadKey])

  const cells = useMemo(() => {
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
    const firstWeekday = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7
    return [...Array.from({ length: firstWeekday }, () => null), ...Array.from({ length: daysInMonth }, (_, index) => index + 1)]
  }, [year, monthNumber])
  const calendarDays = new Map(calendar?.days.map((item) => [item.date, item]) ?? [])
  function chooseDate(date: string) {
    const next = new URLSearchParams(searchParams)
    next.set('date', date); next.set('month', date.slice(0, 7))
    setSearchParams(next, { preventScrollReset: true })
  }
  function chooseMonth(nextMonth: { year: number; month: number; key: string }) {
    const next = new URLSearchParams(searchParams)
    next.delete('date'); next.set('month', nextMonth.key)
    if (selectedDate?.startsWith(nextMonth.key)) next.set('date', selectedDate)
    setSearchParams(next, { preventScrollReset: true })
  }
  function goToday() {
    const next = new URLSearchParams(searchParams)
    next.set('month', today.slice(0, 7)); next.set('date', today)
    setSearchParams(next, { preventScrollReset: true })
  }
  const statusText = translateText(day?.status === 'observed' ? 'Observed' : day?.status === 'partial' ? 'Partial day' : day?.status === 'future' ? 'Future date' : 'No data', currentLocale())

  return <div className="page-stack machine-history-page">
    <PageHeading eyebrow={<><span data-no-translate>{serverName}</span> · persisted server history</>} title="Server history" description="Real samples from panel-owned process measurements and local status pings." actions={<Badge tone="neutral"><span data-no-translate>{timeZone}</span></Badge>} />
    {sourceFilter}
    {(calendarError || dayError) && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Server history is unavailable</strong><small>{calendarError ?? dayError}</small></span><Button icon={RefreshCw} onClick={() => { setCalendarError(null); setDayError(null); setReloadKey((value) => value + 1) }}>Retry</Button></div>}
    {explicitDateIsInvalid && <div className="history-inline-error" role="alert">This history link contains an invalid calendar date.</div>}
    <div className="history-layout">
      <Card className="history-calendar-card">
        <div className="history-calendar-toolbar">
          <button className="icon-button" aria-label="Previous month" title="Previous month" onClick={() => chooseMonth(shiftMonth(year, monthNumber, -1))}><ChevronLeft size={18} /></button>
          <h2>{CalendarMonthHeading({ year, month: monthNumber, timeZone })}</h2>
          <button className="icon-button" aria-label="Next month" title="Next month" onClick={() => chooseMonth(shiftMonth(year, monthNumber, 1))}><ChevronRight size={18} /></button>
          <Button kind="quiet" icon={CalendarDays} onClick={goToday}>Today</Button>
        </div>
        {calendarLoading && <div className="calendar-loading" role="status">Loading saved server readings…</div>}
        {calendarError && <div className="history-inline-error" role="alert">The server history calendar could not be loaded.</div>}
        <div className="machine-calendar-grid" role="grid" aria-label={translateText(`${CalendarMonthHeading({ year, month: monthNumber, timeZone })} server history`, currentLocale())}>
          {weekdays.map((weekday) => <div className="calendar-weekday" role="columnheader" key={weekday}>{weekday}</div>)}
          {cells.map((dateNumber, index) => {
            if (dateNumber === null) return <div className="calendar-day-empty" role="gridcell" aria-hidden="true" key={`empty-${index}`} />
            const date = `${year}-${monthNumber.toString().padStart(2, '0')}-${dateNumber.toString().padStart(2, '0')}`
            const record = calendarDays.get(date)
            const status = record?.status ?? (date > today ? 'future' : 'no-data')
            const currentDay = date === today
            const selected = selectedDate === date
            const label = translateText(`${dateLabel(date, timeZone)}. ${status === 'observed' ? 'Data observed' : status === 'partial' ? 'Partial data' : status === 'future' ? 'Future date' : 'No data'}${record?.sampleCount ? `, ${record.sampleCount} samples` : ''}${record?.eventCount ? `, ${record.eventCount} events` : ''}`, currentLocale())
            const dayMeta = record?.sampleCount ? record.sampleCount.toLocaleString(currentLocale()) : record?.eventCount ? pluralCount(record.eventCount, currentLocale(), { en: ['event', 'events'], ru: ['событие', 'события', 'событий'] }) : status === 'future' ? translateText('Future', currentLocale()) : '—'
            return <div className="calendar-day-cell" role="gridcell" key={date}><button className={`calendar-day ${status} ${currentDay ? 'today' : ''} ${selected ? 'selected' : ''}`} aria-label={label} aria-pressed={selected} onClick={() => chooseDate(date)}><span className="calendar-day-number">{dateNumber}</span><span className="calendar-day-meta" data-no-translate={record?.sampleCount ? '' : undefined}>{dayMeta}</span><span className="calendar-day-marker" aria-hidden="true" /></button></div>
          })}
        </div>
        <div className="calendar-legend"><span><i className="observed" />Observed readings</span><span><i className="partial" />Partial collection</span><span><i className="no-data" />No samples</span></div>
        <div className="calendar-month-note">Collection gaps stay visible. Local calendar boundaries account for 23 and 25 hour DST days.</div>
      </Card>

      <Card className="history-day-card">
        {!selectedDate && <HistoryEmpty icon={<CalendarDays size={20} />} title="Select a day" text="Choose a date to see its stored server readings, uptime sessions and parsed events." />}
        {dayLoading && <HistoryEmpty icon={<RefreshCw size={18} />} title="Loading day" text="Reading stored server history." />}
        {dayError && <HistoryEmpty icon={<Wifi size={18} />} title="Day is unavailable" text={dayError} />}
        {day && selectedDate && !dayLoading && !dayError && <>
          <div className="history-day-heading"><div><div className="card-kicker"><Clock3 size={14} />{day.timeZone}</div><h2>{dateLabel(selectedDate, day.timeZone)}</h2></div><Badge tone={day.status === 'observed' ? 'good' : day.status === 'partial' ? 'warn' : 'neutral'}>{statusText}</Badge></div>
          {day.status === 'future' && <div className="history-status-note"><CalendarDays size={17} /><span><strong>Future date</strong><small>Samples will appear after a managed process or status ping records them.</small></span></div>}
          {day.status === 'no-data' && <div className="history-status-note"><CalendarDays size={17} /><span><strong>No server samples saved</strong><small>This day has no retained measurements or parsed server events.</small></span></div>}
          {day.summary && <>
            {day.status === 'partial' && <div className="history-status-note partial-note"><Clock3 size={17} /><span><strong>Partial collection · {coverageLabel(day.summary.coveragePercent)} observed</strong><small>Polling is intermittent; missing readings are not filled in.</small></span></div>}
            <div className="day-summary-grid server-day-summary">
              <DayStat icon={Cpu} label="Process CPU average / max" value={`${formatPercent(day.summary.cpuAveragePercent)} / ${formatPercent(day.summary.cpuMaximumPercent)}`} detail="Owned child process only" />
              <DayStat icon={MemoryStick} label="Peak process memory" value={formatBytes(day.summary.memoryPeakBytes)} detail="Verified owned process RSS" />
              <DayStat icon={Wifi} label="Peak players online" value={day.summary.playersPeak === null ? 'Unavailable' : day.summary.playersPeak.toLocaleString(currentLocale())} detail="Status ping count, not identities" />
              <DayStat icon={Clock3} label="Uptime in selected day" value={formatDuration(day.summary.uptimeSeconds)} detail={`${day.summary.sessionCount} recorded session${day.summary.sessionCount === 1 ? '' : 's'}`} />
              <DayStat icon={CalendarDays} label="Samples" value={day.summary.sampleCount.toLocaleString(currentLocale())} detail={`${coverageLabel(day.summary.coveragePercent)} minute coverage`} />
              <DayStat icon={Clock3} label="Coverage window" value={formatTimestamp(day.summary.firstSampleAt, day.timeZone)} detail={`through ${formatTimestamp(day.summary.lastSampleAt, day.timeZone)}`} />
            </div>
            <Card className="history-day-chart"><SectionHeading title="Owned process CPU" description="Minute-bucket average of measured child-process CPU. Dots show observed minutes; blank spans indicate no retained sample." /><ServerCpuChart points={day.points} window={day.window} /></Card>
          </>}
          <div className="history-events"><SectionHeading title="Server events" description="Conservative templates from owned output and verified process lifecycle." />{day.events.length ? day.events.map((event) => <div className="server-history-event" key={event.id}><span className={`activity-marker ${event.category === 'server' ? 'marker-good' : event.category === 'moderation' ? 'marker-warn' : ''}`} /><div><time>{formatTimestamp(event.occurredAt, day.timeZone)} · {event.serverName}</time><strong>{event.description}</strong><small>{event.category} · {event.confidence} confidence</small>{event.rawMessage && <details><summary>Original log line</summary><code>{event.rawMessage}</code></details>}</div></div>) : <p className="history-events-empty">No parsed server events recorded for this day.</p>}{day.eventsTruncated && <p className="history-events-empty">Showing the first 500 matching events; older entries remain in the bounded ledger.</p>}</div>
          <div className="history-events"><SectionHeading title="Uptime sessions" description="Time overlapping this local calendar day." />{day.sessions.length ? day.sessions.map((session) => <div className="server-history-session" key={session.id}><span className={`activity-marker ${session.outcome === 'crashed' ? 'marker-warn' : 'marker-good'}`} /><div><strong>{session.serverName} · {session.outcome}</strong><small>{formatTimestamp(session.startedAt, day.timeZone)} → {session.endedAt ? formatTimestamp(session.endedAt, day.timeZone) : 'still running'}</small></div><Badge tone={session.outcome === 'crashed' ? 'danger' : 'neutral'}>{formatDuration(session.durationInDaySeconds)}</Badge></div>) : <p className="history-events-empty">No server sessions overlap this day.</p>}{day.sessionsTruncated && <p className="history-events-empty">Showing 200 session details; uptime and session totals include every overlapping session.</p>}</div>
        </>}
      </Card>
    </div>
    <div className="history-footnote"><span className="footnote-dot" /> Player pings provide counts only; event parsing is limited to recognized owned-process lines.</div>
  </div>
}

function HistoryEmpty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="history-day-empty"><span className="history-day-icon">{icon}</span><h2>{title}</h2><p>{text}</p></div>
}

function ServerCpuChart({ points, window }: { points: ServerHistoryDay['points']; window: ServerHistoryDay['window'] }) {
  const measured = points.filter((point) => point.cpuAveragePercent !== null)
  if (!measured.length) return <div className="server-history-chart-empty">CPU samples are unavailable for this interval.</div>
  const duration = Date.parse(window.to) - Date.parse(window.from)
  const minimum = Math.min(...measured.map((point) => point.cpuAveragePercent!))
  const maximum = Math.max(...measured.map((point) => point.cpuAveragePercent!))
  return <div className="server-history-chart"><div className="server-history-chart-label"><span>100%</span><span>50%</span><span>0%</span></div><svg viewBox="0 0 640 160" role="img" aria-label="Server child process CPU history"><title>Owned server process CPU by observed minute, with gaps left blank</title><path d="M20 20H620M20 80H620M20 140H620" />{measured.map((point) => {
    const x = 20 + ((Date.parse(point.observedAt) - Date.parse(window.from)) / duration) * 600
    const y = 140 - (Math.min(100, point.cpuAveragePercent!) / 100) * 120
    return <circle key={point.observedAt} cx={x} cy={y} r="4" />
  })}</svg><div className="server-history-chart-range"><span>{formatPercent(minimum)} min observed</span><strong>{formatPercent(maximum)} max observed</strong></div></div>
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function coverageLabel(percentage: number): string {
  return percentage > 0 && percentage < 1 ? '<1%' : `${Math.round(percentage)}%`
}

function DayStat({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: ReactNode; detail: ReactNode }) {
  return <div className="day-stat"><span className="day-stat-icon"><Icon size={15} /></span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>
}
