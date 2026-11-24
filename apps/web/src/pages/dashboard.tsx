import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, CalendarDays, Cpu, HardDrive, Plus, RefreshCw, Server, Users, Wifi } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { LocalServerSummary } from '@mmsmanager/shared'
import { MetricTrack } from '../components/charts'
import { Badge, Card, PageHeading } from '../components/ui'
import { LiveResourceChart } from '../components/live-chart'
import { getLocalServers } from '../api/servers'
import { useAuth } from '../state/use-auth'
import { useMachineMonitor } from '../state/use-machine-monitor'
import { formatBytes, formatPercent, formatTimestamp } from '../lib/format'
import { apiErrorMessage } from '../api/client'

export function DashboardPage({ onCreate }: { onCreate: () => void }) {
  const [registered, setRegistered] = useState<LocalServerSummary[]>([])
  const [serverLoading, setServerLoading] = useState(true)
  const [serverError, setServerError] = useState<string | null>(null)
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const loadServers = useCallback(async (signal?: AbortSignal) => {
    try {
      setRegistered(await getLocalServers(signal))
      setServerError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setServerError(apiErrorMessage(error, 'The local server registry is unavailable.'))
    } finally { setServerLoading(false) }
  }, [])
  useEffect(() => { const controller = new AbortController(); void loadServers(controller.signal); return () => controller.abort() }, [loadServers])
  const running = registered.filter((server) => server.runtimeStatus === 'running').length
  const monitor = useMachineMonitor()
  const current = monitor.current
  const sample = current?.sample ?? null
  const timeZone = current?.timeZone ?? monitor.history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const connected = monitor.apiStatus === 'online' && current?.status === 'live'
  const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())
  return <div className="page-stack dashboard-page">
    <PageHeading eyebrow={today} title="Dashboard" description="Registered local servers and live readings from this machine." />

    <div className="overview-strip" aria-label="Registered server summary and local CPU">
      <div className="overview-number"><span className="overview-icon"><Server size={17} /></span><div><span>Running servers</span><strong>{serverLoading || serverError ? '—' : running}<small> / {serverLoading || serverError ? '—' : registered.length} registered</small></strong></div></div>
      <div className="overview-number"><span className="overview-icon"><Users size={17} /></span><div><span>Players online</span><strong>—<small> query unavailable</small></strong></div></div>
      <div className="overview-number"><span className="overview-icon"><HardDrive size={17} /></span><div><span>Managed servers</span><strong>{serverLoading || serverError ? '—' : registered.filter((server) => server.managed && server.source === 'created').length}<small> local instances</small></strong></div></div>
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
        <div className="card-heading-row"><div><div className="card-kicker"><Server size={15} /> Local registry</div><h2>Server status</h2></div><Link className="text-link" to="/servers">View all <ArrowRight size={14} /></Link></div>
        <div className="fleet-list">{serverLoading ? <div className="local-server-empty">Reading registered servers…</div> : serverError ? <div className="local-server-empty" role="status">{serverError} <button className="text-link" onClick={() => void loadServers()}>Retry</button></div> : registered.length ? registered.slice(0, 5).map((server) => <Link className="fleet-row" to={`/servers/${server.id}/overview`} key={server.id}>
          <span className="local-server-icon"><Server size={16} /></span>
          <span className="fleet-row-main"><strong>{server.name}</strong><small>{server.software} · {server.version ?? 'version unknown'} · {server.source === 'imported' ? 'read only' : 'managed'}</small></span>
          <span className="fleet-row-right"><Badge tone={server.runtimeStatus === 'running' ? 'good' : server.runtimeStatus === 'error' || server.runtimeStatus === 'crashed' ? 'danger' : 'neutral'}>{server.runtimeStatus === 'external/unmanaged' ? 'Unmanaged' : server.runtimeStatus ?? 'Unavailable'}</Badge><small>{server.port ? `127.0.0.1:${server.port}` : 'Port unknown'}</small></span>
        </Link>) : <div className="local-server-empty">No servers registered on this computer.</div>}</div>
        {isAdmin && <button className="fleet-create" onClick={onCreate}><span className="fleet-create-plus"><Plus size={12} aria-hidden="true" /></span><span>Create a local server</span><ArrowUpRight size={14} /></button>}
      </Card>

      <Card className="activity-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Wifi size={15} /> Server activity</div><h2>Recent events</h2></div><Link className="text-link" to="/activity">Activity log <ArrowRight size={14} /></Link></div>
        <div className="local-server-empty">A server event timeline will appear after structured event collection is connected.</div>
      </Card>

      <Card className="machine-card">
        <div className="card-heading-row"><div><div className="card-kicker"><HardDrive size={15} /> Host details · LIVE</div><h2>Local machine</h2></div><Link className="text-link" to="/machine/history"><CalendarDays size={14} /> History</Link></div>
        <div className="machine-card-body"><div className="machine-name"><span className="machine-icon"><Cpu size={20} /></span><div><strong>{current?.host?.hostname ?? 'Waiting for host details'}</strong><span>{current?.host ? `${current.host.distro ?? current.host.platform} · ${current.host.architecture}` : monitor.error ?? 'Local API has not returned a sample'}</span></div><span className={`machine-connection ${connected ? 'is-live' : ''}`}><i />{connected ? 'Live' : current?.status === 'stale' ? 'Stale' : 'Unavailable'}</span></div>
          <div className="machine-specs"><div><span>Processor</span><strong>{current?.host?.cpuModel ?? 'Unavailable'}</strong></div><div><span>Memory total</span><strong>{formatBytes(sample?.memory.totalBytes ?? null)}</strong></div><div><span>Network</span><strong>{sample?.network.interface ?? 'Unavailable'}</strong></div></div>
          <Link to="/machine" className="machine-link">View live machine overview <ArrowRight size={14} /></Link>
        </div>
      </Card>
    </div>
    {monitor.apiStatus === 'offline' && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Local metrics are unavailable</strong><small>No machine values are being substituted.</small></span><button className="button button-secondary" onClick={monitor.refreshNow}><RefreshCw size={14} /> Retry</button></div>}
  </div>
}

function MachineMetricTrack({ label, value, detail, tone }: { label: string; value: number | null; detail: string; tone: 'accent' | 'blue' | 'amber' }) {
  if (value === null) return <div className="metric-unavailable"><div className="metric-track-copy"><span>{label}</span><strong>Unavailable</strong></div><p>{detail}</p></div>
  return <MetricTrack label={label} value={Math.round(value)} detail={detail} tone={tone} />
}
