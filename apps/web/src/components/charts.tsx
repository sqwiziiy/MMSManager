import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

export function MetricTrack({ label, value, detail, tone = 'accent', delta }: { label: string; value: number; detail: string; tone?: 'accent' | 'blue' | 'amber'; delta?: 'up' | 'down' }) {
  return (
    <div className="metric-track-row">
      <div className="metric-track-copy"><span>{label}</span><strong>{value}%</strong></div>
      <div className={`metric-track ${tone}`}><span style={{ width: `${Math.min(value, 100)}%` }} /></div>
      <div className="metric-track-foot"><span>{detail}</span>{delta && <span className="metric-delta">{delta === 'up' ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{delta === 'up' ? '4%' : '2%'}</span>}</div>
    </div>
  )
}
