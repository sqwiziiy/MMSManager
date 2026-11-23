import { useMemo } from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cpuSeries, type ServerRecord } from '../data'

function linePath(values: number[], width: number, height: number, padding = 12) {
  const max = 70
  const innerWidth = width - padding * 2
  const innerHeight = height - padding * 2
  const coords = values.map((value, index) => ({
    x: padding + (index / (values.length - 1)) * innerWidth,
    y: padding + innerHeight - (value / max) * innerHeight,
  }))
  const first = coords[0]
  const line = first ? coords.slice(1).reduce((path, point, index) => {
    const previous = coords[index]!
    const before = coords[Math.max(index - 1, 0)]!
    const after = coords[Math.min(index + 2, coords.length - 1)]!
    const controlOne = { x: previous.x + (point.x - before.x) / 6, y: previous.y + (point.y - before.y) / 6 }
    const controlTwo = { x: point.x - (after.x - previous.x) / 6, y: point.y - (after.y - previous.y) / 6 }
    return `${path} C${controlOne.x.toFixed(1)},${controlOne.y.toFixed(1)} ${controlTwo.x.toFixed(1)},${controlTwo.y.toFixed(1)} ${point.x.toFixed(1)},${point.y.toFixed(1)}`
  }, `M${first.x.toFixed(1)},${first.y.toFixed(1)}`) : ''
  const last = coords[coords.length - 1]
  return { line, area: `${line} L${last?.x.toFixed(1)},${(height - padding).toFixed(1)} L${padding},${(height - padding).toFixed(1)} Z`, point: last }
}

export function ResourceTimeline() {
  const plot = useMemo(() => linePath(cpuSeries, 720, 216, 14), [])
  return (
    <div className="timeline-wrap">
      <div className="timeline-summary"><strong>34<span>%</span></strong><span className="timeline-change"><ArrowDownRight size={14} /> 4% from yesterday</span><span className="timeline-range">Last 24 hours</span></div>
      <div className="timeline-chart">
        <div className="timeline-axis"><span>60%</span><span>40%</span><span>20%</span><span>0%</span></div>
        <svg viewBox="0 0 720 216" preserveAspectRatio="none" role="img" aria-label="Mock CPU utilization over the last 24 hours, currently 34 percent">
          <defs><linearGradient id="cpu-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".16" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
          {[28, 84, 140, 196].map((y) => <line key={y} x1="0" x2="720" y1={y} y2={y} className="chart-grid-line" />)}
          {[0, 120, 240, 360, 480, 600, 720].map((x) => <line key={x} x1={x} x2={x} y1="12" y2="204" className="chart-grid-vertical" />)}
          <path d={plot.area} fill="url(#cpu-fill)" />
          <path d={plot.line} className="chart-main-line" />
          {plot.point && <><circle cx={plot.point.x} cy={plot.point.y} r="7" className="chart-point-halo" /><circle cx={plot.point.x} cy={plot.point.y} r="3.5" className="chart-point" /></>}
        </svg>
        <div className="timeline-labels"><span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>Now</span></div>
      </div>
    </div>
  )
}

export function MetricTrack({ label, value, detail, tone = 'accent', delta }: { label: string; value: number; detail: string; tone?: 'accent' | 'blue' | 'amber'; delta?: 'up' | 'down' }) {
  return (
    <div className="metric-track-row">
      <div className="metric-track-copy"><span>{label}</span><strong>{value}%</strong></div>
      <div className={`metric-track ${tone}`}><span style={{ width: `${Math.min(value, 100)}%` }} /></div>
      <div className="metric-track-foot"><span>{detail}</span>{delta && <span className="metric-delta">{delta === 'up' ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{delta === 'up' ? '4%' : '2%'}</span>}</div>
    </div>
  )
}

export function WorldBlocks({ server, compact = false }: { server: ServerRecord; compact?: boolean }) {
  const terrain = server.accent === 'moss' ? 'moss' : server.accent === 'clay' ? 'clay' : 'stone'
  const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  return <div className={`world-blocks ${terrain} ${compact ? 'compact' : ''}`} aria-label={`${server.name} sample world marker`} role="img">
    {cells.map((cell) => <span key={cell} className={`block-cell block-${cell}`} />)}
  </div>
}
