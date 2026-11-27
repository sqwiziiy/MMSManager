import { currentLocale, translateText } from "../i18n/catalog"
import { serverPortIssueText } from '../lib/server-port'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { FormEvent } from 'react'
import {
  Activity, AlertTriangle, Archive, ArrowRight, CalendarDays, ChevronRight, CircleHelp,
  Cpu, Database, FolderSearch, HardDrive, MemoryStick, Monitor, Plus,
  RefreshCw, RotateCcw, Search, Server, Shield, Trash2, Users, Wifi,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import type { LocalServerSummary, MachineHistory, MachineResourcePoint, ServerBackup, ServerRemovalOperation, UnregisteredServer } from '@mmsmanager/shared'
import type { ActivityCategory, ActivityItem } from '@mmsmanager/shared'
import { MetricTrack } from '../components/charts'
import { Badge, Button, Card, EmptyNote, Field, PageHeading, SectionHeading } from '../components/ui'
import { useMachineMonitor } from '../state/use-machine-monitor'
import { primaryStorageVolume, useMachineStorage } from '../state/use-machine-storage'
import { LiveResourceChart } from '../components/live-chart'
import { mergeResourcePoints } from '../lib/resource-points'
import { formatBytes, formatPercent, formatRate, formatTimestamp } from '../lib/format'
import { discardUnregisteredRegistration, getLocalServers, getServerBackups, getServerInventory, getServerRemovalHistory, getUnregisteredServers, restoreUnregisteredServer, retryServerRemoval } from '../api/servers'
import { getMachineHistory } from '../api/machine'
import type { ServerInventory } from '@mmsmanager/shared'
import { useAuth } from '../state/use-auth'
import { ImportServerDialog } from '../components/import-server-dialog'
import { SoftwareIdentity } from '../components/software-identity'
import { JavaInventoryCard } from '../components/java-inventory'
import { ApiRequestError, apiErrorMessage } from '../api/client'
import { getActivity } from '../api/activity'

type ServerFilter = 'All servers' | 'Running' | 'Other'

export function ServersPage({ onCreate }: { onCreate: () => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ServerFilter>('All servers')
  const [localServers, setLocalServers] = useState<LocalServerSummary[]>([])
  const [inventory, setInventory] = useState<ServerInventory | null>(null)
  const [loadingLocal, setLoadingLocal] = useState(true)
  const [localError, setLocalError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [removalHistory, setRemovalHistory] = useState<ServerRemovalOperation[]>([])
  const [unregisteredServers, setUnregisteredServers] = useState<UnregisteredServer[]>([])
  const [unregisteredError, setUnregisteredError] = useState<string | null>(null)
  const [restoringServerId, setRestoringServerId] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [discardingRegistration, setDiscardingRegistration] = useState<UnregisteredServer | null>(null)
  const [discardConfirmation, setDiscardConfirmation] = useState('')
  const [discardError, setDiscardError] = useState<string | null>(null)
  const [discardBusy, setDiscardBusy] = useState(false)
  const [retryingRemoval, setRetryingRemoval] = useState<ServerRemovalOperation | null>(null)
  const [retryConfirmation, setRetryConfirmation] = useState('')
  const [retryError, setRetryError] = useState<string | null>(null)
  const [retryBusy, setRetryBusy] = useState(false)
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
  const loadUnregistered = useCallback(async (signal?: AbortSignal) => {
    try {
      setUnregisteredServers(await getUnregisteredServers(signal))
      setUnregisteredError(null)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setUnregisteredError(apiErrorMessage(error, 'The unregistered server list could not be loaded.'))
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void loadLocal(controller.signal)
    return () => controller.abort()
  }, [loadLocal])
  useEffect(() => {
    if (!isAdmin) { setRemovalHistory([]); return }
    const controller = new AbortController()
    void getServerRemovalHistory(controller.signal).then(setRemovalHistory).catch(() => undefined)
    return () => controller.abort()
  }, [isAdmin])
  useEffect(() => {
    if (!isAdmin) { setUnregisteredServers([]); setUnregisteredError(null); return }
    const controller = new AbortController()
    void loadUnregistered(controller.signal)
    return () => controller.abort()
  }, [isAdmin, loadUnregistered])

  const restoreRegistration = async (server: UnregisteredServer) => {
    setRestoringServerId(server.id)
    setRestoreError(null)
    try {
      await restoreUnregisteredServer(server.id)
      await Promise.all([loadLocal(), loadUnregistered()])
    } catch (error) { setRestoreError(apiErrorMessage(error, 'The server could not be restored to the registered list.')) }
    finally { setRestoringServerId(null) }
  }

  const discardRegistration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!discardingRegistration || discardConfirmation !== discardingRegistration.name || discardBusy) return
    setDiscardBusy(true); setDiscardError(null)
    try {
      await discardUnregisteredRegistration(discardingRegistration.id, discardConfirmation)
      await loadUnregistered()
      setDiscardingRegistration(null); setDiscardConfirmation('')
    } catch (error) { setDiscardError(apiErrorMessage(error, 'The registration could not be removed from the restoration list.')) }
    finally { setDiscardBusy(false) }
  }

  const retryRemoval = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!retryingRemoval || retryConfirmation !== retryingRemoval.serverName) return
    setRetryBusy(true)
    setRetryError(null)
    try {
      await retryServerRemoval(retryingRemoval.id, retryConfirmation)
      const latest = await getServerRemovalHistory()
      setRemovalHistory(latest)
      setRetryingRemoval(null)
      setRetryConfirmation('')
      await loadLocal()
    } catch (error) { setRetryError(error instanceof Error ? translateText(error.message, currentLocale()) : translateText('The server removal could not be retried.', currentLocale())) }
    finally { setRetryBusy(false) }
  }

  const localFiltered = useMemo(() => localServers.filter((server) => {
    const matchesStatus = filter === 'All servers' || (filter === 'Running' ? server.runtimeStatus === 'running' : server.runtimeStatus !== 'running')
    return matchesStatus && `${server.name} ${server.software} ${server.version ?? ''} ${server.port ?? ''}`.toLowerCase().includes(query.toLowerCase())
  }), [localServers, filter, query])
  return <div className="page-stack">
    <PageHeading title="Servers" actions={isAdmin ? <div className="servers-page-actions"><Button icon={Plus} onClick={onCreate}>Create server</Button><Button kind="primary" icon={FolderSearch} onClick={() => setImportOpen(true)}>Import from ZIP</Button></div> : undefined} />
    {localError && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Local server inventory unavailable</strong><small>{localError}</small></span><Button icon={RefreshCw} onClick={() => void loadLocal()}>Retry</Button></div>}
    <div className="list-toolbar"><div className="filter-tabs" role="tablist" aria-label="Filter servers">{(['All servers', 'Running', 'Other'] as const).map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item}<span>{item === 'All servers' ? localServers.length : item === 'Running' ? localServers.filter((server) => server.runtimeStatus === 'running').length : localServers.filter((server) => server.runtimeStatus !== 'running').length}</span></button>)}</div>
      <label className="inline-search"><Search size={15} /><input aria-label="Search servers" placeholder="Search servers" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    <section className="local-server-section" aria-labelledby="local-servers-title">
      <div className="section-heading"><div><h2 id="local-servers-title">Registered servers</h2></div><Badge tone={localServers.length ? 'good' : 'neutral'}>{loadingLocal ? 'Loading' : `${localServers.length} registered`}</Badge></div>
      {loadingLocal && !localServers.length ? <div className="local-server-empty"><span className="loading-pulse" /><span>Reading the local registry…</span></div> : localError ? null : localFiltered.length ? <div className="local-server-grid">{localFiltered.map((server) => {
        const runtimeStatus = server.runtimeStatus ?? 'stopped'
        const tone = runtimeStatus === 'running' ? 'good' : runtimeStatus === 'crashed' || runtimeStatus === 'error' ? 'danger' : runtimeStatus === 'external/unmanaged' ? 'warn' : 'neutral'
        const portText = server.portStatus === 'valid' ? String(server.port) : translateText(serverPortIssueText(server.portErrorCode) ?? 'Not detected', currentLocale())
        return <Link className="local-server-card-link" to={`/servers/${server.id}/overview`} key={server.id}><Card className="local-server-card"><div className="local-server-card-header"><span className="local-server-icon"><Server size={17} /></span><div><strong data-no-translate>{server.name}</strong><small>{server.source === 'imported' ? 'Imported folder' : 'Created by MMSManager'}</small></div><Badge tone={tone}>{runtimeStatus === 'external/unmanaged' ? 'Unmanaged' : runtimeStatus[0]!.toUpperCase() + runtimeStatus.slice(1)}</Badge></div><div className="local-server-facts"><div><span>Software</span><strong>{server.software === 'unknown' ? translateText('Unknown', currentLocale()) : <SoftwareIdentity software={server.software} version={server.version} />}</strong></div><div><span>Game port</span><strong>{portText}</strong></div><div><span>Memory</span><strong><span data-no-translate>{server.minMemoryMb}–{server.maxMemoryMb}</span> MB</strong></div><div><span>EULA</span><strong>{server.eula === 'accepted' ? 'Accepted' : server.eula === 'not-accepted' ? 'Not accepted' : 'Not found'}</strong></div></div>{server.worldFolders.length > 0 && <div className="local-server-worlds" data-no-translate>Detected folders {server.worldFolders.join(' · ')}</div>}<div className="local-server-card-footer"><span>{server.managed ? 'Process controls available' : 'Imported · read only'}</span><span>Open details <ChevronRight size={13} /></span></div></Card></Link>
      })}</div> : <Card className="local-server-empty-card"><div className="empty-list"><FolderSearch size={20} /><strong>{localServers.length ? 'No servers match this filter' : 'No local servers registered'}</strong><span>{localServers.length ? 'Try another name or state.' : isAdmin ? 'Create a managed server or import a folder inside an allowed root.' : 'An administrator has not added a local server yet.'}</span></div></Card>}
    </section>
    {isAdmin && <section className="unregistered-servers-section" aria-labelledby="unregistered-servers-title">
      <div className="section-heading"><div><h2 id="unregistered-servers-title">{translateText('Unregistered servers', currentLocale())}</h2><p>{translateText('Server folders kept when their registration was removed.', currentLocale())}</p></div><Badge>{unregisteredServers.length}</Badge></div>
      {(restoreError || discardError) && <div className="local-backup-message is-error" role="alert"><AlertTriangle size={15} /><span>{restoreError ?? discardError}</span></div>}
      {unregisteredError && <div className="local-backup-message is-error" role="alert"><AlertTriangle size={15} /><span>{unregisteredError}</span><Button icon={RefreshCw} onClick={() => void loadUnregistered()}>{translateText('Retry', currentLocale())}</Button></div>}
      {!unregisteredError && (unregisteredServers.length === 0 ? <Card className="local-server-empty-card"><div className="empty-list"><Archive size={20} /><strong>{translateText('No unregistered servers', currentLocale())}</strong><span>{translateText('Servers unregistered with their files kept will appear here.', currentLocale())}</span></div></Card> : <div className="unregistered-server-list">{unregisteredServers.map((server) => <Card className="unregistered-server-row" key={server.id}>
        <span className="local-server-icon"><Server size={16} /></span><div className="unregistered-server-copy"><strong data-no-translate>{server.name}</strong><span>{server.version ? <>{translateText('Minecraft', currentLocale())} <span data-no-translate>{server.version}</span></> : translateText('Version unavailable', currentLocale())}</span><small>{translateText('Unregistered', currentLocale())} · {new Date(server.removedAt).toLocaleString(currentLocale())}</small></div>
        {server.restoreBlockedReason && <Badge tone="warn">{translateText(server.restoreBlockedReason === 'folder-missing' ? 'Original folder missing' : server.restoreBlockedReason === 'folder-conflict' ? 'Folder is already registered' : 'Original folder is not safe to restore', currentLocale())}</Badge>}
        <div className="unregistered-server-actions"><Button kind="primary" icon={restoringServerId === server.id ? RefreshCw : RotateCcw} disabled={Boolean(restoringServerId || discardingRegistration) || Boolean(server.restoreBlockedReason)} title={server.restoreBlockedReason ? translateText(server.restoreBlockedReason === 'folder-missing' ? 'Original folder missing' : server.restoreBlockedReason === 'folder-conflict' ? 'Folder is already registered' : 'Original folder is not safe to restore', currentLocale()) : undefined} onClick={() => void restoreRegistration(server)}>{restoringServerId === server.id ? translateText('Restoring', currentLocale()) : translateText('Restore', currentLocale())}</Button>
          <Button kind="danger" icon={Trash2} disabled={Boolean(restoringServerId || discardingRegistration)} onClick={() => { setDiscardingRegistration(server); setDiscardConfirmation(''); setDiscardError(null) }}>{translateText('Delete registration', currentLocale())}</Button></div>
      </Card>)}</div>)}
    </section>}
    {isAdmin && removalHistory.length > 0 && <section className="server-removal-history" aria-labelledby="server-removal-history-title">
      <details><summary id="server-removal-history-title">{translateText('Removed server history', currentLocale())}<Badge>{removalHistory.length}</Badge></summary>
        <div className="server-removal-history-list">{removalHistory.map((item) => <article className="server-removal-history-row" key={item.id}>
          <div><strong data-no-translate>{item.serverName}</strong><span>{translateText(item.mode === 'unregister' ? 'Unregistered · files kept' : item.state === 'purged' ? 'Permanent deletion completed' : item.state === 'recovery-required' ? 'Recovery needed' : item.state === 'failed' ? 'Removal failed' : 'Permanent deletion pending', currentLocale())}</span>
            <small>{new Date(item.updatedAt).toLocaleString(currentLocale())}{item.errorMessage ? ` · ${translateText(item.errorMessage, currentLocale())}` : ''}</small></div>
          {item.mode === 'permanent' && ['failed', 'recovery-required'].includes(item.state) && <Button kind="secondary" onClick={() => { setRetryingRemoval(item); setRetryConfirmation(''); setRetryError(null) }}>{translateText('Retry cleanup', currentLocale())}</Button>}
        </article>)}</div>
      </details>
    </section>}
    {importOpen && inventory && <ImportServerDialog roots={inventory.importRoots} onClose={() => setImportOpen(false)} onImported={() => loadLocal()} />}
    {retryingRemoval && <div className="overlay-scrim"><section className="local-file-dialog server-removal-dialog" role="dialog" aria-modal="true" aria-labelledby="server-removal-retry-title">
      <div className="local-file-dialog-heading"><span className="server-removal-dialog-icon"><AlertTriangle size={17} /></span><div><h3 id="server-removal-retry-title">{translateText('Retry permanent cleanup', currentLocale())}</h3>
        <p>{retryingRemoval.errorMessage ? translateText(retryingRemoval.errorMessage, currentLocale()) : translateText('A previous deletion stopped before cleanup completed.', currentLocale())}</p></div></div>
      <form onSubmit={(event) => void retryRemoval(event)}><Field label={`${translateText('Type the exact server name to confirm', currentLocale())}: ${retryingRemoval.serverName}`}><input autoFocus value={retryConfirmation} onChange={(event) => setRetryConfirmation(event.target.value)} /></Field>
        {retryError && <p className="server-import-error" role="alert">{retryError}</p>}
        <div className="local-file-dialog-actions"><Button type="button" disabled={retryBusy} onClick={() => setRetryingRemoval(null)}>{translateText('Cancel', currentLocale())}</Button>
          <Button kind="danger" icon={retryBusy ? RefreshCw : Archive} disabled={retryBusy || retryConfirmation !== retryingRemoval.serverName}>{retryBusy ? translateText('Retrying', currentLocale()) : translateText('Retry cleanup', currentLocale())}</Button>
        </div>
      </form>
    </section></div>}
    {discardingRegistration && <div className="overlay-scrim"><section className="local-file-dialog server-removal-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-registration-title">
      <div className="local-file-dialog-heading"><span className="server-removal-dialog-icon"><Trash2 size={17} /></span><div><h3 id="discard-registration-title">{translateText('Delete registration', currentLocale())}</h3><p>{translateText('This removes the saved registration from the restore list. Server files, backups, history and audit records are kept.', currentLocale())}</p></div></div>
      <form onSubmit={(event) => void discardRegistration(event)}><Field label={`${translateText('Type the exact server name to confirm', currentLocale())}: ${discardingRegistration.name}`}><input autoFocus value={discardConfirmation} onChange={(event) => setDiscardConfirmation(event.target.value)} /></Field>
        {discardError && <p className="server-import-error" role="alert">{discardError}</p>}
        <div className="local-file-dialog-actions"><Button type="button" disabled={discardBusy} onClick={() => { setDiscardingRegistration(null); setDiscardError(null) }}>{translateText('Cancel', currentLocale())}</Button><Button kind="danger" icon={discardBusy ? RefreshCw : Trash2} disabled={discardBusy || discardConfirmation !== discardingRegistration.name}>{discardBusy ? translateText('Deleting registration…', currentLocale()) : translateText('Delete registration', currentLocale())}</Button></div>
      </form>
    </section></div>}
  </div>
}

export function MachinePage() {
  const monitor = useMachineMonitor()
  const { storage } = useMachineStorage()
  const primaryVolume = primaryStorageVolume(storage)
  const [historyRange, setHistoryRange] = useState<'15m' | '1h' | '24h' | '7d'>(() => {
    const saved = window.localStorage.getItem('mmsmanager.machineHistoryRange')
    return saved === '15m' || saved === '1h' || saved === '7d' ? saved : '24h'
  })
  const [selectedHistory, setSelectedHistory] = useState<MachineHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  useEffect(() => { window.localStorage.setItem('mmsmanager.machineHistoryRange', historyRange) }, [historyRange])
  useEffect(() => {
    if (historyRange === '24h') { setSelectedHistory(null); setHistoryError(null); return }
    let active = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      setHistoryLoading(true)
      const now = Date.now()
      const duration = historyRange === '15m' ? 15 * 60_000 : historyRange === '1h' ? 60 * 60_000 : 7 * 24 * 60 * 60_000
      try {
        const result = await getMachineHistory(new Date(now - duration), new Date(now), 500)
        if (active) { setSelectedHistory(result); setHistoryError(null) }
      } catch {
        if (active) setHistoryError('This history range could not be refreshed. Showing the last saved readings.')
      } finally {
        inFlight = false
        if (active) setHistoryLoading(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [historyRange])
  const current = monitor.current
  const sample = current?.sample ?? null
  const host = current?.host ?? null
  const timeZone = current?.timeZone ?? monitor.history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const connected = monitor.apiStatus === 'online' && current?.status === 'live'
  const chartHistory = historyRange === '24h' ? monitor.history : selectedHistory ?? monitor.history
  const selectedRangeMs = historyRange === '15m' ? 15 * 60_000 : historyRange === '1h' ? 60 * 60_000 : historyRange === '24h' ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000
  const chartPoints = mergeResourcePoints(chartHistory?.points ?? [], monitor.livePoints, selectedRangeMs)
  const primaryVolumeHistory = storage?.history.find((item) => item.volumeId === primaryVolume?.id)
  const storageChartPoints = useMemo<MachineResourcePoint[]>(() => (primaryVolumeHistory?.points ?? []).map((point) => ({
    observedAt: point.collectedAt,
    sampleCount: 1,
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    memoryPercent: null,
    storageUsedBytes: point.usedBytes,
    storageTotalBytes: point.totalBytes,
    storagePercent: point.usedPercent,
    rxBytesPerSecond: null,
    txBytesPerSecond: null,
  })), [primaryVolumeHistory])
  const storageBucketSeconds = useMemo(() => {
    const steps = storageChartPoints.slice(1).map((point, index) => Date.parse(point.observedAt) - Date.parse(storageChartPoints[index]!.observedAt)).filter((step) => step > 0).sort((left, right) => left - right)
    const middle = steps[Math.floor(steps.length / 2)]
    return middle ? Math.max(10, Math.round(middle / 1000)) : 30
  }, [storageChartPoints])

  return <div className="page-stack">
    <PageHeading eyebrow={!connected ? current?.status === 'stale' ? 'Stale measurements' : 'Monitoring unavailable' : undefined} title="Machine" description="Host resources and recent measurements." actions={<Link className="button button-secondary" to="/machine/history"><CalendarDays size={15} /> Machine history</Link>} />
    {monitor.apiStatus === 'offline' && <div className="monitor-offline-banner" role="status"><span><Wifi size={16} /><strong>Machine readings are unavailable</strong><small>Saved readings are marked out of date.</small></span><Button icon={RefreshCw} onClick={monitor.refreshNow}>Try again</Button></div>}
    <div className="machine-hero"><div className="machine-hero-icon"><Monitor size={24} /></div><div className="machine-hero-copy"><div><h2 data-no-translate={host?.hostname ? '' : undefined}>{host?.hostname ?? 'Waiting for host details'}</h2>{!connected && <Badge tone={current?.status === 'stale' ? 'warn' : 'neutral'}>{current?.status === 'stale' ? 'Stale sample' : 'Collecting'}</Badge>}</div><p>{host ? <><span data-no-translate>{`${host.distro ?? host.platform} ${host.release ?? ''} · ${host.architecture}`}</span> · {translateText(`${host.coreCount ?? '—'} logical cores`, currentLocale())}</> : monitor.error ?? 'Host details will appear after the first reading.'}</p></div><div className="machine-hero-state"><span>Last successful sample</span><strong data-no-translate>{formatTimestamp(current?.lastSuccessfulAt ?? null, timeZone)}</strong></div></div>
    <div className="overview-strip machine-overview-strip">
      <MachineOverviewNumber icon={Cpu} label="CPU utilization" value={formatPercent(sample?.cpuPercent ?? null)} detail={sample?.coreCount ? translateText(`${sample.coreCount} logical cores`, currentLocale()) : translateText('No CPU sample', currentLocale())} />
      <MachineOverviewNumber icon={MemoryStick} label="Memory used" value={formatBytes(sample?.memory.usedBytes ?? null)} detail={sample ? <><span data-no-translate>{formatBytes(sample.memory.availableBytes)}</span> {translateText('available', currentLocale())} · <span data-no-translate>{formatBytes(sample.memory.totalBytes)}</span> {translateText('total', currentLocale())}</> : translateText('No memory sample', currentLocale())} />
      <MachineOverviewNumber icon={HardDrive} label={primaryVolume?.name ?? 'Server storage'} value={formatBytes(primaryVolume?.usedBytes ?? null)} detail={primaryVolume ? <><span data-no-translate>{formatBytes(primaryVolume.availableBytes)}</span> {translateText('available', currentLocale())}</> : translateText('No volume reading', currentLocale())} />
      <MachineOverviewNumber icon={Wifi} label="Network receive" value={formatRate(sample?.network.rxBytesPerSecond ?? null)} detail={sample?.network.interface ? <span data-no-translate>{sample.network.interface}</span> : translateText('Default interface unavailable', currentLocale())} />
    </div>
    <div className="machine-page-grid"><Card className="machine-chart-card"><div className="card-heading-row"><div><div className="card-kicker"><Activity size={15} /> Saved measurements</div><h2>Processor activity</h2></div><div className="history-chart-actions"><div className="history-range-controls" role="group" aria-label={translateText('History range', currentLocale())}>{(['15m', '1h', '24h', '7d'] as const).map((range) => <button key={range} type="button" aria-pressed={historyRange === range} className={historyRange === range ? 'selected' : ''} onClick={() => setHistoryRange(range)}>{translateText(range, currentLocale())}</button>)}</div>{historyLoading && <span className="history-range-loading" role="status">Updating</span>}{monitor.apiStatus !== 'online' && <Badge tone="warn">Offline</Badge>}</div></div>{historyError && <div className="history-range-error" role="status">{historyError}</div>}<LiveResourceChart points={chartPoints} metric="cpuPercent" label="CPU utilization" timeZone={timeZone} bucketSeconds={chartHistory?.bucketSeconds} coveragePercent={chartHistory?.coveragePercent} rangeLabel={historyRange} /></Card>
      <Card className="machine-resource-card"><div className="card-heading-row"><div><div className="card-kicker"><MemoryStick size={15} /> Memory and load</div><h2>Host resources</h2></div>{!connected && <Badge tone="warn">Unavailable</Badge>}</div><div className="resource-breakdown full">
        <MachineMetricTrack label={<span data-no-translate>CPU</span>} value={sample?.cpuPercent ?? null} detail={host?.cpuModel ? <span data-no-translate>{host.cpuModel}</span> : translateText('CPU model unavailable', currentLocale())} tone="accent" />
        <MachineMetricTrack label="Memory" value={sample?.memory.usedPercent ?? null} detail={<><span data-no-translate>{formatBytes(sample?.memory.usedBytes ?? null)}</span> {translateText('used', currentLocale())} · <span data-no-translate>{formatBytes(sample?.memory.availableBytes ?? null)}</span> {translateText('available', currentLocale())}</>} tone="blue" />
      <MachineMetricTrack label={primaryVolume?.name ? <span data-no-translate>{primaryVolume.name}</span> : 'Storage'} value={primaryVolume?.usedPercent ?? null} detail={primaryVolume ? <><span data-no-translate>{formatBytes(primaryVolume.usedBytes)}</span> {translateText('of', currentLocale())} <span data-no-translate>{formatBytes(primaryVolume.totalBytes)}</span></> : translateText('Volume reading unavailable', currentLocale())} tone="amber" />
      </div><p className="data-note"><CircleHelp size={14} /> Linux memory used is total minus MemAvailable; reclaimable cache stays in available memory.</p>
      <div className="load-average-row"><span>System load average</span><strong>{sample?.loadAverage ? `${sample.loadAverage.one.toFixed(2)} · ${sample.loadAverage.five.toFixed(2)} · ${sample.loadAverage.fifteen.toFixed(2)}` : 'Unavailable'}</strong><small>1, 5 and 15 minutes; not a CPU percentage</small></div></Card></div>
    <div className="machine-page-grid lower">
      <Card>
        <SectionHeading title="Storage volumes" description={`Local file systems used by the application and server data. Readings are saved for up to ${storage?.historyRetentionDays ?? 30} days.`} />
        {storage?.volumes.length ? (
          <div className="storage-volume-list">
            {storage.volumes.map((volume) => (
              <div className="volume-row" key={volume.id}>
                <div className="volume-heading">
                  <span className="volume-icon"><Database size={17} /></span>
                  <div>
                    <strong data-no-translate>{volume.name}</strong>
                    <small>{volume.roles.map((role) => translateText(role === 'application-data' ? 'Application data' : role === 'server-data' ? 'Server data' : role === 'system' ? 'System' : role === 'home' ? 'Home' : 'Local', currentLocale())).join(' · ')} · {translateText('measured', currentLocale())} <span data-no-translate>{formatTimestamp(volume.collectedAt, timeZone)}</span></small>
                  </div>
                  <span className="volume-space"><span data-no-translate>{formatBytes(volume.usedBytes)}</span> <small>{translateText('of', currentLocale())} <span data-no-translate>{formatBytes(volume.totalBytes)}</span></small></span>
                </div>
                {volume.usedPercent !== null && <>
                  <div className="volume-track"><span style={{ width: `${Math.round(volume.usedPercent)}%` }} /></div>
                  <div className="volume-footer"><span><span data-no-translate>{formatPercent(volume.usedPercent)}</span> {translateText('used', currentLocale())}</span><span><span data-no-translate>{formatBytes(volume.availableBytes)}</span> {translateText('available', currentLocale())}</span></div>
                </>}
              </div>
            ))}
          </div>
        ) : <div className="local-server-empty">{translateText(storage ? 'No local volume readings are available.' : 'Local volume readings are unavailable.', currentLocale())}</div>}
        {primaryVolumeHistory && <div className="storage-history-panel">
          <div className="card-heading-row"><div><div className="card-kicker"><Activity size={15} /> Saved volume readings</div><h3>{primaryVolumeHistory.name} · last 24 hours</h3></div><Badge tone="neutral">SQLite history</Badge></div>
          {storageChartPoints.length > 1
            ? <LiveResourceChart points={storageChartPoints} metric="storagePercent" label="Space used" timeZone={timeZone} bucketSeconds={storageBucketSeconds} rangeLabel="24h" />
            : <div className="local-server-empty">Saved volume history will appear as measurements accumulate.</div>}
        </div>}
      </Card>
      <Card><SectionHeading title="Network interface" description="Rates use sampled counters from the default interface." /><div className="network-detail-grid"><div><span>Interface</span><strong data-no-translate>{sample?.network.interface ?? 'Unavailable'}</strong></div><div><span>Receive</span><strong data-no-translate>{formatRate(sample?.network.rxBytesPerSecond ?? null)}</strong></div><div><span>Transmit</span><strong data-no-translate>{formatRate(sample?.network.txBytesPerSecond ?? null)}</strong></div><div><span>Sampled</span><strong data-no-translate>{formatTimestamp(sample?.collectedAt ?? null, timeZone)}</strong></div></div></Card>
    </div>
    <div className="machine-page-grid lower"><Card><SectionHeading title="Host summary" /><div className="machine-host-details"><div><span>Hostname</span><strong data-no-translate={host?.hostname ? '' : undefined}>{host?.hostname ?? 'Unavailable'}</strong></div><div><span>Operating system</span><strong data-no-translate={host ? '' : undefined}>{host ? `${host.distro ?? host.platform} ${host.release ?? ''}` : 'Unavailable'}</strong></div><div><span>Architecture</span><strong data-no-translate={host?.architecture ? '' : undefined}>{host?.architecture ?? 'Unavailable'}</strong></div><div><span>CPU cores</span><strong data-no-translate={host?.coreCount !== null && host?.coreCount !== undefined ? '' : undefined}>{host?.coreCount ?? 'Unavailable'}</strong></div><div><span>Uptime</span><strong data-no-translate={host?.uptimeSeconds !== null && host?.uptimeSeconds !== undefined ? '' : undefined}>{host?.uptimeSeconds === null || host?.uptimeSeconds === undefined ? 'Unavailable' : `${Math.floor(host.uptimeSeconds / 3600)} h`}</strong></div></div></Card>
      <JavaInventoryCard /></div>
  </div>
}

function MachineOverviewNumber({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail: ReactNode }) {
  const localizedLabel = label === 'Server storage' ? translateText(label, currentLocale()) : label
  const displayValue = value === 'Unavailable' ? translateText(value, currentLocale()) : value
  return <div className="overview-number"><span className="overview-icon"><Icon size={17} /></span><div><span data-no-translate={label === 'Server storage' ? undefined : ''}>{localizedLabel}</span><strong><span data-no-translate={value === 'Unavailable' ? undefined : ''}>{displayValue}</span><small>{detail}</small></strong></div></div>
}

function MachineMetricTrack({ label, value, detail, tone }: { label: ReactNode; value: number | null; detail: ReactNode; tone: 'accent' | 'blue' | 'amber' }) {
  if (value === null) return <div className="metric-unavailable"><div className="metric-track-copy"><span>{label}</span><strong>Unavailable</strong></div><p>{detail}</p></div>
  return <MetricTrack label={label} value={Math.round(value)} detail={detail} tone={tone} />
}

export function ActivityPage() {
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const [category, setCategory] = useState<ActivityCategory>('all')
  const [serverId, setServerId] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [servers, setServers] = useState<LocalServerSummary[]>([])
  const [events, setEvents] = useState<ActivityItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const from = fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined
  const to = toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined
  useEffect(() => {
    const controller = new AbortController()
    void getLocalServers(controller.signal).then(setServers).catch(() => undefined)
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void getActivity({ category, serverId: serverId || undefined, from, to, limit: 30 }, controller.signal).then((response) => {
      setEvents(response.events)
      setNextCursor(response.nextCursor)
      setHasMore(response.hasMore)
    }).catch((issue: unknown) => {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(apiErrorMessage(issue, 'Activity could not be loaded from local history.'))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [category, serverId, from, to, reloadKey])
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const response = await getActivity({ category, serverId: serverId || undefined, from, to, cursor: nextCursor, limit: 30 })
      setEvents((current) => {
        const seen = new Set(current.map((event) => event.id))
        return [...current, ...response.events.filter((event) => !seen.has(event.id))]
      })
      setNextCursor(response.nextCursor)
      setHasMore(response.hasMore)
    } catch (issue) { setError(apiErrorMessage(issue, 'Older activity could not be loaded.')) }
    finally { setLoadingMore(false) }
  }
  const iconFor = (item: ActivityItem) => item.category === 'security' ? Shield : item.category === 'system' ? Cpu : item.category === 'backup' ? Archive : item.category === 'automation' ? CalendarDays : item.category === 'player' ? Users : Server
  const displayTime = (value: string) => new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).format(new Date(value))
  return <div className="page-stack">
    <PageHeading title="Activity" description="A durable timeline from the local machine, server actions, player logs and account audit." />
    <Card className="activity-feed-card">
      <div className="activity-filters" aria-label="Activity filters">
        <label><span>Category</span><select aria-label="Filter activity by category" value={category} onChange={(event) => setCategory(event.target.value as ActivityCategory)}>
          <option value="all">All activity</option><option value="system">Local machine</option>{isAdmin && <option value="security">Account security</option>}
          <option value="server">Server actions</option><option value="player">Player events</option><option value="backup">Backups</option><option value="automation">Scheduled tasks</option>
        </select></label>
        <label><span>Server</span><select aria-label="Filter activity by server" value={serverId} onChange={(event) => setServerId(event.target.value)}><option value="">All servers</option>{servers.map((server) => <option key={server.id} value={server.id} data-no-translate>{server.name}</option>)}</select></label>
        <label><span>From</span><input type="date" aria-label="Activity start date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label>
        <label><span>To</span><input type="date" aria-label="Activity end date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label>
      </div>
      {error && <div className="activity-feed-error" role="alert"><strong>Activity unavailable</strong><span>{error}</span><Button kind="secondary" icon={RefreshCw} onClick={() => setReloadKey((value) => value + 1)}>Retry</Button></div>}
      {loading ? <div className="local-server-empty"><span className="loading-pulse" />Loading saved activity…</div>
        : events.length ? <div className="activity-feed-list">{events.map((event) => { const Icon = iconFor(event); return <article className={`activity-feed-row outcome-${event.outcome}`} key={event.id}>
          <span className="activity-feed-icon"><Icon size={16} /></span><div className="activity-feed-copy"><div><strong>{event.title}</strong>{event.serverName && <span className="activity-feed-server" data-no-translate>{event.serverName}</span>}</div>
            <p>{event.description}</p><small>{event.actor ? <>By <span data-no-translate>{event.actor}</span> · </> : null}{event.redacted ? 'Some details are hidden for your role · ' : ''}{event.category === 'system' ? 'Local machine' : event.category === 'security' ? 'Account security' : event.category === 'server' ? 'Server actions' : event.category === 'player' ? 'Player events' : event.category === 'backup' ? 'Backups' : event.category === 'automation' ? 'Scheduled tasks' : event.category}</small></div>
          <time dateTime={event.occurredAt} title={new Date(event.occurredAt).toISOString()}>{displayTime(event.occurredAt)}</time>
        </article>})}</div>
        : <EmptyNote icon={Activity} title="No saved activity in this range" detail="The feed only shows events already persisted by MMSManager. It never fills gaps with sample entries." />}
      {hasMore && <div className="activity-feed-footer"><span>Showing the newest saved events first.</span><Button kind="secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load older activity'}</Button></div>}
    </Card>
  </div>
}

export function BackupsPage() {
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const [servers, setServers] = useState<LocalServerSummary[]>([])
  const [items, setItems] = useState<{ server: LocalServerSummary; backup: ServerBackup }[]>([])
  const [failedServers, setFailedServers] = useState<{ server: LocalServerSummary; message: string; code: string | null; requestId: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!isAdmin) { setLoading(false); return }
    setLoading(true)
    try {
      const registered = await getLocalServers(signal)
      const eligible = registered.filter((server) => server.source === 'created' && server.managed)
      setServers(eligible)
      const inventories: { server: LocalServerSummary; items: ServerBackup[] }[] = []
      const failures: { server: LocalServerSummary; message: string; code: string | null; requestId: string | null }[] = []
      let next = 0
      const workers = Array.from({ length: Math.min(4, eligible.length) }, async () => {
        while (next < eligible.length) {
          const server = eligible[next++]!
          try {
            const inventory = await getServerBackups(server.id, signal)
            inventories.push({ server, items: inventory.items })
          } catch (issue) {
            if (issue instanceof DOMException && issue.name === 'AbortError') throw issue
            failures.push({
              server,
              message: apiErrorMessage(issue, 'This server’s backup inventory could not be loaded.'),
              code: issue instanceof ApiRequestError ? issue.code : null,
              requestId: issue instanceof ApiRequestError ? issue.requestId : null,
            })
          }
        }
      })
      await Promise.all(workers)
      setItems(inventories.flatMap(({ server, items: backups }) => backups.map((backup) => ({ server, backup }))).sort((a, b) => b.backup.createdAt.localeCompare(a.backup.createdAt)))
      setFailedServers(failures)
      setError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) {
        setError(apiErrorMessage(issue, 'The local server list could not be loaded.'))
        setItems([])
        setFailedServers([])
      }
    } finally { setLoading(false) }
  }, [isAdmin])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh, reloadKey])

  return <div className="page-stack"><PageHeading title="Backups" description="Verified snapshots from MMSManager-managed local servers." />
    {!isAdmin ? <Card><EmptyNote icon={Archive} title="Administrator access required" detail="Backup inventory is restricted because snapshots can contain private server data." /></Card>
      : <>
        {(error || failedServers.length > 0) && <div className="monitor-offline-banner" role="alert"><span><HardDrive size={16} /><strong>{error ? 'Backup inventory could not be loaded' : `${failedServers.length} server ${failedServers.length === 1 ? 'inventory is' : 'inventories are'} unavailable`}</strong>{error ? <small>{error}</small> : <small>Available server inventories are still shown below.</small>}{failedServers.map(({ server, message, code, requestId }) => <small className="backup-inventory-error" key={server.id}><span data-no-translate>{server.name}</span>: {message}{code ? ` · ${code}` : ''}{requestId ? ` · Request ${requestId}` : ''}</small>)}</span><Button icon={RefreshCw} onClick={() => setReloadKey((key) => key + 1)}>Retry</Button></div>}
        {loading ? <Card><div className="local-server-empty"><span className="loading-pulse" /><span>Loading backup inventory…</span></div></Card>
          : items.length === 0 ? <Card><EmptyNote icon={Archive} title={servers.length ? 'No backups saved yet' : 'No managed servers available'} detail={servers.length ? 'Create a verified snapshot from a managed server’s Backups tab. Imported folders are read only.' : 'Only servers created by MMSManager can be backed up. No sample records are shown here.'} />{servers[0] && <div className="empty-state-actions"><Link className="button button-secondary" to={`/servers/${servers[0].id}/backups`}>Open {servers[0].name} backups <ArrowRight size={14} /></Link></div>}</Card>
            : <Card className="data-table-card"><div className="table-title-row"><div><h2>Recent snapshots</h2><p>{items.length} retained records shown</p></div><Badge>{servers.length} managed {servers.length === 1 ? 'server' : 'servers'}</Badge></div><div className="local-backup-list">{items.map(({ server, backup }) => <article className="workspace-backup-row" key={`${server.id}-${backup.id}`}>
              <div className="local-backup-icon"><Archive size={15} /></div><div className="local-backup-row-main"><strong><span data-no-translate>{server.name}</span> · {new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(backup.createdAt))}</strong><span><span data-no-translate>{formatBytes(backup.archiveSizeBytes)}</span> {translateText('archive ·', currentLocale())} <span data-no-translate>{backup.fileCount.toLocaleString(currentLocale())}</span> {translateText('files ·', currentLocale())} <span data-no-translate>{formatBytes(backup.totalFileBytes)}</span> {translateText('content', currentLocale())}</span><small><span data-no-translate>SHA-256 {backup.archiveSha256.slice(0, 16)}…</span> · {backup.excludedCount ? `${backup.excludedCount} ${translateText('excluded paths', currentLocale())}` : translateText('No excluded paths', currentLocale())}</small></div><Badge tone={backup.origin === 'manual' ? 'good' : 'neutral'}>{translateText(backup.origin === 'scheduled' ? 'Scheduled' : backup.origin === 'system' ? 'Safety snapshot' : 'Manual', currentLocale())}</Badge><Link className="button button-secondary" to={`/servers/${server.id}/backups`}>{translateText('Open server backups', currentLocale())}</Link>
            </article>)}</div></Card>}
      </>}
  </div>
}

export { UsersPage, ProfilePage, SettingsPage } from './account-pages'

export function NotFoundPage() {
  return <div className="not-found"><div className="not-found-code">404</div><h1>Page not found</h1><p>This page is not part of the local workspace.</p><Link className="button button-secondary" to="/">Return to dashboard <ChevronRight size={15} /></Link></div>
}

export function DataSummary({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <div className="compact-summary"><span>{title}</span><strong>{value}</strong><small>{detail}</small></div>
}
