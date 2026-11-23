import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, CalendarDays, ChevronLeft, ChevronRight, Clock3, Cpu, HardDrive, MemoryStick, RefreshCw, Wifi } from 'lucide-react'
import type { MachineCalendar, MachineDay } from '@mmsmanager/shared'
import { Badge, Button, Card, PageHeading, SectionHeading } from '../components/ui'
import { LiveResourceChart, CalendarMonthHeading } from '../components/live-chart'
import { getMachineCalendar, getMachineDay, isRequestCancelled } from '../api/machine'
import { useMachineMonitor } from '../state/use-machine-monitor'
import { formatBytes, formatConfiguredDate, formatPercent, formatTimestamp } from '../lib/format'

const weekdays = Array.from({ length: 7 }, (_, index) => {
  const monday = new Date(Date.UTC(2024, 0, 1 + index, 12))
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(monday)
})

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
  const monitor = useMachineMonitor()
  const [searchParams, setSearchParams] = useSearchParams()
  const timeZone = monitor.current?.timeZone ?? monitor.history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
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
    const next = new URLSearchParams()
    next.set('month', nextMonth.key)
    if (selectedDate?.startsWith(nextMonth.key)) next.set('date', selectedDate)
    setSearchParams(next, { preventScrollReset: true })
  }

  function goToday() {
    const next = new URLSearchParams({ month: today.slice(0, 7), date: today })
    setSearchParams(next, { preventScrollReset: true })
  }

  const monthStart = new Date(Date.UTC(year, monthNumber - 1, 1))
  const statusText = day?.status === 'observed' ? 'Observed' : day?.status === 'partial' ? 'Partial day' : day?.status === 'future' ? 'Future date' : 'No data'

  return <div className="page-stack machine-history-page">
    <PageHeading eyebrow="Local machine · persisted history" title="Machine history" description="Browse real readings saved by this local backend. Dates follow the configured timezone." actions={<Badge tone={monitor.apiStatus === 'online' ? 'good' : 'warn'}>{timeZone}</Badge>} />
    <div className="history-filter-row">
      <label htmlFor="history-source">History source</label>
      <select id="history-source" aria-label="History source" value="local" onChange={() => undefined}>
        <option value="local">Local machine · LIVE</option>
        <option value="all" disabled>All servers · Coming later</option>
        <option value="alder" disabled>Alder SMP · Coming later</option>
        <option value="copper" disabled>Copper Grove · Coming later</option>
      </select>
      <span>Server history is not connected in this stage.</span>
    </div>

    {(calendarError || monitor.apiStatus === 'offline') && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Machine history is unavailable</strong><small>{calendarError ?? monitor.error ?? 'The local API is offline.'}</small></span><Button icon={RefreshCw} onClick={() => { monitor.refreshNow(); setCalendarError(null); setReloadKey((value) => value + 1) }}>Retry</Button></div>}
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
        <div className="machine-calendar-grid" role="grid" aria-label={`${CalendarMonthHeading({ year, month: monthNumber, timeZone })} machine history`}>
          {weekdays.map((weekday) => <div className="calendar-weekday" role="columnheader" key={weekday}>{weekday}</div>)}
          {cells.map((dateNumber, index) => {
            if (dateNumber === null) return <div className="calendar-day-empty" role="gridcell" aria-hidden="true" key={`empty-${index}`} />
            const date = `${year}-${monthNumber.toString().padStart(2, '0')}-${dateNumber.toString().padStart(2, '0')}`
            const record = calendarDays.get(date)
            const status = record?.status ?? (date > today ? 'future' : 'no-data')
            const sampleCount = record?.sampleCount ?? 0
            const currentDay = date === today
            const selected = selectedDate === date
            const label = `${dateLabel(date, timeZone)}. ${status === 'observed' ? 'Data observed' : status === 'partial' ? 'Partial data' : status === 'future' ? 'Future date' : 'No data'}${sampleCount ? `, ${sampleCount.toLocaleString()} samples` : ''}`
            return <div className="calendar-day-cell" role="gridcell" key={date}>
              <button className={`calendar-day ${status} ${currentDay ? 'today' : ''} ${selected ? 'selected' : ''}`} aria-label={label} aria-pressed={selected} onClick={() => chooseDate(date)}>
                <span className="calendar-day-number">{dateNumber}</span>
                <span className="calendar-day-meta">{sampleCount > 0 ? sampleCount.toLocaleString() : status === 'future' ? 'Future' : '—'}</span>
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
          <div className="history-day-heading"><div><div className="card-kicker"><Clock3 size={14} />{day.timeZone}</div><h2>{dateLabel(selectedDate, day.timeZone)}</h2></div><Badge tone={day.status === 'observed' ? 'good' : day.status === 'partial' ? 'warn' : 'neutral'}>{statusText}</Badge></div>
          {day.status === 'future' && <div className="history-status-note"><CalendarDays size={17} /><span><strong>Future date</strong><small>Readings will appear after the local collector reaches this day.</small></span></div>}
          {day.status === 'no-data' && <div className="history-status-note"><CalendarDays size={17} /><span><strong>No machine samples saved</strong><small>History begins when the collector starts. No earlier readings are backfilled.</small></span></div>}
          {day.summary && <>
            {day.status === 'partial' && <div className="history-status-note partial-note"><Clock3 size={17} /><span><strong>Partial collection · {Math.round(day.summary.coveragePercent)}% observed</strong><small>This day has missing time or fewer readings than the configured sampling cadence expects.</small></span></div>}
            <div className="day-summary-grid">
              <DayStat icon={Activity} label="CPU average / max" value={`${formatPercent(day.summary.cpuAveragePercent)} / ${formatPercent(day.summary.cpuMaximumPercent)}`} detail="Observed samples" />
              <DayStat icon={MemoryStick} label="Peak memory" value={formatBytes(day.summary.memoryPeakUsedBytes)} detail={formatPercent(day.summary.memoryPeakPercent)} />
              <DayStat icon={HardDrive} label="Storage snapshot" value={formatBytes(day.summary.storageSnapshotUsedBytes)} detail={`${formatBytes(day.summary.storagePeakUsedBytes)} observed peak`} />
              <DayStat icon={Wifi} label="Network received" value={formatBytes(day.summary.networkReceivedBytes)} detail={`${formatBytes(day.summary.networkTransmittedBytes)} transmitted`} />
              <DayStat icon={CalendarDays} label="Samples" value={day.summary.sampleCount.toLocaleString()} detail={`${Math.round(day.summary.coveragePercent)}% expected coverage`} />
              <DayStat icon={Clock3} label="Coverage window" value={formatTimestamp(day.summary.firstSampleAt, day.timeZone)} detail={`through ${formatTimestamp(day.summary.lastSampleAt, day.timeZone)}`} />
            </div>
            <Card className="history-day-chart"><SectionHeading title="CPU by minute" description="Each point comes from persisted minute rollups." /><LiveResourceChart points={day.points} metric="cpuPercent" label="CPU utilization" timeZone={day.timeZone} /></Card>
          </>}
          <div className="history-events"><SectionHeading title="Local backend events" description="Only real collector events are shown." />{day.events.length ? day.events.map((event) => <div className="history-event-row" key={event.id}><span className={`activity-marker marker-${event.severity === 'error' ? 'warn' : event.severity === 'info' ? 'good' : 'warn'}`} /><time>{formatTimestamp(event.occurredAt, day.timeZone)}</time><strong>{event.message}</strong></div>) : <p className="history-events-empty">No collector events recorded for this day.</p>}</div>
        </>}
      </Card>
    </div>
    <div className="history-footnote"><span className="footnote-dot" /> Local machine values are LIVE when connected. Server values remain DEMO and are excluded from this calendar.</div>
    {calendar && <span className="sr-only" aria-live="polite">{calendar.days.filter((item) => item.sampleCount > 0).length} days contain saved readings in this month.</span>}
    <span className="sr-only">Showing month beginning {monthStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}.</span>
  </div>
}

function DayStat({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail: string }) {
  return <div className="day-stat"><span className="day-stat-icon"><Icon size={15} /></span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>
}
