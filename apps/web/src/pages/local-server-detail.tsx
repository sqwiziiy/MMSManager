import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity, AlertTriangle, Archive, Check, ChevronRight, CircleCheck, Clock3, Cpu, FileText,
  Folder, Globe, HardDrive, Layers3, LockKeyhole, Play, RefreshCw, ScrollText,
  Send, Server, Settings2, Shield, Square, Terminal, Users, Wifi,
} from 'lucide-react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import type { LocalServerSummary, ServerConsoleEntry, ServerPropertiesResponse, ServerPropertySettings, ServerRuntime } from '@mmsmanager/shared'
import {
  confirmLocalServerStopped, getServerConsole, getServerProperties, getServerRuntime,
  sendLocalServerCommand, startLocalServer, stopLocalServer, updateServerProperties,
} from '../api/servers'
import { useAuth } from '../state/use-auth'
import { Badge, Button, Card, ComingSoon, SectionHeading } from '../components/ui'

const tabs = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'console', label: 'Console', icon: Terminal },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'players', label: 'Players', icon: Users },
  { id: 'mods', label: 'Mods', icon: Layers3 },
  { id: 'files', label: 'Files', icon: Folder },
  { id: 'properties', label: 'Properties', icon: Settings2 },
  { id: 'worlds', label: 'Worlds', icon: Globe },
  { id: 'runtime', label: 'Runtime', icon: Cpu },
  { id: 'backups', label: 'Backups', icon: HardDrive },
  { id: 'automation', label: 'Automation', icon: Clock3 },
  { id: 'access', label: 'Access', icon: Shield },
]

const propertyFields: { key: keyof ServerPropertySettings; label: string; kind: 'text' | 'number' | 'select' | 'switch'; options?: string[]; min?: number; max?: number; suffix?: string }[] = [
  { key: 'motd', label: 'Message of the day', kind: 'text' },
  { key: 'gameMode', label: 'Default game mode', kind: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', label: 'Difficulty', kind: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'maxPlayers', label: 'Player limit', kind: 'number', min: 1, max: 500, suffix: 'players' },
  { key: 'viewDistance', label: 'View distance', kind: 'number', min: 2, max: 32, suffix: 'chunks' },
  { key: 'simulationDistance', label: 'Simulation distance', kind: 'number', min: 2, max: 32, suffix: 'chunks' },
  { key: 'spawnProtection', label: 'Spawn protection', kind: 'number', min: 0, max: 128, suffix: 'blocks' },
  { key: 'pvp', label: 'Player versus player', kind: 'switch' },
  { key: 'whiteList', label: 'Whitelist', kind: 'switch' },
  { key: 'allowNether', label: 'Nether dimension', kind: 'switch' },
]

export function LocalServerDetail({ server }: { server: LocalServerSummary }) {
  const location = useLocation()
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const section = location.pathname.split('/')[3] || 'overview'
  const active = tabs.find((tab) => tab.id === section) ?? tabs[0]!
  const [runtime, setRuntime] = useState<ServerRuntime | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const refreshRuntime = useCallback(async () => {
    try {
      setRuntime(await getServerRuntime(server.id))
      setRuntimeError(null)
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : 'Runtime status is unavailable.')
    }
  }, [server.id])

  useEffect(() => {
    void refreshRuntime()
    const timer = window.setInterval(() => void refreshRuntime(), 2500)
    return () => window.clearInterval(timer)
  }, [refreshRuntime])

  async function runAction(action: 'start' | 'stop' | 'confirm') {
    setBusy(true)
    setActionError(null)
    try {
      const next = action === 'start' ? await startLocalServer(server.id)
        : action === 'stop' ? await stopLocalServer(server.id)
          : await confirmLocalServerStopped(server.id)
      setRuntime(next)
      await refreshRuntime()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The server action could not be completed.')
      await refreshRuntime()
    } finally { setBusy(false) }
  }

  const status = runtime?.status ?? server.runtimeStatus ?? 'unavailable'
  const statusTone = status === 'running' ? 'good' : status === 'crashed' || status === 'error' ? 'danger' : status === 'external/unmanaged' ? 'warn' : 'neutral'
  const isManaged = server.source === 'created' && server.managed
  const canStart = isAdmin && isManaged && ['stopped', 'crashed', 'error'].includes(status) && server.eula === 'accepted' && Boolean(server.jarName && server.javaMajor)
  const canStop = isAdmin && isManaged && ['running', 'starting'].includes(status)
  const canConfirmStopped = isAdmin && isManaged && status === 'external/unmanaged'
  return <div className="page-stack server-detail-page local-detail-page">
    <div className="server-detail-heading">
      <div className="server-detail-identity"><span className="local-server-icon detail-server-icon"><Server size={19} /></span><div><div className="server-detail-title"><h1>{server.name}</h1><Badge tone={statusTone}>{statusLabel(status)}</Badge></div><p>{server.software === 'unknown' ? 'Unknown software' : `${capitalize(server.software)}${server.version ? ` ${server.version}` : ''}`} <span>·</span> {server.port ? `127.0.0.1:${server.port}` : 'No game port detected'}</p></div></div>
      <div className="server-actions">
        {isAdmin && (canStart ? <Button kind="primary" icon={Play} disabled={busy} onClick={() => void runAction('start')}>Start server</Button>
          : canStop ? <Button kind="danger" icon={Square} disabled={busy} onClick={() => void runAction('stop')}>Stop server</Button>
            : canConfirmStopped ? <Button icon={CircleCheck} disabled={busy} onClick={() => void runAction('confirm')}>Confirm it has stopped</Button>
              : <Button disabled title={server.eula !== 'accepted' ? 'EULA acceptance is required' : 'This action is not available in the current state'}>{status === 'starting' ? 'Starting…' : status === 'stopping' ? 'Stopping…' : 'Start unavailable'}</Button>)}
        <Button disabled title="Restart will be available in a later stage" icon={RefreshCw}>Restart</Button>
      </div>
    </div>
    <div className="server-detail-tabs" role="navigation" aria-label={`${server.name} pages`}>
      {tabs.map(({ id, label, icon: Icon }) => <NavLink key={id} to={`/servers/${server.id}/${id}`} className={section === id ? 'active' : ''}>
        <Icon size={15} />{label}{!['overview', 'console', 'logs', 'properties'].includes(id) && <span className="tab-preview-dot" />}
      </NavLink>)}
    </div>
    <div className="server-section-heading"><div><p className="eyebrow">{server.name} / {active.label}</p><h2>{sectionTitle(section)}</h2></div><Badge tone="good">Local registry</Badge></div>
    {(runtimeError || actionError) && <div className="local-runtime-alert" role="status"><AlertTriangle size={16} /><span>{actionError ?? runtimeError}</span><Button icon={RefreshCw} onClick={() => void refreshRuntime()}>Retry</Button></div>}
    {runtime?.errorMessage && <div className="local-runtime-alert" role="status"><AlertTriangle size={16} /><span>{runtime.errorMessage}</span></div>}
    {runtime?.restartRequired && <div className="local-restart-banner" role="status"><RefreshCw size={16} /><span><strong>Restart required</strong><small>Server properties changed while this process was running. The new values take effect after the next start.</small></span></div>}
    {section === 'overview' && <LocalOverview server={server} runtime={runtime} isAdmin={isAdmin} />}
    {section === 'console' && <LocalConsole serverId={server.id} runtime={runtime} isAdmin={isAdmin} />}
    {section === 'logs' && <LocalLogs serverId={server.id} />}
    {section === 'properties' && isAdmin && <LocalProperties serverId={server.id} managed={isManaged} />}
    {section === 'properties' && !isAdmin && <LockedDetail title="Administrator access required" text="Server properties are visible only to workspace administrators." />}
    {!['overview', 'console', 'logs', 'properties'].includes(section) && <ComingSoonDetail section={section} serverName={server.name} />}
  </div>
}

function statusLabel(status: string) {
  const labels: Record<string, string> = { stopped: 'Stopped', starting: 'Starting', running: 'Running', stopping: 'Stopping', crashed: 'Crashed', error: 'Error', 'external/unmanaged': 'Unmanaged', unavailable: 'Unavailable' }
  return labels[status] ?? 'Unavailable'
}

function sectionTitle(section: string) {
  const labels: Record<string, string> = { overview: 'Server overview', console: 'Live console', logs: 'Process output', properties: 'Server properties', players: 'Player directory', mods: 'Installed mods', files: 'File browser', worlds: 'World manager', runtime: 'Runtime profile', backups: 'Backup history', automation: 'Scheduled tasks', access: 'Access policy' }
  return labels[section] ?? 'Server overview'
}

function capitalize(value: string) { return `${value[0]!.toUpperCase()}${value.slice(1)}` }
function duration(seconds: number | null) {
  if (seconds === null) return '—'
  const value = Math.floor(seconds)
  return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`
}
function bytes(value: number | null) {
  if (value === null) return 'Unavailable'
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function LocalOverview({ server, runtime, isAdmin }: { server: LocalServerSummary; runtime: ServerRuntime | null; isAdmin: boolean }) {
  return <>
    <div className="local-runtime-metrics">
      <div><span>Players online</span><strong>Unavailable</strong><small>No player-query integration in this stage</small></div>
      <div><span>Process memory</span><strong>{bytes(runtime?.memoryRssBytes ?? null)}</strong><small>Resident memory from this child process</small></div>
      <div><span>Uptime</span><strong>{duration(runtime?.uptimeSeconds ?? null)}</strong><small>{runtime?.startedAt ? `Started ${new Date(runtime.startedAt).toLocaleString()}` : 'No running process'}</small></div>
      <div><span>Java runtime</span><strong>{server.javaMajor ? `Java ${server.javaMajor}` : 'Not configured'}</strong><small>Minecraft server process only</small></div>
    </div>
    <div className="local-detail-grid">
      <Card><SectionHeading title="Instance configuration" description="Registered local server information." /><div className="local-detail-facts">
        <div><span>Software</span><strong>{server.software === 'unknown' ? 'Unknown' : `${capitalize(server.software)}${server.version ? ` ${server.version}` : ''}`}</strong></div>
        <div><span>Game port</span><strong>{server.port ?? 'Not detected'}</strong></div>
        <div><span>Memory allocation</span><strong>{server.minMemoryMb}–{server.maxMemoryMb} MB</strong></div>
        <div><span>EULA</span><strong>{server.eula === 'accepted' ? 'Accepted' : server.eula === 'not-accepted' ? 'Not accepted' : 'Unknown'}</strong></div>
        <div><span>Management</span><strong>{server.managed && server.source === 'created' ? 'Panel managed' : 'Read only'}</strong></div>
        <div><span>Process state</span><strong>{statusLabel(runtime?.status ?? server.runtimeStatus ?? 'unavailable')}</strong></div>
      </div><div className="local-detail-callout"><LockKeyhole size={15} /><span>Only the local child process created by MMSManager can be controlled. Imported folders remain unmanaged.</span></div></Card>
      <Card><SectionHeading title="Local process" description="Runtime values are separate from machine-wide telemetry." /><div className="local-process-state"><span className={`local-process-indicator ${runtime?.status === 'running' ? 'active' : ''}`} /><div><strong>{statusLabel(runtime?.status ?? server.runtimeStatus ?? 'unavailable')}</strong><small>{runtime?.ready ? 'Minecraft reported readiness in its output.' : runtime?.status === 'starting' ? 'Waiting for the Minecraft readiness line.' : 'No panel-owned ready process.'}</small></div></div>
        <div className="local-detail-facts compact"><div><span>CPU</span><strong>Unavailable</strong></div><div><span>Connected players</span><strong>Unavailable</strong></div><div><span>Last exit code</span><strong>{runtime?.lastExitCode ?? '—'}</strong></div></div>
        {!isAdmin && <div className="local-detail-callout"><Shield size={15} /><span>Only administrators can start, stop, edit properties, or send console commands.</span></div>}
      </Card>
    </div>
  </>
}

function LocalConsole({ serverId, runtime, isAdmin }: { serverId: string; runtime: ServerRuntime | null; isAdmin: boolean }) {
  const [entries, setEntries] = useState<ServerConsoleEntry[]>([])
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const cursor = useRef(0)
  const polling = useRef(false)
  const poll = useCallback(async () => {
    if (polling.current) return
    polling.current = true
    try {
      const result = await getServerConsole(serverId, cursor.current)
      if (result.entries.length) {
        cursor.current = Math.max(cursor.current, result.entries.at(-1)!.id)
        setEntries((current) => {
          const known = new Set(current.map((entry) => entry.id))
          return [...current, ...result.entries.filter((entry) => !known.has(entry.id))].slice(-500)
        })
      }
      setError(null)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Console output is unavailable.') }
    finally { polling.current = false }
  }, [serverId])
  useEffect(() => {
    void poll()
    const timer = window.setInterval(() => void poll(), 1250)
    return () => window.clearInterval(timer)
  }, [poll])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = command.trim()
    if (!value || !isAdmin || runtime?.status !== 'running') return
    setSending(true)
    try {
      await sendLocalServerCommand(serverId, value)
      setCommand('')
      await poll()
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The command could not be sent.') }
    finally { setSending(false) }
  }
  return <div className="local-console-layout"><Card className="local-console-card"><div className="local-console-toolbar"><div><span className={`console-live-dot ${runtime?.status === 'running' ? '' : 'idle'}`} /><strong>{runtime?.status === 'running' ? 'Connected to owned process' : statusLabel(runtime?.status ?? 'unavailable')}</strong><span>{entries.length} retained lines loaded</span></div><Badge tone={runtime?.status === 'running' ? 'good' : 'neutral'}>{runtime?.status === 'running' ? 'Live output' : 'Idle'}</Badge></div>
    {error && <div className="local-inline-error" role="status">{error}</div>}
    <div className="console-output local-console-output" role="log" aria-label="Local server process output" aria-live="polite">
      {entries.length ? entries.map((entry) => <div className="console-line" key={entry.id}><time>{new Date(entry.occurredAt).toLocaleTimeString()}</time><span className={`console-level level-${entry.severity}`}>{entry.source === 'stdout' ? 'OUT' : entry.source === 'stderr' ? 'ERR' : entry.source.toUpperCase()}</span><span>{entry.message}</span></div>) : <div className="local-console-empty"><Terminal size={22} /><strong>No process output yet</strong><span>Start this managed server to populate the local console and logs.</span></div>}
    </div>
    <form className="console-input-row local-command-row" onSubmit={(event) => void submit(event)}><span className="console-prompt">&gt;</span><input value={command} onChange={(event) => setCommand(event.target.value)} maxLength={256} disabled={!isAdmin || runtime?.status !== 'running'} placeholder={isAdmin ? 'Enter a Minecraft server command' : 'Administrator access required'} aria-label="Minecraft server command" /><kbd>Enter</kbd><Button kind="primary" disabled={!isAdmin || runtime?.status !== 'running' || !command.trim() || sending} icon={Send}>Send</Button></form>
  </Card><div className="local-console-side"><Card><SectionHeading title="Output source" description="Captured from the panel-owned Java child process." /><div className="local-source-list"><div><Wifi size={15} /><span>stdout and stderr</span></div><div><FileText size={15} /><span>Stored locally with bounded rotation</span></div><div><Shield size={15} /><span>Browser input goes to Minecraft stdin, never a shell</span></div></div></Card><div className="local-detail-callout"><AlertTriangle size={15} /><span>Commands are sent only while the process is ready and owned. Output is capped for display; raw logs remain in the private application data directory.</span></div></div></div>
}

function LocalLogs({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<ServerConsoleEntry[]>([])
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void getServerConsole(serverId, 0, controller.signal).then((value) => setEntries(value.entries)).catch((issue: unknown) => {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(issue instanceof Error ? issue.message : 'Log history is unavailable.')
    })
    return () => controller.abort()
  }, [serverId])
  const filtered = useMemo(() => entries.filter((entry) => (level === 'all' || entry.severity === level) && `${entry.message} ${entry.source}`.toLowerCase().includes(query.toLowerCase())), [entries, level, query])
  return <Card className="logs-card local-logs-card"><div className="logs-toolbar"><div className="filter-tabs" role="tablist" aria-label="Filter process log severity">{['all', 'info', 'warn', 'error', 'debug'].map((item) => <button key={item} role="tab" aria-selected={level === item} className={level === item ? 'selected' : ''} onClick={() => setLevel(item)}>{item === 'all' ? 'All' : item.toUpperCase()}</button>)}</div><label className="inline-search"><ScrollText size={15} /><input aria-label="Search local process logs" placeholder="Search output" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    {error && <div className="local-inline-error" role="status">{error}</div>}
    {filtered.length ? <div className="logs-list">{filtered.map((entry) => <div className="log-row" key={entry.id}><time>{new Date(entry.occurredAt).toLocaleString()}</time><Badge tone={entry.severity === 'error' ? 'danger' : entry.severity === 'warn' ? 'warn' : 'neutral'}>{entry.severity.toUpperCase()}</Badge><span className="log-message">{entry.message}</span><span className="log-source">{entry.source}</span></div>)}</div> : <div className="local-console-empty"><ScrollText size={21} /><strong>No matching process output</strong><span>{entries.length ? 'Clear the search or change the level filter.' : 'Logs appear after a panel-owned server process starts.'}</span></div>}
    <div className="logs-foot"><span>{filtered.length} of {entries.length} retained entries</span><span>Private local log history</span></div>
  </Card>
}

function LocalProperties({ serverId, managed }: { serverId: string; managed: boolean }) {
  const [properties, setProperties] = useState<ServerPropertiesResponse | null>(null)
  const [draft, setDraft] = useState<ServerPropertySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await getServerProperties(serverId, signal)
      setProperties(result)
      setDraft(result.settings)
      setError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(issue instanceof Error ? issue.message : 'Properties could not be loaded.')
    } finally { setLoading(false) }
  }, [serverId])
  useEffect(() => { const controller = new AbortController(); void reload(controller.signal); return () => controller.abort() }, [reload])
  const dirty = useMemo(() => Boolean(properties && draft && JSON.stringify(properties.settings) !== JSON.stringify(draft)), [draft, properties])
  function setValue(key: keyof ServerPropertySettings, value: string | number | boolean) {
    setDraft((current) => current ? { ...current, [key]: value } as ServerPropertySettings : current)
    setSaved(false)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || !properties || !dirty) return
    setSaving(true); setError(null); setSaved(false)
    const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => properties.settings[key as keyof ServerPropertySettings] !== value)) as Partial<ServerPropertySettings>
    try {
      const result = await updateServerProperties(serverId, changes)
      setProperties(result); setDraft(result.settings); setSaved(true)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Properties could not be saved.') }
    finally { setSaving(false) }
  }
  if (!managed) return <LockedDetail title="Read only folder" text="Only a new server created by MMSManager can have managed properties. Imported folders are never edited." />
  if (loading) return <div className="local-properties-loading"><span className="loading-pulse" /> Reading the managed server.properties file…</div>
  if (!draft || !properties) return <Card className="local-properties-card"><div className="empty-list"><AlertTriangle size={20} /><strong>Properties unavailable</strong><span>{error ?? 'A safe managed properties file was not found.'}</span><Button icon={RefreshCw} onClick={() => void reload()}>Retry</Button></div></Card>
  return <div className="local-properties-layout"><Card className="local-properties-card"><div className="local-properties-header"><div><div className="card-kicker"><Settings2 size={15} /> Safe editor</div><h3>Server properties</h3><p>Comments and unsupported keys are kept as they are.</p></div><Badge tone="good">Managed file</Badge></div>
    {error && <div className="local-inline-error" role="status">{error}</div>}{saved && <div className="local-saved-note" role="status"><Check size={15} /> Saved with a recovery copy.</div>}
    <form onSubmit={(event) => void save(event)}><div className="local-properties-grid">{propertyFields.map((item) => <div className="field" key={item.key}><span className="field-label">{item.label}</span>
      {item.kind === 'text' && <input aria-label={item.label} value={String(draft[item.key])} maxLength={120} onChange={(event) => setValue(item.key, event.target.value)} />}
      {item.kind === 'number' && <div className="property-number-input"><input aria-label={item.label} type="number" value={Number(draft[item.key])} min={item.min} max={item.max} onChange={(event) => setValue(item.key, event.target.value === '' ? item.min ?? 0 : Number(event.target.value))} /><span>{item.suffix}</span></div>}
      {item.kind === 'select' && <select aria-label={item.label} value={String(draft[item.key])} onChange={(event) => setValue(item.key, event.target.value)}>{item.options?.map((option) => <option key={option} value={option}>{capitalize(option)}</option>)}</select>}
      {item.kind === 'switch' && <label className="property-toggle"><input type="checkbox" aria-label={item.label} checked={Boolean(draft[item.key])} onChange={(event) => setValue(item.key, event.target.checked)} /><span /><strong>{draft[item.key] ? 'Enabled' : 'Disabled'}</strong></label>}
      {item.suffix || item.key === 'motd' ? <span className="field-hint">{item.suffix ? `${item.min}–${item.max} ${item.suffix}` : 'Up to 120 characters'}</span> : null}
    </div>)}</div><div className="local-properties-footer"><span>{dirty ? 'Unsaved changes' : 'All changes are saved'}</span><div><Button type="button" disabled={!dirty || saving} onClick={() => setDraft(properties.settings)}>Discard</Button><Button kind="primary" icon={saving ? RefreshCw : Check} disabled={!dirty || saving} type="submit">{saving ? 'Saving…' : 'Save properties'}</Button></div></div></form>
  </Card><div className="local-properties-side">
    {properties.restartRequired && <div className="local-restart-banner"><RefreshCw size={16} /><span><strong>Restart required</strong><small>Changes will be applied at the next server start.</small></span></div>}
    <Card><SectionHeading title="Protected and preserved" description="Network and unrecognized properties are not editable here." /><div className="local-protected-setting"><LockKeyhole size={15} /><span><strong>Local network bind</strong><small>127.0.0.1 is preserved from the managed installation.</small></span></div><div className="local-unknown-setting"><strong>{properties.unknownKeys.length} other properties preserved</strong><span>{properties.unknownKeys.length ? properties.unknownKeys.slice(0, 12).join(' · ') : 'No additional keys found'}{properties.unknownKeys.length > 12 ? ' …' : ''}</span></div></Card>
    <Card><SectionHeading title="Recovery copies" description="A private copy is made before every change." /><div className="local-backup-list">{properties.backups.length ? properties.backups.map((backup) => <div key={backup.id}><span className="local-backup-icon"><Archive size={15} /></span><span><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>SHA-256 {backup.sha256.slice(0, 12)}…</small></span></div>) : <span className="local-no-backups">No property changes saved yet.</span>}</div><p className="data-note">Backup files are stored privately under the MMSManager data directory. Restore controls are planned for a later stage.</p></Card>
  </div></div>
}

function LockedDetail({ title, text }: { title: string; text: string }) {
  return <Card className="local-lock-card"><span><LockKeyhole size={20} /></span><h3>{title}</h3><p>{text}</p></Card>
}

function ComingSoonDetail({ section, serverName }: { section: string; serverName: string }) {
  const item = tabs.find((tab) => tab.id === section)
  const Icon = item?.icon ?? FileText
  return <div className="preview-section-layout"><Card className="preview-section-card"><div className="preview-section-header"><span className="preview-section-icon"><Icon size={20} /></span><div><h3>{sectionTitle(section)}</h3><p>Real {section} data is not available in this stage.</p></div><ComingSoon /></div><div className="local-coming-soon-message"><span className="local-server-icon"><Icon size={19} /></span><strong>{item?.label ?? 'Server tools'}</strong><span>The local page navigation is ready. This feature will be connected in a later stage.</span></div><div className="preview-section-footer"><span>Server: {serverName} · local registry</span><Link to="/servers">All servers <ChevronRight size={14} /></Link></div></Card><div className="local-detail-callout"><Shield size={15} /><span>There is no mock player, mod, world, file, backup or automation data attached to this real server.</span></div></div>
}
