import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, Archive, ArrowRight, CalendarDays, ChevronRight, CircleHelp,
  Cpu, Database, FolderSearch, HardDrive, Layers3, MemoryStick, Monitor, Plus,
  RefreshCw, Search, Server, Wifi,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import type { LocalServerSummary, ServerBackup } from '@mmsmanager/shared'
import { MetricTrack } from '../components/charts'
import { Badge, Button, Card, DisabledButton, EmptyNote, PageHeading, SectionHeading } from '../components/ui'
import { useMachineMonitor } from '../state/use-machine-monitor'
import { LiveResourceChart } from '../components/live-chart'
import { formatBytes, formatPercent, formatRate, formatTimestamp } from '../lib/format'
import { getLocalServers, getServerBackups, getServerInventory } from '../api/servers'
import type { ServerInventory } from '@mmsmanager/shared'
import { useAuth } from '../state/use-auth'
import { ImportServerDialog } from '../components/import-server-dialog'
import { JavaInventoryCard } from '../components/java-inventory'
import { apiErrorMessage } from '../api/client'

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
      setLocalError(apiErrorMessage(error, 'The local server list could not be loaded.'))
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
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  return <div className="page-stack"><PageHeading title="Activity" description="Only events recorded from managed server processes are shown." />
    <Card><EmptyNote icon={Activity} title="No combined event feed yet" detail="A workspace-wide event feed is not connected. Verified process events remain available in managed server history." /><div className="empty-state-actions">{isAdmin ? <Link className="button button-secondary" to="/machine/history?source=all">Open server history <ArrowRight size={14} /></Link> : <Link className="button button-secondary" to="/servers">Open local servers <ArrowRight size={14} /></Link>}</div></Card>
  </div>
}

export function BackupsPage() {
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const [servers, setServers] = useState<LocalServerSummary[]>([])
  const [items, setItems] = useState<{ server: LocalServerSummary; backup: ServerBackup }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!isAdmin) { setLoading(false); return }
    setLoading(true)
    try {
      const registered = await getLocalServers(signal)
      const eligible = registered.filter((server) => server.source === 'created' && server.managed)
      const inventories = await Promise.all(eligible.map(async (server) => ({ server, inventory: await getServerBackups(server.id, signal) })))
      setServers(eligible)
      setItems(inventories.flatMap(({ server, inventory }) => inventory.items.map((backup) => ({ server, backup }))).sort((a, b) => b.backup.createdAt.localeCompare(a.backup.createdAt)))
      setError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(apiErrorMessage(issue, 'The local backup inventory could not be loaded.'))
    } finally { setLoading(false) }
  }, [isAdmin])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh, reloadKey])

  return <div className="page-stack"><PageHeading title="Backups" description="Verified snapshots from MMSManager-managed local servers." />
    {!isAdmin ? <Card><EmptyNote icon={Archive} title="Administrator access required" detail="Backup inventory is restricted because snapshots can contain private server data." /></Card>
      : error ? <div className="monitor-offline-banner" role="alert"><span><HardDrive size={16} /><strong>Local backup inventory unavailable</strong><small>{error}</small></span><Button icon={RefreshCw} onClick={() => setReloadKey((key) => key + 1)}>Retry</Button></div>
        : loading ? <Card><div className="local-server-empty"><span className="loading-pulse" /><span>Loading local backup inventory…</span></div></Card>
          : items.length === 0 ? <Card><EmptyNote icon={Archive} title={servers.length ? 'No backups saved yet' : 'No managed servers available'} detail={servers.length ? 'Create a verified snapshot from a managed server’s Backups tab. Imported folders are read only.' : 'Only servers created by MMSManager can be backed up. No sample records are shown here.'} />{servers[0] && <div className="empty-state-actions"><Link className="button button-secondary" to={`/servers/${servers[0].id}/backups`}>Open {servers[0].name} backups <ArrowRight size={14} /></Link></div>}</Card>
            : <Card className="data-table-card"><div className="table-title-row"><div><h2>Recent snapshots</h2><p>{items.length} retained records shown · backup inventory is local to this computer</p></div><Badge>{servers.length} managed {servers.length === 1 ? 'server' : 'servers'}</Badge></div><div className="local-backup-list">{items.map(({ server, backup }) => <article className="workspace-backup-row" key={`${server.id}-${backup.id}`}>
              <div className="local-backup-icon"><Archive size={15} /></div><div className="local-backup-row-main"><strong>{server.name} · {new Date(backup.createdAt).toLocaleString()}</strong><span>{formatBytes(backup.archiveSizeBytes)} archive · {backup.fileCount.toLocaleString()} files · {formatBytes(backup.totalFileBytes)} content</span><small>SHA-256 {backup.archiveSha256.slice(0, 16)}… · {backup.excludedCount ? `${backup.excludedCount} excluded paths` : 'no excluded paths'}</small></div><Badge tone={backup.origin === 'manual' ? 'good' : 'neutral'}>{backup.origin === 'scheduled' ? 'Scheduled' : backup.origin === 'system' ? 'Safety snapshot' : 'Manual'}</Badge><Link className="button button-secondary" to={`/servers/${server.id}/backups`}>Open server backups</Link>
            </article>)}</div></Card>}
  </div>
}

export function TemplatesPage() {
  return <div className="page-stack"><PageHeading title="Templates" description="No local template catalog is connected." actions={<DisabledButton icon={Layers3}>Browse templates</DisabledButton>} /><Card><EmptyNote icon={Layers3} title="No templates available" detail="The template gallery is a preview-only area. No template records or provider downloads are shown here." /></Card></div>
}

export { UsersPage, ProfilePage, SettingsPage } from './account-pages'

export function NotFoundPage() {
  return <div className="not-found"><div className="not-found-code">404</div><h1>Page not found</h1><p>This page is not part of the local workspace.</p><Link className="button button-secondary" to="/">Return to dashboard <ChevronRight size={15} /></Link></div>
}

export function DataSummary({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <div className="compact-summary"><span>{title}</span><strong>{value}</strong><small>{detail}</small></div>
}
