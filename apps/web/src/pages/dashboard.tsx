import { ArrowRight, ArrowUpRight, CalendarDays, Cpu, HardDrive, MemoryStick, Plus, RefreshCw, Server, Users, Wifi } from 'lucide-react'
import { Link } from 'react-router-dom'
import { activities, formatMemory, getServerSummary, servers } from '../data'
import { MetricTrack, WorldBlocks } from '../components/charts'
import { Badge, Card, PageHeading, StatusDot } from '../components/ui'
import { LiveResourceChart } from '../components/live-chart'
import { useMachineMonitor } from '../state/use-machine-monitor'
import { formatBytes, formatPercent, formatTimestamp } from '../lib/format'

export function DashboardPage({ onCreate }: { onCreate: () => void }) {
  const summary = getServerSummary()
  const monitor = useMachineMonitor()
  const current = monitor.current
  const sample = current?.sample ?? null
  const timeZone = current?.timeZone ?? monitor.history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const connected = monitor.apiStatus === 'online' && current?.status === 'live'
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())
  return <div className="page-stack dashboard-page">
    <PageHeading eyebrow={today} title="Dashboard" description="Server previews beside live readings from this local machine." />

    <div className="overview-strip" aria-label="Server demo summary and live local CPU">
      <div className="overview-number"><span className="overview-icon"><Server size={17} /></span><div><span>Servers online · DEMO</span><strong>{summary.online}<small> / {summary.total}</small></strong></div></div>
      <div className="overview-number"><span className="overview-icon"><Users size={17} /></span><div><span>Players online · DEMO</span><strong>{summary.players}<small> sample count</small></strong></div></div>
      <div className="overview-number"><span className="overview-icon"><MemoryStick size={17} /></span><div><span>Allocated memory · DEMO</span><strong>{summary.allocatedMemory}<small> sample total</small></strong></div></div>
      <div className="overview-number overview-machine-number"><span className="overview-icon"><Cpu size={17} /></span><div><span>Local CPU · LIVE</span><strong>{formatPercent(sample?.cpuPercent ?? null)}<small>{connected ? 'current' : current?.status === 'stale' ? 'stale' : 'unavailable'}</small></strong></div><span className={`live-indicator ${connected ? 'connected' : ''}`} aria-label={connected ? 'Live local machine' : 'Local machine unavailable'} />
      </div>
    </div>

    <div className="dashboard-grid">
      <Card className="resource-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Cpu size={15} /> Local machine · persisted history</div><h2>Resource activity</h2></div><Badge tone={connected ? 'good' : 'warn'}>{connected ? 'LIVE' : monitor.apiStatus === 'offline' ? 'Offline' : current?.status === 'stale' ? 'Stale' : 'Collecting'}</Badge></div>
        <div className="resource-card-body live-resource-body"><LiveResourceChart points={monitor.history?.points ?? []} metric="cpuPercent" label="CPU utilization" timeZone={timeZone} /><div className="resource-breakdown"><div className="breakdown-title">Latest sample</div>
          <MachineMetricTrack label="CPU" value={sample?.cpuPercent ?? null} detail={`${sample?.coreCount ?? current?.host?.coreCount ?? '—'} cores · local host`} tone="accent" />
          <MachineMetricTrack label="Memory" value={sample?.memory.usedPercent ?? null} detail={`${formatBytes(sample?.memory.usedBytes ?? null)} / ${formatBytes(sample?.memory.totalBytes ?? null)}`} tone="blue" />
          <MachineMetricTrack label="Storage" value={sample?.storage?.usedPercent ?? null} detail={sample?.storage?.mount ? `${sample.storage.mount} · ${formatBytes(sample.storage.usedBytes)} / ${formatBytes(sample.storage.totalBytes)}` : 'Root filesystem unavailable'} tone="amber" />
        </div></div>
        <div className="resource-card-foot"><span><span className="legend-dot accent" />CPU utilization</span><span><span className="legend-dot muted" />Actual sample times</span><span className="source-note"><HardDrive size={13} />{sample ? `Sampled ${formatTimestamp(sample.collectedAt, timeZone)}` : 'Waiting for local API'}</span></div>
      </Card>

      <Card className="fleet-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Server size={15} /> Server fleet · DEMO</div><h2>Server status</h2></div><Link className="text-link" to="/servers">View all <ArrowRight size={14} /></Link></div>
        <div className="fleet-list">{servers.map((server) => <Link className="fleet-row" to={`/servers/${server.id}`} key={server.id}>
          <WorldBlocks server={server} compact />
          <span className="fleet-row-main"><strong>{server.name}</strong><small>{server.software} · {server.version}</small></span>
          <span className="fleet-row-right"><span className="fleet-status"><StatusDot status={server.status} />{server.status}</span><small>{server.players}/{server.capacity} players</small></span>
        </Link>)}</div>
        <button className="fleet-create" onClick={onCreate}><span className="fleet-create-plus"><Plus size={12} aria-hidden="true" /></span><span>Create a server preview</span><ArrowUpRight size={14} /></button>
      </Card>

      <Card className="activity-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Wifi size={15} /> Server activity · DEMO</div><h2>Sample events</h2></div><Link className="text-link" to="/activity">Activity log <ArrowRight size={14} /></Link></div>
        <div className="activity-list">{activities.slice(0, 3).map((activity) => <div className="activity-row" key={activity.id}>
          <span className={`activity-marker marker-${activity.tone}`} />
          <div className="activity-copy"><strong>{activity.event}</strong><span>{activity.server} <span className="activity-dot-sep">·</span> {activity.detail}</span></div>
          <time>{activity.time}</time>
        </div>)}</div>
      </Card>

      <Card className="machine-card">
        <div className="card-heading-row"><div><div className="card-kicker"><HardDrive size={15} /> Host details · LIVE</div><h2>Local machine</h2></div><Link className="text-link" to="/machine/history"><CalendarDays size={14} /> History</Link></div>
        <div className="machine-card-body"><div className="machine-name"><span className="machine-icon"><Cpu size={20} /></span><div><strong>{current?.host?.hostname ?? 'Waiting for host details'}</strong><span>{current?.host ? `${current.host.distro ?? current.host.platform} · ${current.host.architecture}` : monitor.error ?? 'Local API has not returned a sample'}</span></div><span className={`machine-connection ${connected ? 'is-live' : ''}`}><i />{connected ? 'Live' : current?.status === 'stale' ? 'Stale' : 'Unavailable'}</span></div>
          <div className="machine-specs"><div><span>Processor</span><strong>{current?.host?.cpuModel ?? 'Unavailable'}</strong></div><div><span>Memory total</span><strong>{formatBytes(sample?.memory.totalBytes ?? null)}</strong></div><div><span>Network</span><strong>{sample?.network.interface ?? 'Unavailable'}</strong></div></div>
          <Link to="/machine" className="machine-link">View live machine overview <ArrowRight size={14} /></Link>
        </div>
      </Card>
    </div>
    {monitor.apiStatus === 'offline' && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Local metrics are unavailable</strong><small>Server cards remain DEMO. No machine values are being substituted.</small></span><button className="button button-secondary" onClick={monitor.refreshNow}><RefreshCw size={14} /> Retry</button></div>}
  </div>
}

function MachineMetricTrack({ label, value, detail, tone }: { label: string; value: number | null; detail: string; tone: 'accent' | 'blue' | 'amber' }) {
  if (value === null) return <div className="metric-unavailable"><div className="metric-track-copy"><span>{label}</span><strong>Unavailable</strong></div><p>{detail}</p></div>
  return <MetricTrack label={label} value={Math.round(value)} detail={detail} tone={tone} />
}

export function ServerTile({ server }: { server: (typeof servers)[number] }) {
  return <Link to={`/servers/${server.id}`} className="server-tile">
    <div className="server-tile-top"><WorldBlocks server={server} /><div><div className="server-tile-title"><strong>{server.name}</strong><Badge tone={server.status === 'Online' ? 'good' : 'neutral'}><StatusDot status={server.status} />{server.status}</Badge></div><p>{server.software} {server.version} <span>·</span> {server.world}</p></div></div>
    <div className="server-tile-metrics"><div><span>Players</span><strong>{server.players}<small> / {server.capacity}</small></strong></div><div><span>Memory</span><strong>{formatMemory(server.memoryUsed)}<small> / {server.memoryTotal} GB</small></strong></div><div><span>Uptime</span><strong>{server.uptime}</strong></div></div>
    <div className="server-tile-footer"><span>{server.address}</span><span>Open overview <ArrowRight size={13} /></span></div>
  </Link>
}
