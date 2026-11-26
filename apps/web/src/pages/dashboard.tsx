import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, CalendarDays, Cpu, HardDrive, Plus, RefreshCw, Server, Users, Wifi } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { LocalServerSummary } from '@mmsmanager/shared'
import type { ActivityItem } from '@mmsmanager/shared'
import { MetricTrack } from '../components/charts'
import { currentLocale, pluralCount, translateText } from '../i18n/catalog'
import { Badge, Card, PageHeading } from '../components/ui'
import { LiveResourceChart } from '../components/live-chart'
import { mergeResourcePoints } from '../lib/resource-points'
import { getDashboardPlayerSummary, getLocalServers } from '../api/servers'
import { useAuth } from '../state/use-auth'
import { useMachineMonitor } from '../state/use-machine-monitor'
import { primaryStorageVolume, useMachineStorage } from '../state/use-machine-storage'
import { formatBytes, formatPercent, formatTimestamp } from '../lib/format'
import { apiErrorMessage } from '../api/client'
import { getActivity } from '../api/activity'
import { serverPortIssueText } from '../lib/server-port'

export function DashboardPage({ onCreate }: { onCreate: () => void }) {
  const [registered, setRegistered] = useState<LocalServerSummary[]>([])
  const [serverLoading, setServerLoading] = useState(true)
  const [serverError, setServerError] = useState<string | null>(null)
  const [recentEvents, setRecentEvents] = useState<ActivityItem[]>([])
  const [players, setPlayers] = useState<{ state: 'loading' | 'ready' | 'unavailable'; online: number | null; incomplete: boolean; pollIntervalMs: number }>({ state: 'loading', online: null, incomplete: false, pollIntervalMs: 15_000 })
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
  useEffect(() => { const controller = new AbortController(); void getActivity({ limit: 5 }, controller.signal).then((response) => setRecentEvents(response.events)).catch(() => undefined); return () => controller.abort() }, [])
  const running = registered.filter((server) => server.runtimeStatus === 'running').length
  const loadPlayerCount = useCallback(async (signal?: AbortSignal) => {
    try {
      const summary = await getDashboardPlayerSummary(signal)
      if (!signal?.aborted) setPlayers({ state: 'ready', online: summary.playersOnline, incomplete: !summary.complete, pollIntervalMs: summary.pollIntervalMs })
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setPlayers((current) => ({ ...current, state: 'unavailable', online: null, incomplete: true }))
    }
  }, [])
  useEffect(() => {
    if (serverLoading) return
    const controller = new AbortController()
    const refreshPlayers = () => { void loadPlayerCount(controller.signal) }
    const onLifecycleChange = () => { void loadServers(controller.signal); refreshPlayers() }
    refreshPlayers()
    const timer = window.setInterval(refreshPlayers, players.pollIntervalMs)
    window.addEventListener('mmsmanager:server-lifecycle', onLifecycleChange)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener('mmsmanager:server-lifecycle', onLifecycleChange)
    }
  }, [serverLoading, players.pollIntervalMs, loadPlayerCount, loadServers])
  const monitor = useMachineMonitor()
  const { storage } = useMachineStorage()
  const primaryVolume = primaryStorageVolume(storage)
  const managedCount = registered.filter((server) => server.managed && server.source === 'created').length
  const current = monitor.current
  const sample = current?.sample ?? null
  const timeZone = current?.timeZone ?? monitor.history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const connected = monitor.apiStatus === 'online' && current?.status === 'live'
  const today = new Intl.DateTimeFormat(currentLocale(), { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())
  return <div className="page-stack dashboard-page">
    <PageHeading eyebrow={today} title="Dashboard" description="Registered servers and current machine readings." />

    <div className="overview-strip" aria-label="Registered server summary and local CPU">
      <div className="overview-number"><span className="overview-icon"><Server size={17} /></span><div><span>Running servers</span><strong>{serverLoading || serverError ? '—' : running}<small> / {serverLoading || serverError ? '—' : registered.length} registered</small></strong></div></div>
      <div className="overview-number"><span className="overview-icon"><Users size={17} /></span><div><span>Players online</span><strong>{players.state !== 'ready' || players.online === null ? '—' : `${players.online.toLocaleString(currentLocale())}${players.incomplete ? '+' : ''}`}<small>{players.state !== 'ready' ? 'unavailable' : players.incomplete ? 'partial count' : players.online === 0 ? 'none online' : 'current count'}</small></strong></div></div>
      <div className="overview-number"><span className="overview-icon"><HardDrive size={17} /></span><div><span>Managed servers</span><strong>{serverLoading || serverError ? '—' : pluralCount(managedCount, currentLocale(), { en: ['instance', 'instances'], ru: ['сервер', 'сервера', 'серверов'] })}</strong></div></div>
      <div className="overview-number overview-machine-number"><span className="overview-icon"><Cpu size={17} /></span><div><span>Local CPU</span><strong>{formatPercent(sample?.cpuPercent ?? null)}<small>{connected ? 'current' : current?.status === 'stale' ? 'stale' : 'unavailable'}</small></strong></div><span className={`live-indicator ${connected ? 'connected' : ''}`} aria-label={connected ? 'Machine monitoring is current' : 'Machine monitoring is unavailable'} />
      </div>
    </div>

    <div className="dashboard-grid">
      <Card className="resource-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Cpu size={15} /> Machine resource history</div><h2>Resource activity</h2></div>{!connected && <Badge tone="warn">{monitor.apiStatus === 'offline' ? 'Offline' : current?.status === 'stale' ? 'Stale' : 'Collecting'}</Badge>}</div>
        <div className="resource-card-body live-resource-body"><LiveResourceChart points={mergeResourcePoints(monitor.history?.points ?? [], monitor.livePoints, 24 * 60 * 60_000)} metric="cpuPercent" label="CPU utilization" timeZone={timeZone} bucketSeconds={monitor.history?.bucketSeconds} coveragePercent={monitor.history?.coveragePercent} rangeLabel="24h" /><div className="resource-breakdown"><div className="breakdown-title">Latest sample</div>
          <MachineMetricTrack label="CPU" value={sample?.cpuPercent ?? null} detail={sample?.coreCount ?? current?.host?.coreCount ? pluralCount(sample?.coreCount ?? current?.host?.coreCount ?? 0, currentLocale(), { en: ['core', 'cores'], ru: ['ядро', 'ядра', 'ядер'] }) : '—'} tone="accent" />
          <MachineMetricTrack label="Memory" value={sample?.memory.usedPercent ?? null} detail={`${formatBytes(sample?.memory.usedBytes ?? null)} / ${formatBytes(sample?.memory.totalBytes ?? null)}`} tone="blue" />
          <MachineMetricTrack label={primaryVolume?.name ?? 'Server storage'} value={primaryVolume?.usedPercent ?? null} detail={primaryVolume ? `${formatBytes(primaryVolume.usedBytes)} / ${formatBytes(primaryVolume.totalBytes)}` : 'Volume reading unavailable'} tone="amber" />
        </div></div>
        <div className="resource-card-foot"><span><span className="legend-dot accent" />CPU utilization</span><span><span className="legend-dot muted" />Actual sample times</span><span className="source-note"><HardDrive size={13} />{sample ? <>Sampled {formatTimestamp(sample.collectedAt, timeZone)}</> : 'Waiting for local API'}</span></div>
      </Card>

      <Card className="fleet-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Server size={15} /> Servers</div><h2>Server status</h2></div><Link className="text-link" to="/servers">View all <ArrowRight size={14} /></Link></div>
        <div className="fleet-list">{serverLoading ? <div className="local-server-empty">Reading registered servers…</div> : serverError ? <div className="local-server-empty" role="status">{serverError} <button className="text-link" onClick={() => void loadServers()}>Retry</button></div> : registered.length ? registered.slice(0, 5).map((server) => <Link className="fleet-row" to={`/servers/${server.id}/overview`} key={server.id}>
          <span className="local-server-icon"><Server size={16} /></span>
          <span className="fleet-row-main"><strong data-no-translate>{server.name}</strong><small><span data-no-translate>{server.software}</span> · <span data-no-translate>{server.version ?? 'version unknown'}</span> · {server.source === 'imported' ? 'read only' : 'managed'}</small></span>
          <span className="fleet-row-right"><Badge tone={server.runtimeStatus === 'running' ? 'good' : server.runtimeStatus === 'error' || server.runtimeStatus === 'crashed' ? 'danger' : 'neutral'}>{server.runtimeStatus === 'external/unmanaged' ? 'Unmanaged' : server.runtimeStatus ?? 'Unavailable'}</Badge><small>{server.portStatus === 'valid' ? <>Game port {server.port}</> : translateText(serverPortIssueText(server.portErrorCode) ?? 'Port unknown', currentLocale())}</small></span>
        </Link>) : <div className="local-server-empty">No servers registered on this computer.</div>}</div>
        {isAdmin && <button className="fleet-create" onClick={onCreate}><span className="fleet-create-plus"><Plus size={12} aria-hidden="true" /></span><span>Create a local server</span><ArrowUpRight size={14} /></button>}
      </Card>

      <Card className="activity-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Wifi size={15} /> Server activity</div><h2>Recent events</h2></div><Link className="text-link" to="/activity">Activity log <ArrowRight size={14} /></Link></div>
        {recentEvents.length ? <div className="activity-row-list">{recentEvents.map((event) => <div className="activity-row" key={event.id}><span className={`activity-marker ${event.outcome === 'failure' ? 'marker-warn' : event.outcome === 'success' ? 'marker-good' : ''}`} /><div><strong>{event.title}</strong><small>{event.serverName ? <span data-no-translate>{event.serverName}</span> : event.category}</small></div><time>{new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(event.occurredAt))}</time></div>)}</div> : <div className="local-server-empty">No saved activity has been recorded yet.</div>}
      </Card>

      <Card className="machine-card">
        <div className="card-heading-row"><div><div className="card-kicker"><HardDrive size={15} /> Host</div><h2>Local machine</h2></div><Link className="text-link" to="/machine/history"><CalendarDays size={14} /> History</Link></div>
        <div className="machine-card-body"><div className="machine-name"><span className="machine-icon"><Cpu size={20} /></span><div><strong data-no-translate>{current?.host?.hostname ?? 'Waiting for host details'}</strong><span>{current?.host ? <><span data-no-translate>{current.host.distro ?? current.host.platform}</span> · <span data-no-translate>{current.host.architecture}</span></> : monitor.error ?? 'Waiting for first sample'}</span></div>{!connected && <span className="machine-connection"><i />{current?.status === 'stale' ? 'Stale' : 'Unavailable'}</span>}</div>
          <div className="machine-specs"><div><span>Processor</span><strong data-no-translate>{current?.host?.cpuModel ?? 'Unavailable'}</strong></div><div><span>Memory total</span><strong data-no-translate={sample ? '' : undefined}>{formatBytes(sample?.memory.totalBytes ?? null)}</strong></div><div><span>Network</span><strong data-no-translate>{sample?.network.interface ?? 'Unavailable'}</strong></div></div>
          <Link to="/machine" className="machine-link">View machine overview <ArrowRight size={14} /></Link>
        </div>
      </Card>
    </div>
    {monitor.apiStatus === 'offline' && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Machine readings are unavailable</strong></span><button className="button button-secondary" onClick={monitor.refreshNow}><RefreshCw size={14} /> Try again</button></div>}
  </div>
}

function MachineMetricTrack({ label, value, detail, tone }: { label: string; value: number | null; detail: string; tone: 'accent' | 'blue' | 'amber' }) {
  const displayedLabel = label === 'CPU' ? <span data-no-translate>{label}</span> : label === 'Memory' || label === 'Server storage' ? translateText(label, currentLocale()) : <span data-no-translate>{label}</span>
  const displayedDetail = translateText(detail, currentLocale())
  const detailNode = <span data-no-translate>{displayedDetail}</span>
  if (value === null) return <div className="metric-unavailable"><div className="metric-track-copy"><span>{displayedLabel}</span><strong>Unavailable</strong></div><p>{detailNode}</p></div>
  return <MetricTrack label={displayedLabel} value={Math.round(value)} detail={detailNode} tone={tone} />
}
