import { currentLocale } from "../i18n/catalog"
import type { MachineResourcePoint } from '@mmsmanager/shared'
import { formatConfiguredDate } from '../lib/format'

type MetricKey = 'cpuPercent' | 'memoryPercent' | 'storagePercent'

const dimensions = { width: 720, height: 216, inset: 14 }

export function LiveResourceChart({
  points,
  metric,
  label,
  timeZone,
  bucketSeconds,
  coveragePercent,
  rangeLabel,
}: {
  points: MachineResourcePoint[]
  metric: MetricKey
  label: string
  timeZone: string
  bucketSeconds?: number
  coveragePercent?: number
  rangeLabel?: string
}) {
  const valid = points
    .map((point) => ({ point, value: point[metric] }))
    .filter((entry): entry is { point: MachineResourcePoint; value: number } => entry.value !== null)
  const first = valid[0]?.point.observedAt
  const last = valid[valid.length - 1]?.point.observedAt
  const span = first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0

  if (valid.length < 2) {
    return <div className="live-chart-empty" role="status">
      <span className="chart-empty-mark" />
      <strong>Collecting history</strong>
      <span>{valid.length === 1 ? 'One real sample is stored. A trend appears after more readings.' : 'A trend appears after real samples have been stored.'}</span>
    </div>
  }

  const startMs = Date.parse(first!)
  const endMs = Date.parse(last!)
  const plotSpan = Math.max(1000, endMs - startMs)
  const { width, height, inset } = dimensions
  const plotHeight = height - inset * 2
  const plotWidth = width - inset * 2
  const coords = valid.map(({ point, value }) => ({
    x: inset + ((Date.parse(point.observedAt) - startMs) / plotSpan) * plotWidth,
    y: height - inset - (Math.max(0, Math.min(100, value)) / 100) * plotHeight,
    at: point.observedAt,
  }))

  const segments: typeof coords[] = []
  for (const coord of coords) {
    const current = segments[segments.length - 1]
    const previous = current?.[current.length - 1]
    const expectedStepMs = Math.max(10_000, (bucketSeconds ?? 10) * 1000)
    if (!current || (previous && Date.parse(coord.at) - Date.parse(previous.at) > expectedStepMs * 1.5)) {
      segments.push([coord])
    } else {
      current.push(coord)
    }
  }
  const paths = segments.filter((segment) => segment.length > 1).map((segment) =>
    segment.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
  )
  const latest = valid[valid.length - 1]!
  const sameDate = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(first!))
    === new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(last!))
  const axisOptions: Intl.DateTimeFormatOptions = sameDate
    ? { hour: '2-digit', minute: '2-digit', second: span < 60 * 60 * 1000 ? '2-digit' : undefined }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  const observedFrom = new Intl.DateTimeFormat(currentLocale(), { timeZone, ...axisOptions }).format(new Date(first!))
  const observedTo = new Intl.DateTimeFormat(currentLocale(), { timeZone, ...axisOptions }).format(new Date(last!))
  const pointDescription = (at: string, value: number) => `${new Intl.DateTimeFormat(currentLocale(), { timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(at))}: ${label} ${value.toFixed(1)}%`

  return <div className="live-chart-wrap">
    <div className="timeline-summary">
      <strong>{Math.round(latest.value)}<span>%</span></strong>
      <span className="live-chart-source">Latest sample</span>
      <span className="timeline-range">{rangeLabel ?? 'Recent history'}{coveragePercent !== undefined && coveragePercent < 99 ? ` · ${Math.round(coveragePercent)}% coverage` : ''}</span>
    </div>
    <div className="timeline-chart live-timeline-chart">
      <div className="timeline-axis"><span>100%</span><span>50%</span><span>0%</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label} from ${observedFrom} to ${observedTo}, latest ${Math.round(latest.value)} percent`}>
        {[inset, height / 2, height - inset].map((y) => <line key={y} x1="0" x2={width} y1={y} y2={y} className="chart-grid-line" />)}
        {paths.map((path, index) => <path key={index} d={path} className={`live-chart-line ${metric}`} />)}
        {coords.map((point, index) => <circle key={`${point.at}-${index}`} cx={point.x} cy={point.y} r={index === coords.length - 1 ? 3.5 : 2} className="live-chart-point"><title>{pointDescription(point.at, valid[index]!.value)}</title></circle>)}
      </svg>
      <div className="timeline-labels live-chart-labels"><span>{observedFrom}</span><span>{observedTo}</span></div>
    </div>
    <div className="live-chart-footnote">Observed readings only; empty spans indicate a collection gap.</div>
  </div>
}

export function CalendarMonthHeading({ year, month, timeZone }: { year: number; month: number; timeZone: string }) {
  const date = new Date(Date.UTC(year, month - 1, 1, 12))
  return formatConfiguredDate(date.toISOString(), timeZone, { month: 'long', year: 'numeric' })
}
