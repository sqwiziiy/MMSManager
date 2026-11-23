import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, Archive, ArrowDownToLine, ArrowRight, CalendarClock, CalendarDays, ChevronRight, CircleHelp,
  CloudDownload, Cpu, Database, FolderSearch, HardDrive, Layers3, MemoryStick, Monitor, Plus,
  RefreshCw, Search, Server, ShieldCheck, Wifi,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { activities, servers } from '../data'
import { MetricTrack, WorldBlocks } from '../components/charts'
import { Badge, Button, Card, ComingSoon, DisabledButton, PageHeading, PreviewFlag, SectionHeading, StatusDot } from '../components/ui'
import { useMachineMonitor } from '../state/use-machine-monitor'
import { LiveResourceChart } from '../components/live-chart'
import { formatBytes, formatPercent, formatRate, formatTimestamp } from '../lib/format'
import { getLocalServers, getServerInventory } from '../api/servers'
import type { LocalServerSummary, ServerInventory } from '@mmsmanager/shared'
import { useAuth } from '../state/use-auth'
import { ImportServerDialog } from '../components/import-server-dialog'
import { JavaInventoryCard } from '../components/java-inventory'

type ServerFilter = 'All servers' | 'Running' | 'Other'

export function ServersPage({ onCreate }: { onCreate: () => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ServerFilter>('All servers')
  const [localServers, setLocalServers] = useState<LocalServerSummary[]>([])
  const [inventory, setInventory] = useState<ServerInventory | null>(null)
  const [loadingLocal, setLoadingLocal] = useState(true)
  const [localError, setLocalError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const loadLocal = useCallback(async (signal?: AbortSignal) => {
    setLoadingLocal(true)
    try {
      const [items, details] = await Promise.all([
        getLocalServers(signal),
        isAdmin ? getServerInventory(signal) : Promise.resolve(null),
      ])
      setLocalServers(items)
      setInventory(details)
      setLocalError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setLocalError(error instanceof Error ? error.message : 'The local server list could not be loaded.')
    } finally {
      setLoadingLocal(false)
    }
  }, [isAdmin])
  useEffect(() => {
    const controller = new AbortController()
    void loadLocal(controller.signal)
    return () => controller.abort()
  }, [loadLocal])

  const localFiltered = useMemo(() => localServers.filter((server) => {
    const matchesStatus = filter === 'All servers' || (filter === 'Running' ? server.runtimeStatus === 'running' : server.runtimeStatus !== 'running')
    return matchesStatus && `${server.name} ${server.software} ${server.version ?? ''} ${server.port ?? ''}`.toLowerCase().includes(query.toLowerCase())
  }), [localServers, filter, query])
  return <div className="page-stack">
    <PageHeading title="Servers" description="Registered server folders on this computer." actions={isAdmin ? <><Button icon={Plus} onClick={onCreate}>Create server</Button><Button kind="primary" icon={FolderSearch} onClick={() => setImportOpen(true)}>Import existing</Button></> : undefined} />
    {localError && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Local server inventory unavailable</strong><small>{localError}</small></span><Button icon={RefreshCw} onClick={() => void loadLocal()}>Retry</Button></div>}
    <div className="list-toolbar"><div className="filter-tabs" role="tablist" aria-label="Filter servers">{(['All servers', 'Running', 'Other'] as const).map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item}<span>{item === 'All servers' ? localServers.length : item === 'Running' ? localServers.filter((server) => server.runtimeStatus === 'running').length : localServers.filter((server) => server.runtimeStatus !== 'running').length}</span></button>)}</div>
      <label className="inline-search"><Search size={15} /><input aria-label="Search servers" placeholder="Search servers" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    <section className="local-server-section" aria-labelledby="local-servers-title">
      <div className="section-heading"><div><div className="card-kicker"><Server size={14} /> Local registry</div><h2 id="local-servers-title">This computer</h2><p>Panel-created instances can be controlled here. Imported folders stay read only.</p></div><Badge tone={localServers.length ? 'good' : 'neutral'}>{loadingLocal ? 'Loading' : `${localServers.length} registered`}</Badge></div>
      {isAdmin && inventory && <div className="server-root-note"><span>Managed root <code>{inventory.managedRoot}</code></span><span>Import roots {inventory.importRoots.length ? inventory.importRoots.map((root) => <code key={root}>{root}</code>) : 'none configured'}</span></div>}
      {loadingLocal && !localServers.length ? <div className="local-server-empty"><span className="loading-pulse" /><span>Reading the local registry…</span></div> : localError ? null : localFiltered.length ? <div className="local-server-grid">{localFiltered.map((server) => {
        const details = inventory?.servers.find((item) => item.id === server.id)
        const runtimeStatus = server.runtimeStatus ?? 'stopped'
        const tone = runtimeStatus === 'running' ? 'good' : runtimeStatus === 'crashed' || runtimeStatus === 'error' ? 'danger' : runtimeStatus === 'external/unmanaged' ? 'warn' : 'neutral'
        return <Link className="local-server-card-link" to={`/servers/${server.id}/overview`} key={server.id}><Card className="local-server-card"><div className="local-server-card-header"><span className="local-server-icon"><Server size={17} /></span><div><strong>{server.name}</strong><small>{server.source === 'imported' ? 'Imported folder' : 'Created by MMSManager'}</small></div><Badge tone={tone}>{runtimeStatus === 'external/unmanaged' ? 'Unmanaged' : runtimeStatus[0]!.toUpperCase() + runtimeStatus.slice(1)}</Badge></div><div className="local-server-facts"><div><span>Software</span><strong>{server.software === 'unknown' ? 'Unknown' : `${server.software[0]!.toUpperCase()}${server.software.slice(1)}${server.version ? ` ${server.version}` : ''}`}</strong></div><div><span>Game port</span><strong>{server.port ?? 'Not detected'}</strong></div><div><span>Memory</span><strong>{server.minMemoryMb}–{server.maxMemoryMb} MB</strong></div><div><span>EULA</span><strong>{server.eula === 'accepted' ? 'Accepted' : server.eula === 'not-accepted' ? 'Not accepted' : 'Not found'}</strong></div></div>{server.worldFolders.length > 0 && <div className="local-server-worlds">Detected folders {server.worldFolders.join(' · ')}</div>}{isAdmin && details && <code className="local-server-path">{details.directory}</code>}<div className="local-server-card-footer"><span>{server.managed ? 'Local process controls available' : 'Imported · read only'}</span><span>Open details <ChevronRight size={13} /></span></div></Card></Link>
      })}</div> : <Card className="local-server-empty-card"><div className="empty-list"><FolderSearch size={20} /><strong>{localServers.length ? 'No servers match this filter' : 'No local servers registered'}</strong><span>{localServers.length ? 'Try another name or state.' : isAdmin ? 'Create a managed server or import a folder inside an allowed root.' : 'An administrator has not added a local server yet.'}</span></div></Card>}
    </section>
    {importOpen && inventory && <ImportServerDialog roots={inventory.importRoots} onClose={() => setImportOpen(false)} onImported={() => loadLocal()} />}
  </div>
}

export function MachinePage() {
  const monitor = useMachineMonitor()
  const current = monitor.current
  const sample = current?.sample ?? null
  const host = current?.host ?? null
  const timeZone = current?.timeZone ?? monitor.history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const connected = monitor.apiStatus === 'online' && current?.status === 'live'

  return <div className="page-stack">
    <PageHeading eyebrow={connected ? 'LIVE local telemetry' : current?.status === 'stale' ? 'Stale local telemetry' : 'Local telemetry unavailable'} title="Machine" description="Read-only metrics from the Linux computer running this backend." actions={<Link className="button button-secondary" to="/machine/history"><CalendarDays size={15} /> Machine history</Link>} />
    {monitor.apiStatus === 'offline' && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Local monitoring API is offline</strong><small>Previously saved values remain labeled stale; unavailable metrics are not replaced with samples.</small></span><Button icon={RefreshCw} onClick={monitor.refreshNow}>Retry connection</Button></div>}
    <div className="machine-hero"><div className="machine-hero-icon"><Monitor size={24} /></div><div className="machine-hero-copy"><div><h2>{host?.hostname ?? 'Waiting for local host details'}</h2><Badge tone={connected ? 'good' : current?.status === 'stale' ? 'warn' : 'neutral'}>{connected ? 'Live local machine' : current?.status === 'stale' ? 'Stale sample' : 'Collecting'}</Badge></div><p>{host ? `${host.distro ?? host.platform} ${host.release ?? ''} · ${host.architecture} · ${host.coreCount ?? '—'} logical cores` : monitor.error ?? 'The API will show host details after its first sample.'}</p></div><div className="machine-hero-state"><span>Last successful sample</span><strong>{formatTimestamp(current?.lastSuccessfulAt ?? null, timeZone)}</strong></div></div>
    <div className="overview-strip machine-overview-strip">
      <MachineOverviewNumber icon={Cpu} label="CPU utilization" value={formatPercent(sample?.cpuPercent ?? null)} detail={sample?.coreCount ? `${sample.coreCount} logical cores` : 'No CPU sample'} />
      <MachineOverviewNumber icon={MemoryStick} label="Memory used" value={formatBytes(sample?.memory.usedBytes ?? null)} detail={sample ? `${formatBytes(sample.memory.availableBytes)} available · ${formatBytes(sample.memory.totalBytes)} total` : 'No memory sample'} />
      <MachineOverviewNumber icon={HardDrive} label="Root filesystem" value={formatBytes(sample?.storage?.usedBytes ?? null)} detail={sample?.storage ? `${sample.storage.mount} · ${formatBytes(sample.storage.availableBytes)} available` : 'No root mount sample'} />
      <MachineOverviewNumber icon={Wifi} label="Network receive" value={formatRate(sample?.network.rxBytesPerSecond ?? null)} detail={sample?.network.interface ?? 'Default interface unavailable'} />
    </div>
    <div className="machine-page-grid"><Card className="machine-chart-card"><div className="card-heading-row"><div><div className="card-kicker"><Activity size={15} /> Persisted CPU samples</div><h2>Processor activity</h2></div><Badge tone={monitor.apiStatus === 'online' ? 'good' : 'warn'}>{monitor.apiStatus === 'online' ? 'Local API connected' : 'Offline'}</Badge></div><LiveResourceChart points={monitor.history?.points ?? []} metric="cpuPercent" label="CPU utilization" timeZone={timeZone} /></Card>
      <Card className="machine-resource-card"><div className="card-heading-row"><div><div className="card-kicker"><MemoryStick size={15} /> Memory and load</div><h2>Host resources</h2></div><Badge tone={connected ? 'good' : 'warn'}>{connected ? 'LIVE' : 'Unavailable'}</Badge></div><div className="resource-breakdown full">
        <MachineMetricTrack label="CPU" value={sample?.cpuPercent ?? null} detail={host?.cpuModel ?? 'CPU model unavailable'} tone="accent" />
        <MachineMetricTrack label="Memory" value={sample?.memory.usedPercent ?? null} detail={`${formatBytes(sample?.memory.usedBytes ?? null)} used · ${formatBytes(sample?.memory.availableBytes ?? null)} available`} tone="blue" />
        <MachineMetricTrack label="Storage" value={sample?.storage?.usedPercent ?? null} detail={sample?.storage ? `${sample.storage.device ?? sample.storage.mount} · ${formatBytes(sample.storage.totalBytes)}` : 'Root filesystem unavailable'} tone="amber" />
      </div><p className="data-note"><CircleHelp size={14} /> Linux memory used is total minus MemAvailable; reclaimable cache stays in available memory.</p>
      <div className="load-average-row"><span>System load average</span><strong>{sample?.loadAverage ? `${sample.loadAverage.one.toFixed(2)} · ${sample.loadAverage.five.toFixed(2)} · ${sample.loadAverage.fifteen.toFixed(2)}` : 'Unavailable'}</strong><small>1, 5 and 15 minutes; not a CPU percentage</small></div></Card></div>
    <div className="machine-page-grid lower">
      <Card><SectionHeading title="Root filesystem" description="One local mount is sampled to avoid counting volumes twice." /><div className="volume-row"><div className="volume-heading"><span className="volume-icon"><Database size={17} /></span><div><strong>{sample?.storage?.device ?? 'Root mount unavailable'}</strong><small>{sample?.storage?.mount ?? 'No root filesystem sample'} · local host</small></div><span className="volume-space">{formatBytes(sample?.storage?.usedBytes ?? null)} <small>of {formatBytes(sample?.storage?.totalBytes ?? null)}</small></span></div>{sample?.storage && <><div className="volume-track"><span style={{ width: `${Math.round(sample.storage.usedPercent ?? 0)}%` }} /></div><div className="volume-footer"><span>{formatPercent(sample.storage.usedPercent)} used</span><span>{formatBytes(sample.storage.availableBytes)} available</span></div></>}</div></Card>
      <Card><SectionHeading title="Network interface" description="Rates use sampled counters from the default interface." /><div className="network-detail-grid"><div><span>Interface</span><strong>{sample?.network.interface ?? 'Unavailable'}</strong></div><div><span>Receive</span><strong>{formatRate(sample?.network.rxBytesPerSecond ?? null)}</strong></div><div><span>Transmit</span><strong>{formatRate(sample?.network.txBytesPerSecond ?? null)}</strong></div><div><span>Sampled</span><strong>{formatTimestamp(sample?.collectedAt ?? null, timeZone)}</strong></div></div></Card>
    </div>
    <div className="machine-page-grid lower"><Card><SectionHeading title="Host summary" description="Collected from this local machine only." /><div className="machine-host-details"><div><span>Hostname</span><strong>{host?.hostname ?? 'Unavailable'}</strong></div><div><span>Operating system</span><strong>{host ? `${host.distro ?? host.platform} ${host.release ?? ''}` : 'Unavailable'}</strong></div><div><span>Architecture</span><strong>{host?.architecture ?? 'Unavailable'}</strong></div><div><span>CPU cores</span><strong>{host?.coreCount ?? 'Unavailable'}</strong></div><div><span>Uptime</span><strong>{host?.uptimeSeconds === null || host?.uptimeSeconds === undefined ? 'Unavailable' : `${Math.floor(host.uptimeSeconds / 3600)} h`}</strong></div><div><span>Data source</span><strong>Local system information</strong></div></div></Card>
      <JavaInventoryCard /></div>
  </div>
}

function MachineOverviewNumber({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail: string }) {
  return <div className="overview-number"><span className="overview-icon"><Icon size={17} /></span><div><span>{label}</span><strong>{value}<small>{detail}</small></strong></div></div>
}

function MachineMetricTrack({ label, value, detail, tone }: { label: string; value: number | null; detail: string; tone: 'accent' | 'blue' | 'amber' }) {
  if (value === null) return <div className="metric-unavailable"><div className="metric-track-copy"><span>{label}</span><strong>Unavailable</strong></div><p>{detail}</p></div>
  return <MetricTrack label={label} value={Math.round(value)} detail={detail} tone={tone} />
}

export function ActivityPage() {
  const [filter, setFilter] = useState<'All events' | 'Good' | 'Warnings'>('All events')
  const filtered = activities.filter((item) => filter === 'All events' || (filter === 'Good' ? item.tone === 'good' : item.tone === 'warn'))
  return <div className="page-stack"><PageHeading title="Activity" description="A readable history built from fictional sample events." actions={<PreviewFlag />} />
    <div className="list-toolbar"><div className="filter-tabs" role="tablist" aria-label="Filter activity">{(['All events', 'Good', 'Warnings'] as const).map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div><span className="table-count">{filtered.length} sample events</span></div>
    <Card className="activity-table-card"><div className="activity-table-header"><span>Event</span><span>Server</span><span>Details</span><span>Time</span></div>{filtered.map((item) => <div className="activity-table-row" key={item.id}><div className="activity-table-event"><span className={`activity-marker marker-${item.tone}`} /><strong>{item.event}</strong></div><span>{item.server}</span><span className="activity-detail-text">{item.detail}</span><time>{item.time}</time></div>)}</Card>
    <div className="list-footnote"><span className="footnote-dot" /> Activity is sample history and is not connected to server logs</div>
  </div>
}

const backupRows = [
  { server: 'Alder SMP', date: 'Today, 08:00', kind: 'Scheduled snapshot', size: '842 MB', state: 'Complete' },
  { server: 'Copper Grove', date: 'Today, 06:00', kind: 'Scheduled snapshot', size: '536 MB', state: 'Complete' },
  { server: 'Alder SMP', date: 'Yesterday, 08:00', kind: 'Scheduled snapshot', size: '831 MB', state: 'Complete' },
  { server: 'Test Dimension', date: 'Nov 21, 19:30', kind: 'Manual snapshot', size: '1.2 GB', state: 'Complete' },
]

export function BackupsPage() {
  return <div className="page-stack"><PageHeading title="Backups" description="Sample restore points for the visual prototype." actions={<DisabledButton icon={Plus}>Create backup</DisabledButton>} />
    <div className="overview-strip"><div className="overview-number"><span className="overview-icon"><Archive size={17} /></span><div><span>Sample snapshots</span><strong>14<small> shown in preview</small></strong></div></div><div className="overview-number"><span className="overview-icon"><HardDrive size={17} /></span><div><span>Combined size</span><strong>8.4<small> GB mock</small></strong></div></div><div className="overview-number"><span className="overview-icon"><CalendarClock size={17} /></span><div><span>Schedule</span><strong>Daily<small> preview</small></strong></div></div><div className="overview-number"><span className="overview-icon"><ShieldCheck size={17} /></span><div><span>Restore actions</span><strong>Preview<small> only</small></strong></div></div></div>
    <Card className="data-table-card"><div className="table-title-row"><div><h2>Recent snapshots</h2><p>Fictional records · nothing has been written to disk</p></div><Badge>Mock data</Badge></div><div className="data-table backup-table"><div className="data-table-head"><span>Server</span><span>Created</span><span>Type</span><span>Size</span><span>Status</span><span /></div>{backupRows.map((row, index) => <div className="data-table-row" key={`${row.server}-${index}`}><strong>{row.server}</strong><span>{row.date}</span><span>{row.kind}</span><span>{row.size}</span><Badge tone="good">{row.state}</Badge><Button disabled kind="quiet" icon={ArrowDownToLine}>Restore</Button></div>)}</div><div className="table-mobile-rows">{backupRows.map((row, index) => <div className="backup-mobile-row" key={`${row.server}-mobile-${index}`}><div><strong>{row.server}</strong><span>{row.date} · {row.size}</span></div><Badge tone="good">{row.state}</Badge><DisabledButton icon={ArrowDownToLine}>Restore</DisabledButton></div>)}</div></Card>
    <div className="preview-note"><Archive size={17} /><span><strong>Backup actions are not connected</strong><small>Scheduling, downloading and restoring will be added after local backend and safety work.</small></span><ComingSoon /></div>
  </div>
}

const templates = [
  { name: 'Survival community', type: 'Fabric', version: '1.21.4', tag: 'Lightweight', description: 'A small community world with performance basics and voice chat.' },
  { name: 'Paper essentials', type: 'Paper', version: '1.21.4', tag: 'Plugins', description: 'A focused plugin-ready base for a small public server.' },
  { name: 'Modded exploration', type: 'NeoForge', version: '1.20.1', tag: 'Modded', description: 'A sample modded profile with additional memory allocation.' },
]

export function TemplatesPage() {
  return <div className="page-stack"><PageHeading title="Templates" description="Starting points shown for browsing. Nothing will be downloaded." actions={<DisabledButton icon={CloudDownload}>Import template</DisabledButton>} /><div className="template-intro"><div><Layers3 size={17} /><span>Curated setup examples</span></div><p>Choose a software family and compare a possible setup. Template installation is not available in this preview.</p></div><div className="template-grid">{templates.map((template, index) => <Card className="template-card" key={template.name}><div className={`template-visual template-tone-${index}`}><div className="template-visual-grid">{Array.from({ length: 16 }, (_, cell) => <i key={cell} />)}</div><span className="template-visual-version">{template.version}</span></div><div className="template-card-copy"><div className="template-card-meta"><Badge>{template.type}</Badge><span>{template.tag}</span></div><h2>{template.name}</h2><p>{template.description}</p><div className="template-card-foot"><span>Preview profile</span><DisabledButton icon={ArrowRight}>View setup</DisabledButton></div></div></Card>)}</div><div className="list-footnote"><span className="footnote-dot" /> Example templates only · no provider catalog is connected</div></div>
}

export { UsersPage, ProfilePage, SettingsPage } from './account-pages'

export function NotFoundPage() {
  return <div className="not-found"><div className="not-found-code">404</div><h1>Page not found</h1><p>This preview route does not exist.</p><Link className="button button-secondary" to="/">Return to dashboard <ChevronRight size={15} /></Link></div>
}

export function DataSummary({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <div className="compact-summary"><span>{title}</span><strong>{value}</strong><small>{detail}</small></div>
}

export function SmallServerList() {
  return <div className="small-server-list">{servers.map((server) => <Link to={`/servers/${server.id}`} key={server.id}><WorldBlocks server={server} compact /><span><strong>{server.name}</strong><small>{server.software} · {server.version}</small></span><StatusDot status={server.status} /></Link>)}</div>
}
