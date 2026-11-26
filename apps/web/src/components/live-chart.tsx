import { useState } from 'react'
import { currentLocale, translateText } from '../i18n/catalog'
import type { MachineResourcePoint } from '@mmsmanager/shared'
import { formatConfiguredDate } from '../lib/format'
import { normalizeChartPoints, splitChartSegments } from '../lib/resource-points'

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
  const [hoveredAt, setHoveredAt] = useState<number | null>(null)
  const ordered = normalizeChartPoints(points, metric)
  const valid = ordered.filter((entry): entry is typeof entry & { value: number } => entry.value !== null)
  const first = valid[0]?.point.observedAt
  const last = valid.at(-1)?.point.observedAt
  const span = first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0

  if (valid.length < 2) {
    return <div className="live-chart-empty" role="status">
      <span className="chart-empty-mark" />
      <strong>Collecting history</strong>
      <span>{valid.length === 1 ? 'One real sample is stored. A trend appears after more readings.' : 'A trend appears after real samples have been stored.'}</span>
    </div>
  }

  const startMs = ordered[0]?.timestamp ?? Date.parse(first!)
  const endMs = ordered.at(-1)?.timestamp ?? Date.parse(last!)
  const plotSpan = Math.max(1000, endMs - startMs)
  const { width, height, inset } = dimensions
  const plotHeight = height - inset * 2
  const plotWidth = width - inset * 2
  const coordinateFor = (entry: typeof valid[number]) => ({
    x: inset + ((entry.timestamp - startMs) / plotSpan) * plotWidth,
    y: height - inset - (entry.value / 100) * plotHeight,
    at: entry.timestamp,
    value: entry.value,
    label: entry.point.observedAt,
  })
  const coords = valid.map(coordinateFor)
  const coordinatesByTimestamp = new Map(coords.map((point) => [point.at, point]))
  const segments = splitChartSegments(ordered, bucketSeconds).map((segment) => segment.map((entry) => coordinatesByTimestamp.get(entry.timestamp)!))
  const paths = segments.map((segment) =>
    segment.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
  )
  const latest = coords.at(-1)!
  const hovered = hoveredAt === null ? null : coordinatesByTimestamp.get(hoveredAt) ?? null
  const sameDate = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(first!))
    === new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(last!))
  const axisOptions: Intl.DateTimeFormatOptions = sameDate
    ? { hour: '2-digit', minute: '2-digit', second: span < 60 * 60 * 1000 ? '2-digit' : undefined }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  const observedFrom = new Intl.DateTimeFormat(currentLocale(), { timeZone, ...axisOptions }).format(new Date(first!))
  const observedTo = new Intl.DateTimeFormat(currentLocale(), { timeZone, ...axisOptions }).format(new Date(last!))
  const localizedLabel = translateText(label, currentLocale())
  const pointDescription = (at: number, value: number) => `${new Intl.DateTimeFormat(currentLocale(), { timeZone, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(at))}: ${localizedLabel} ${value.toFixed(1)}%`
  const chartAriaLabel = translateText(`${label} from ${observedFrom} to ${observedTo}, latest ${Math.round(latest.value)} percent`, currentLocale())
  const localizedRange = rangeLabel ? translateText(rangeLabel, currentLocale()) : translateText('Recent history', currentLocale())
  const coverageLabel = coveragePercent !== undefined && coveragePercent < 99
    ? currentLocale() === 'ru' ? ` · охват ${Math.round(coveragePercent)}%` : ` · ${Math.round(coveragePercent)}% coverage`
    : ''

  return <div className="live-chart-wrap">
    <div className="timeline-summary">
      <strong>{Math.round(latest.value)}<span>%</span></strong>
      <span className="live-chart-source">Latest sample</span>
      <span className="timeline-range">{localizedRange}{coverageLabel}</span>
    </div>
    <div className="timeline-chart live-timeline-chart">
      <div className="timeline-axis"><span>100%</span><span>50%</span><span>0%</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={chartAriaLabel}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          if (!bounds.width) return
          const x = ((event.clientX - bounds.left) / bounds.width) * width
          let nearest = coords[0]!
          for (const point of coords) if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point
          setHoveredAt((current) => current === nearest.at ? current : nearest.at)
        }}
        onPointerLeave={() => setHoveredAt(null)}>
        {[inset, height / 2, height - inset].map((y) => <line key={y} x1="0" x2={width} y1={y} y2={y} className="chart-grid-line" />)}
        {paths.map((path, index) => <path key={index} d={path} className={`live-chart-line ${metric}`} />)}
        {hovered && hovered.at !== latest.at && <circle cx={hovered.x} cy={hovered.y} r="3" className="live-chart-hover-point"><title>{pointDescription(hovered.at, hovered.value)}</title></circle>}
        <circle cx={latest.x} cy={latest.y} r="3.5" className="live-chart-latest-point"><title>{pointDescription(latest.at, latest.value)}</title></circle>
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
