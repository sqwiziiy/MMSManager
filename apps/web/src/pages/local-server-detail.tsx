import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity, AlertTriangle, Archive, ArrowDownToLine, Ban, Check, ChevronRight, CircleCheck, Clock3, Cpu, FilePlus2, FileText,
  Folder, FolderPlus, Globe, HardDrive, Layers3, LockKeyhole, Package, PencilLine, Play, RefreshCw, RotateCcw, ScrollText,
  Search, Send, Server, Settings2, Shield, Square, Terminal, Trash2, Upload, Users, Wifi,
} from 'lucide-react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import type { LocalServerSummary, ServerConsoleEntry, ServerModEntry, ServerModsInventory, ServerPropertiesResponse, ServerPropertiesRestorePreview, ServerPropertySettings, ServerRuntime, ServerStatus, ServerPlayerList, ServerPlayerAction, ServerFileEntry, ServerFileList, ServerFileRead, ServerFileRecovery, ServerFileTrash, ServerWorlds } from '@mmsmanager/shared'
import {
  confirmLocalServerStopped, createServerFile, downloadServerFile, getAuthoritativePlayers, getServerConsole, getServerProperties, getServerRuntime, getServerStatus, getServerFiles, getServerFileRecoveries, getServerFileTrash, getServerWorlds, previewServerPropertiesRestore, restoreServerFileRecovery, restoreServerProperties, restoreTrashedServerFile, sendPlayerAction,
  sendLocalServerCommand, startLocalServer, stopLocalServer, restartLocalServer, updateServerProperties,
  getServerMods, uploadServerMod, uploadServerFile, setServerModEnabled, quarantineServerMod, restoreQuarantinedMod, moveServerFile, readServerFile, saveServerFileText, trashServerFile, updateServerMetadata,
} from '../api/servers'
import { useAuth } from '../state/use-auth'
import { Badge, Button, Card, ComingSoon, SectionHeading } from '../components/ui'
import { LocalServerBackups } from './local-server-backups'
import { LocalServerRuntime } from './local-server-runtime'
import { LocalServerAutomation } from './local-server-automation'

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
  { key: 'onlineMode', label: 'Online mode', kind: 'switch' },
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
  const [statusSample, setStatusSample] = useState<ServerStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState(server.name)
  const [nameDraft, setNameDraft] = useState(server.name)
  const [nameDialogOpen, setNameDialogOpen] = useState(false)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  useEffect(() => { setDisplayName(server.name); setNameDraft(server.name) }, [server.id, server.name])

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
  useEffect(() => {
    let active = true
    const refresh = () => { void getServerStatus(server.id).then((value) => {
      if (active) { setStatusSample(value); setStatusError(null) }
    }).catch((error: unknown) => {
      if (active) setStatusError(error instanceof Error ? error.message : 'The local status query failed.')
    }) }
    refresh()
    const timer = window.setInterval(refresh, 15_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [server.id])

  async function runAction(action: 'start' | 'stop' | 'confirm' | 'restart') {
    if (action === 'restart' && !window.confirm('Restart this panel-owned process? MMSManager will wait for graceful exit, then start it and wait up to 90 seconds for readiness. It will not force-kill the process.')) return
    setBusy(true)
    setActionError(null)
    try {
      const next = action === 'start' ? await startLocalServer(server.id)
        : action === 'stop' ? await stopLocalServer(server.id)
          : action === 'confirm' ? await confirmLocalServerStopped(server.id)
            : await restartLocalServer(server.id)
      setRuntime(next)
      window.dispatchEvent(new Event('mmsmanager:server-lifecycle'))
      if (action === 'restart') window.dispatchEvent(new Event('mmsmanager:server-restarted'))
      await refreshRuntime()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The server action could not be completed.')
      await refreshRuntime()
    } finally { setBusy(false) }
  }

  async function saveName(event: FormEvent) {
    event.preventDefault()
    const name = nameDraft.trim()
    if (!name || name === displayName || nameSaving) return
    setNameSaving(true); setNameError(null)
    try {
      const updated = await updateServerMetadata(server.id, { name })
      setDisplayName(updated.name); setNameDialogOpen(false)
    } catch (issue) { setNameError(issue instanceof Error ? issue.message : 'The server name could not be saved.') }
    finally { setNameSaving(false) }
  }

  const status = runtime?.status ?? server.runtimeStatus ?? 'unavailable'
  const statusTone = status === 'running' ? 'good' : status === 'crashed' || status === 'error' ? 'danger' : status === 'external/unmanaged' ? 'warn' : 'neutral'
  const isManaged = server.source === 'created' && server.managed
  const canStart = isAdmin && isManaged && ['stopped', 'crashed', 'error'].includes(status) && server.eula === 'accepted' && Boolean(server.jarName && server.javaMajor)
  const canStop = isAdmin && isManaged && ['running', 'starting'].includes(status)
  const canRestart = isAdmin && isManaged && status === 'running'
  const canConfirmStopped = isAdmin && isManaged && status === 'external/unmanaged'
  return <div className="page-stack server-detail-page local-detail-page">
    <div className="server-detail-heading">
      <div className="server-detail-identity"><span className="local-server-icon detail-server-icon"><Server size={19} /></span><div><div className="server-detail-title"><h1>{displayName}</h1><Badge tone={statusTone}>{statusLabel(status)}</Badge></div><p>{server.software === 'unknown' ? 'Unknown software' : `${capitalize(server.software)}${server.version ? ` ${server.version}` : ''}`} <span>·</span> {server.port ? `Game port ${server.port}` : 'No game port detected'}</p></div></div>
      <div className="server-actions">
        {isAdmin && <Button kind="quiet" icon={PencilLine} onClick={() => { setNameDraft(displayName); setNameError(null); setNameDialogOpen(true) }}>Edit name</Button>}
        {isAdmin && (canStart ? <Button kind="primary" icon={Play} disabled={busy} onClick={() => void runAction('start')}>Start server</Button>
          : canStop ? <Button kind="danger" icon={Square} disabled={busy} onClick={() => void runAction('stop')}>Stop server</Button>
            : canConfirmStopped ? <Button icon={CircleCheck} disabled={busy} onClick={() => void runAction('confirm')}>Confirm it has stopped</Button>
              : <Button disabled title={server.eula !== 'accepted' ? 'EULA acceptance is required' : 'This action is not available in the current state'}>{status === 'starting' ? 'Starting…' : status === 'stopping' ? 'Stopping…' : 'Start unavailable'}</Button>)}
        <Button icon={RefreshCw} disabled={!canRestart || busy} onClick={() => void runAction('restart')}>{busy && status === 'running' ? 'Restarting…' : 'Restart'}</Button>
      </div>
    </div>
    <div className="server-detail-tabs" role="navigation" aria-label={`${displayName} pages`}>
      {tabs.map(({ id, label, icon: Icon }) => <NavLink key={id} to={`/servers/${server.id}/${id}`} className={section === id ? 'active' : ''}>
        <Icon size={15} />{label}{!['overview', 'console', 'logs', 'properties', 'players', 'mods', 'files', 'worlds', 'backups', 'runtime', 'automation', 'access'].includes(id) && <span className="tab-preview-dot" />}
      </NavLink>)}
    </div>
    <div className="server-section-heading"><div><p className="eyebrow">{displayName} / {active.label}</p><h2>{sectionTitle(section)}</h2></div><Badge tone="good">Local registry</Badge></div>
    {(runtimeError || actionError) && <div className="local-runtime-alert" role="status"><AlertTriangle size={16} /><span>{actionError ?? runtimeError}</span><Button icon={RefreshCw} onClick={() => void refreshRuntime()}>Retry</Button></div>}
    {runtime?.errorMessage && <div className="local-runtime-alert" role="status"><AlertTriangle size={16} /><span>{runtime.errorMessage}</span></div>}
    {runtime?.restartRequired && <div className="local-restart-banner" role="status"><RefreshCw size={16} /><span><strong>Restart required</strong><small>Server properties changed while this process was running. The new values take effect after the next start.</small></span></div>}
    {section === 'overview' && <LocalOverview server={server} runtime={runtime} statusSample={statusSample} isAdmin={isAdmin} />}
    {section === 'players' && <LocalPlayers serverId={server.id} isAdmin={isAdmin} canAct={Boolean(isManaged && runtime?.status === 'running')} statusSample={statusSample} error={statusError} />}
    {section === 'mods' && <LocalMods serverId={server.id} software={server.software} managed={isManaged} isAdmin={isAdmin} runtimeStatus={status} />}
    {section === 'console' && <LocalConsole serverId={server.id} runtime={runtime} isAdmin={isAdmin} />}
    {section === 'logs' && <LocalLogs serverId={server.id} />}
    {section === 'properties' && isAdmin && <LocalProperties serverId={server.id} managed={isManaged} runtimeStatus={runtime?.status ?? 'unavailable'} />}
    {section === 'properties' && !isAdmin && <LockedDetail title="Administrator access required" text="Server properties are visible only to workspace administrators." />}
    {section === 'files' && isAdmin && <LocalFiles serverId={server.id} managed={isManaged} runtimeStatus={status} />}
    {section === 'files' && !isAdmin && <LockedDetail title="Administrator access required" text="Server files may contain credentials or private world data. Access is limited to workspace administrators." />}
    {section === 'worlds' && isAdmin && <LocalWorlds serverId={server.id} managed={isManaged} />}
    {section === 'worlds' && !isAdmin && <LockedDetail title="Administrator access required" text="World paths and storage details are available only to workspace administrators." />}
    {section === 'backups' && <LocalServerBackups serverId={server.id} serverName={server.name} managed={isManaged} isAdmin={isAdmin} runtimeStatus={status} />}
    {section === 'runtime' && <LocalServerRuntime serverId={server.id} managed={isManaged} isAdmin={isAdmin} />}
    {section === 'automation' && <LocalServerAutomation serverId={server.id} managed={isManaged} isAdmin={isAdmin} />}
    {section === 'access' && <LocalAccessPolicy server={{ ...server, name: displayName }} isAdmin={isAdmin} />}
    {!['overview', 'console', 'logs', 'properties', 'players', 'mods', 'files', 'worlds', 'backups', 'runtime', 'automation', 'access'].includes(section) && <ComingSoonDetail section={section} serverName={server.name} />}
    {nameDialogOpen && <div className="local-file-dialog-backdrop"><section className="local-file-dialog server-name-dialog" role="dialog" aria-modal="true" aria-labelledby="server-name-dialog-title"><div className="local-file-dialog-heading"><span className="local-backup-icon"><PencilLine size={16} /></span><div><h3 id="server-name-dialog-title">Edit server name</h3><p>Only the display name changes. Server files and history stay in place.</p></div></div><form onSubmit={(event) => void saveName(event)}><label className="server-name-field">Server name<input autoFocus required maxLength={60} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} /></label>{nameError && <div className="local-inline-error" role="alert">{nameError}</div>}<div className="local-file-dialog-actions"><Button type="button" disabled={nameSaving} onClick={() => setNameDialogOpen(false)}>Cancel</Button><Button kind="primary" icon={nameSaving ? RefreshCw : Check} disabled={nameSaving || !nameDraft.trim() || nameDraft.trim() === displayName}>{nameSaving ? 'Saving…' : 'Save name'}</Button></div></form></section></div>}
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

function LocalOverview({ server, runtime, statusSample, isAdmin }: { server: LocalServerSummary; runtime: ServerRuntime | null; statusSample: ServerStatus | null; isAdmin: boolean }) {
  return <>
    <div className="local-runtime-metrics">
      <div><span>Players online</span><strong>{statusSample?.state === 'reachable' ? statusSample.playersOnline : 'Unavailable'}</strong><small>{statusSample?.state === 'reachable' ? 'Local status ping · count only' : 'No current local status response'}</small></div>
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
        <div className="local-detail-facts compact"><div><span>Process CPU</span><strong>{runtime?.cpuPercent === null || runtime?.cpuPercent === undefined ? 'Unavailable' : `${runtime.cpuPercent.toFixed(1)}%`}</strong><small>Share of host capacity; needs two samples</small></div><div><span>Last exit code</span><strong>{runtime?.lastExitCode ?? '—'}</strong></div></div>
        {!isAdmin && <div className="local-detail-callout"><Shield size={15} /><span>Only administrators can start, stop, edit properties, or send console commands.</span></div>}
      </Card>
    </div>
  </>
}

const playerActionLabels: Record<ServerPlayerAction, string> = {
  kick: 'Kick player', ban: 'Ban player', pardon: 'Pardon ban', op: 'Grant operator', deop: 'Remove operator',
  'whitelist-add': 'Add to whitelist', 'whitelist-remove': 'Remove from whitelist', 'whitelist-list': 'List whitelist',
}
const playerActions: ServerPlayerAction[] = ['kick', 'ban', 'pardon', 'op', 'deop', 'whitelist-add', 'whitelist-remove', 'whitelist-list']

function LocalPlayers({ serverId, isAdmin, canAct, statusSample, error }: { serverId: string; isAdmin: boolean; canAct: boolean; statusSample: ServerStatus | null; error: string | null }) {
  const [players, setPlayers] = useState<ServerPlayerList | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<ServerPlayerAction>('kick')
  const [username, setUsername] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!isAdmin) return
    setLoading(true)
    try {
      setPlayers(await getAuthoritativePlayers(serverId, signal))
      setListError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setListError(issue instanceof Error ? issue.message : 'The owned process player list is unavailable.')
    } finally { setLoading(false) }
  }, [serverId, isAdmin])
  async function submitAction(event: FormEvent) {
    event.preventDefault()
    const target = action === 'whitelist-list' ? null : username.trim()
    if (!canAct) return
    if (target && !/^[A-Za-z0-9_]{3,16}$/.test(target)) {
      setActionMessage('Enter a Minecraft username with 3 to 16 letters, numbers, or underscores.')
      return
    }
    const description = target ? `${playerActionLabels[action]} for ${target}` : playerActionLabels[action]
    if (!window.confirm(`${description}? MMSManager will send this fixed command to the panel-owned server. Confirm the result in Console.`)) return
    setActionBusy(true)
    setActionMessage(null)
    try {
      const result = await sendPlayerAction(serverId, action, target)
      setActionMessage(result.state === 'confirmed'
        ? `The server confirmed ${playerActionLabels[action].toLowerCase()}${target ? ` for ${target}` : ''} at ${new Date(result.confirmedAt!).toLocaleTimeString()}.`
        : `The command was sent, but the server response was not recognized. Check Console; the action may or may not have taken effect.`)
    } catch (issue) {
      setActionMessage(issue instanceof Error ? issue.message : 'The player command could not be submitted.')
    } finally { setActionBusy(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])
  return <Card className="local-properties-card"><SectionHeading title="Player status" description="Status ping counts and, for administrators, a fresh list from an owned process." />
    {(error || listError) && <div className="local-inline-error" role="status">{error ?? listError}</div>}
    <div className="local-detail-facts"><div><span>Online count</span><strong>{statusSample?.state === 'reachable' ? statusSample.playersOnline : 'Unavailable'}</strong></div><div><span>Maximum slots</span><strong>{statusSample?.state === 'reachable' ? statusSample.playersMax : 'Unavailable'}</strong></div><div><span>Count source</span><strong>Local status ping</strong></div><div><span>Checked</span><strong>{statusSample ? new Date(statusSample.checkedAt).toLocaleString() : 'Waiting for response'}</strong></div></div>
    <div className="local-player-list"><div className="card-heading-row"><div><div className="card-kicker"><Users size={15} /> Owned process</div><h3>Online identities</h3></div>{isAdmin && <Button icon={RefreshCw} disabled={loading} onClick={() => void refresh()}>Refresh list</Button>}</div>
      {!isAdmin ? <p>Administrator access is required to request player names.</p>
        : loading && !players ? <p>Asking the owned process for its player list…</p>
          : players?.state === 'authoritative' ? <><p>Reported by the owned console at {new Date(players.sampledAt!).toLocaleString()}. Names are not UUID verified.</p>{players.names.length ? <div className="local-player-names">{players.names.map((name) => <strong key={name}>{name}</strong>)}</div> : <p>No players were reported by the owned process.</p>}</>
            : <p>{players?.reason ?? 'An owned, ready process is required for a verified player list.'}</p>}
    </div>
    {isAdmin && <div className="local-player-actions"><SectionHeading title="Player commands" description="Fixed Minecraft commands sent only to this panel-owned process." />
      <form onSubmit={(event) => void submitAction(event)}>
        <label><span>Action</span><select aria-label="Player action" value={action} onChange={(event) => setAction(event.target.value as ServerPlayerAction)}>{playerActions.map((choice) => <option key={choice} value={choice}>{playerActionLabels[choice]}</option>)}</select></label>
        {action !== 'whitelist-list' && <label><span>Minecraft username</span><input aria-label="Minecraft username" autoComplete="off" maxLength={16} pattern="[A-Za-z0-9_]{3,16}" placeholder="Player name" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>}
        <Button icon={Shield} disabled={!canAct || actionBusy} kind={action === 'kick' || action === 'ban' ? 'danger' : 'secondary'}>{actionBusy ? 'Sending…' : 'Send player command'}</Button>
      </form>
      <p>{canAct ? 'Actions are submitted, not assumed successful. Check the owned console response.' : 'Player commands require an administrator and a running panel-owned server.'}</p>
      {actionMessage && <div className="local-action-result" role="status">{actionMessage}</div>}
    </div>}
    <div className="local-detail-callout"><Users size={15} /><span>The status ping never proves player identities. Moderation actions remain unavailable until their command results can be verified.</span></div>
  </Card>
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

function LocalProperties({ serverId, managed, runtimeStatus }: { serverId: string; managed: boolean; runtimeStatus: string }) {
  const [properties, setProperties] = useState<ServerPropertiesResponse | null>(null)
  const [draft, setDraft] = useState<ServerPropertySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmOnlineMode, setConfirmOnlineMode] = useState(false)
  const [restorePreview, setRestorePreview] = useState<ServerPropertiesRestorePreview | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null)
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
  const onlineModeChanged = Boolean(properties && draft && properties.settings.onlineMode !== draft.onlineMode)
  const onlineModeStopped = runtimeStatus === 'stopped'
  function setValue(key: keyof ServerPropertySettings, value: string | number | boolean) {
    setDraft((current) => current ? { ...current, [key]: value } as ServerPropertySettings : current)
    if (key === 'onlineMode') setConfirmOnlineMode(false)
    setSaved(false)
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || !properties || !dirty) return
    setSaving(true); setError(null); setSaved(false)
    const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => properties.settings[key as keyof ServerPropertySettings] !== value)) as Partial<ServerPropertySettings>
    try {
      const result = await updateServerProperties(serverId, changes, onlineModeChanged && confirmOnlineMode)
      setProperties(result); setDraft(result.settings); setSaved(true); setConfirmOnlineMode(false)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Properties could not be saved.') }
    finally { setSaving(false) }
  }
  async function previewBackup(backupId: string) {
    setRestoreError(null); setRestoreNotice(null)
    try { setRestorePreview(await previewServerPropertiesRestore(serverId, backupId)) }
    catch (issue) { setRestoreError(issue instanceof Error ? issue.message : 'The recovery preview could not be loaded.') }
  }
  async function restoreBackup() {
    if (!restorePreview?.checksumValid) return
    setRestoreBusy(true); setRestoreError(null)
    try {
      const result = await restoreServerProperties(serverId, restorePreview.backupId, restorePreview.currentSha256)
      setProperties(result.properties); setDraft(result.properties.settings)
      setRestoreNotice(result.recoveryBackupId ? 'Properties restored. A recovery copy of the previous file was created.' : 'The selected version already matches the current settings.')
      setRestorePreview(null)
    } catch (issue) { setRestoreError(issue instanceof Error ? issue.message : 'The selected properties version could not be restored.') }
    finally { setRestoreBusy(false) }
  }
  if (!managed) return <LockedDetail title="Read only folder" text="Only a new server created by MMSManager can have managed properties. Imported folders are never edited." />
  if (loading) return <div className="local-properties-loading"><span className="loading-pulse" /> Reading the managed server.properties file…</div>
  if (!draft || !properties) return <Card className="local-properties-card"><div className="empty-list"><AlertTriangle size={20} /><strong>Properties unavailable</strong><span>{error ?? 'A safe managed properties file was not found.'}</span><Button icon={RefreshCw} onClick={() => void reload()}>Retry</Button></div></Card>
  return <div className="local-properties-layout"><Card className="local-properties-card"><div className="local-properties-header"><div><div className="card-kicker"><Settings2 size={15} /> Safe editor</div><h3>Server properties</h3><p>Comments and unsupported keys are kept as they are.</p></div><Badge tone="good">Managed file</Badge></div>
    {error && <div className="local-inline-error" role="status">{error}</div>}{saved && <div className="local-saved-note" role="status"><Check size={15} /> Saved with a recovery copy.</div>}{restoreError && <div className="local-inline-error" role="status">{restoreError}</div>}{restoreNotice && <div className="local-saved-note" role="status"><Check size={15} /> {restoreNotice}</div>}
    <form onSubmit={(event) => void save(event)}><div className="local-properties-grid">{propertyFields.map((item) => <div className="field" key={item.key}><span className="field-label">{item.label}</span>
      {item.kind === 'text' && <input aria-label={item.label} value={String(draft[item.key])} maxLength={120} onChange={(event) => setValue(item.key, event.target.value)} />}
      {item.kind === 'number' && <div className="property-number-input"><input aria-label={item.label} type="number" value={Number(draft[item.key])} min={item.min} max={item.max} onChange={(event) => setValue(item.key, event.target.value === '' ? item.min ?? 0 : Number(event.target.value))} /><span>{item.suffix}</span></div>}
      {item.kind === 'select' && <select aria-label={item.label} value={String(draft[item.key])} onChange={(event) => setValue(item.key, event.target.value)}>{item.options?.map((option) => <option key={option} value={option}>{capitalize(option)}</option>)}</select>}
      {item.kind === 'switch' && <label className="property-toggle"><input type="checkbox" aria-label={item.label} checked={Boolean(draft[item.key])} disabled={item.key === 'onlineMode' && !onlineModeStopped} onChange={(event) => setValue(item.key, event.target.checked)} /><span /><strong>{draft[item.key] ? 'Enabled' : 'Disabled'}</strong></label>}
      {item.suffix || item.key === 'motd' || item.key === 'onlineMode' ? <span className="field-hint">{item.suffix ? `${item.min}–${item.max} ${item.suffix}` : item.key === 'motd' ? 'Up to 120 characters' : 'Changes require a stopped server.'}</span> : null}
    </div>)}</div>
    {onlineModeChanged && <div className="online-mode-confirmation" role="group" aria-labelledby="online-mode-change-title"><div><AlertTriangle size={16} /><div><strong id="online-mode-change-title">Online-mode change</strong><p>Current: {properties.settings.onlineMode ? 'Enabled' : 'Disabled'} · Pending: {draft.onlineMode ? 'Enabled' : 'Disabled'}. Changing this may create different player UUIDs and separate existing inventories, advancements and permissions from those identities. Disabling it weakens Minecraft account verification. No player data is migrated, and this does not change MMSManager sign-in.</p>{!onlineModeStopped && <small>The server must be confirmed stopped before this setting can change.</small>}</div></div><label><input type="checkbox" checked={confirmOnlineMode} disabled={!onlineModeStopped} onChange={(event) => setConfirmOnlineMode(event.target.checked)} /> I understand and confirm this change</label></div>}
    <div className="local-properties-footer"><span>{dirty ? 'Unsaved changes' : 'All changes are saved'}</span><div><Button type="button" disabled={!dirty || saving} onClick={() => { setDraft(properties.settings); setConfirmOnlineMode(false) }}>Discard</Button><Button kind="primary" icon={saving ? RefreshCw : Check} disabled={!dirty || saving || (onlineModeChanged && (!onlineModeStopped || !confirmOnlineMode))} type="submit">{saving ? 'Saving…' : 'Save properties'}</Button></div></div></form>
  </Card><div className="local-properties-side">
    {properties.restartRequired && <div className="local-restart-banner"><RefreshCw size={16} /><span><strong>Restart required</strong><small>Changes will be applied at the next server start.</small></span></div>}
    <Card><SectionHeading title="Protected and preserved" description="Network and unrecognized properties are not editable here." /><div className="local-protected-setting"><LockKeyhole size={15} /><span><strong>Local network bind</strong><small>127.0.0.1 is preserved from the managed installation.</small></span></div><div className="local-unknown-setting"><strong>{properties.unknownKeys.length} other properties preserved</strong><span>{properties.unknownKeys.length ? properties.unknownKeys.slice(0, 12).join(' · ') : 'No additional keys found'}{properties.unknownKeys.length > 12 ? ' …' : ''}</span></div></Card>
    <Card><SectionHeading title="Recovery copies" description="Private snapshots made before each property change." /><div className="local-backup-list">{properties.backups.length ? properties.backups.map((backup) => <div key={backup.id}><span className="local-backup-icon"><Archive size={15} /></span><span><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>SHA-256 {backup.sha256.slice(0, 12)}…</small></span><Button icon={RotateCcw} onClick={() => void previewBackup(backup.id)}>Preview restore</Button></div>) : <span className="local-no-backups">No property changes saved yet.</span>}</div><p className="data-note">Preview compares supported settings. Secrets and unrecognized values are never shown.</p></Card>
  </div>{restorePreview && <div className="local-file-dialog-backdrop"><section className="local-file-dialog" role="dialog" aria-modal="true" aria-labelledby="property-restore-title"><div className="local-file-dialog-heading"><span className="local-backup-icon"><RotateCcw size={16} /></span><div><h3 id="property-restore-title">Restore properties</h3><p>Recovery copy from {new Date(restorePreview.createdAt).toLocaleString()}</p></div></div>{!restorePreview.checksumValid ? <div className="local-inline-error">This recovery copy failed checksum validation. It cannot be restored.</div> : restorePreview.changedSettings.length ? <div className="local-property-diff"><div className="local-property-diff-head"><span>Setting</span><span>Current</span><span>Restored</span></div>{restorePreview.changedSettings.map((change) => <div key={change.key}><strong>{change.key}</strong><span>{change.current}</span><span>{change.restored}</span></div>)}</div> : <div className="local-files-empty">No supported setting values differ.</div>}{restorePreview.otherContentDiffers && <p className="data-note">Comments and unrecognized properties also differ. Their values stay hidden in this preview and will be restored exactly.</p>}{restorePreview.running && <div className="local-file-warning"><RefreshCw size={15} /> The server is running. Restored values apply after its next restart.</div>}{restorePreview.restartRequiredAfterRestore && !restorePreview.running && <div className="local-file-warning"><RefreshCw size={15} /> A restart is already required. Restoring settings will keep that state.</div>}<div className="local-file-dialog-actions"><Button disabled={restoreBusy} onClick={() => setRestorePreview(null)}>Cancel</Button><Button kind="primary" icon={restoreBusy ? RefreshCw : RotateCcw} disabled={restoreBusy || !restorePreview.checksumValid || (restorePreview.changedSettings.length === 0 && !restorePreview.otherContentDiffers)} onClick={() => void restoreBackup()}>{restoreBusy ? 'Restoring…' : 'Restore this version'}</Button></div></section></div>}</div>
}

function LocalWorlds({ serverId, managed }: { serverId: string; managed: boolean }) {
  const [worlds, setWorlds] = useState<ServerWorlds | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    if (!managed) { setLoading(false); return }
    const controller = new AbortController()
    setLoading(true); setError(null); setWorlds(null)
    void getServerWorlds(serverId, controller.signal).then((result) => {
      setWorlds(result); setLoading(false)
    }).catch((issue: unknown) => {
      if (!controller.signal.aborted) {
        setError(issue instanceof Error ? issue.message : 'The managed world inventory is unavailable.')
        setLoading(false)
      }
    })
    return () => controller.abort()
  }, [serverId, managed, reloadKey])
  if (!managed) return <LockedDetail title="Read only folder" text="World inventory is available only for servers created and managed by MMSManager. Imported folders are not scanned." />
  return <div className="local-worlds-layout">
    <Card className="local-worlds-card">
      <div className="local-worlds-header"><div><div className="card-kicker"><Globe size={15} /> Managed world inventory</div><h3>World folders</h3><p>Configured name and bounded folder metadata · no world files are changed</p></div><Button icon={RotateCcw} disabled={loading} onClick={() => setReloadKey((value) => value + 1)}>Refresh</Button></div>
      {error && <div className="local-inline-error" role="alert">{error}<Button icon={RotateCcw} onClick={() => setReloadKey((value) => value + 1)}>Retry</Button></div>}
      {loading && <div className="local-files-empty" role="status"><span className="loading-pulse" /> Inspecting registered world folders…</div>}
      {!loading && worlds?.status === 'unavailable' && <div className="local-files-empty"><AlertTriangle size={19} /><strong>World inventory unavailable</strong><span>{worlds.reason}</span></div>}
      {worlds?.status === 'available' && <>
        <div className="local-worlds-level"><span>Configured level-name</span><strong>{worlds.levelName}</strong><Badge tone="neutral">{worlds.levelNameSource === 'minecraft-default' ? 'Minecraft default' : 'server.properties'}</Badge></div>
        <div className="local-world-list">
          {worlds.entries.map((world) => <article className="local-world-row" key={world.path}>
            <span className="local-world-icon"><Globe size={17} /></span>
            <div className="local-world-primary"><strong>{world.name}</strong><span>{world.path} · {world.dimension}</span>{world.reason && <small>{world.reason}</small>}</div>
            <Badge tone={world.state === 'available' ? 'good' : world.state === 'unsafe' ? 'danger' : 'warn'}>{world.state}</Badge>
            <div className="local-world-stat"><span>Stored size</span><strong>{world.sizeBytes === null ? 'Unavailable' : `${world.sizeComplete ? '' : '≥ '}${formatWorldSize(world.sizeBytes)}`}</strong></div>
            <div className="local-world-stat"><span>Last modified</span><strong>{world.modifiedAt ? new Date(world.modifiedAt).toLocaleString() : 'Unavailable'}</strong></div>
            <div className="local-world-stat"><span>Backup</span><strong>{world.backupAvailable ? 'Available' : 'None yet'}</strong></div>
          </article>)}
        </div>
        <div className="local-worlds-note"><Shield size={15} /><span>World folders are read only here. Visual world previews are unavailable.</span></div>
      </>}
    </Card>
  </div>
}

function formatWorldSize(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

function LocalFiles({ serverId, managed, runtimeStatus }: { serverId: string; managed: boolean; runtimeStatus: string }) {
  const [path, setPath] = useState('')
  const [inventory, setInventory] = useState<ServerFileList | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editor, setEditor] = useState<ServerFileRead | null>(null)
  const [editorText, setEditorText] = useState('')
  const [editorError, setEditorError] = useState<string | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [recoveries, setRecoveries] = useState<ServerFileRecovery[]>([])
  const [dialog, setDialog] = useState<'file' | 'folder' | 'move' | null>(null)
  const [dialogEntry, setDialogEntry] = useState<ServerFileEntry | null>(null)
  const [dialogName, setDialogName] = useState('')
  const [dialogText, setDialogText] = useState('')
  const [trashOpen, setTrashOpen] = useState(false)
  const [trash, setTrash] = useState<ServerFileTrash[]>([])

  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try { setInventory(await getServerFiles(serverId, path, signal)); setError(null) }
    catch (issue) { if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(issue instanceof Error ? issue.message : 'The server folder could not be read.') }
    finally { setLoading(false) }
  }, [path, serverId])
  useEffect(() => { const controller = new AbortController(); void reload(controller.signal); return () => controller.abort() }, [reload])

  async function openTextFile(entry: ServerFileEntry) {
    if (!entry.canEdit) return
    setEditorError(null); setRecoveries([]); setEditorBusy(true)
    try {
      const content = await readServerFile(serverId, entry.path)
      if (content.contentState !== 'editable' || content.text === null || content.sha256 === null) throw new Error(content.reason ?? 'This file cannot be edited safely.')
      setEditor(content); setEditorText(content.text)
      setRecoveries(await getServerFileRecoveries(serverId, content.path))
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The text file could not be opened.') }
    finally { setEditorBusy(false) }
  }

  async function saveTextFile(event: FormEvent) {
    event.preventDefault()
    if (!editor?.sha256) return
    setEditorBusy(true); setEditorError(null)
    try {
      const updated = await saveServerFileText(serverId, editor.path, editorText, editor.sha256)
      setEditor(updated); setEditorText(updated.text ?? ''); setRecoveries(await getServerFileRecoveries(serverId, updated.path))
      setNotice(`Saved ${updated.path} with a private recovery copy.`)
      await reload()
    } catch (issue) { setEditorError(issue instanceof Error ? issue.message : 'The file could not be saved.') }
    finally { setEditorBusy(false) }
  }

  async function restoreTextRecovery(recovery: ServerFileRecovery) {
    if (!editor?.sha256 || !window.confirm(`Restore the saved version of ${recovery.path}? The current text will be kept as another recovery copy.`)) return
    setEditorBusy(true); setEditorError(null)
    try {
      const updated = await restoreServerFileRecovery(serverId, recovery.id, editor.sha256)
      setEditor(updated); setEditorText(updated.text ?? ''); setRecoveries(await getServerFileRecoveries(serverId, updated.path))
      setNotice(`Restored a private recovery copy for ${updated.path}.`)
      await reload()
    } catch (issue) { setEditorError(issue instanceof Error ? issue.message : 'The recovery copy could not be restored.') }
    finally { setEditorBusy(false) }
  }

  async function createItem(event: FormEvent) {
    event.preventDefault()
    if (!dialog || (dialog !== 'file' && dialog !== 'folder')) return
    const name = dialogName.trim()
    if (!name) return
    setBusy(true); setError(null)
    try {
      const nextPath = path ? `${path}/${name}` : name
      setInventory(await createServerFile(serverId, nextPath, dialog, dialog === 'file' ? dialogText : undefined))
      setNotice(dialog === 'file' ? `Created ${nextPath}.` : `Created folder ${nextPath}.`)
      setDialog(null); setDialogName(''); setDialogText('')
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The item could not be created.') }
    finally { setBusy(false) }
  }

  async function moveItem(event: FormEvent) {
    event.preventDefault()
    if (!dialogEntry || !dialogName.trim()) return
    setBusy(true); setError(null)
    try {
      const destination = dialogName.trim().replace(/^\/+|\/+$/g, '')
      const next = await moveServerFile(serverId, dialogEntry.path, destination)
      setInventory(next); setNotice(`Moved ${dialogEntry.name} to ${destination}.`); setDialog(null); setDialogEntry(null); setDialogName('')
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The item could not be moved.') }
    finally { setBusy(false) }
  }

  async function uploadFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true); setProgress(0); setError(null)
    try { setInventory(await uploadServerFile(serverId, path, file, setProgress)); setNotice(`Uploaded ${file.name}.`) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'The file could not be uploaded.') }
    finally { setBusy(false); window.setTimeout(() => setProgress(null), 900) }
  }

  async function download(entry: ServerFileEntry) {
    setBusy(true); setError(null)
    try { await downloadServerFile(serverId, entry.path); setNotice(`Download started for ${entry.name}.`) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'The file could not be downloaded.') }
    finally { setBusy(false) }
  }

  async function moveToTrash(entry: ServerFileEntry) {
    const noun = entry.kind === 'folder' ? 'folder' : 'file'
    if (!window.confirm(`Move ${noun} “${entry.name}” to recoverable trash?`)) return
    setBusy(true); setError(null)
    try { const result = await trashServerFile(serverId, entry.path); setInventory(result.inventory); setNotice(`${entry.name} moved to recoverable trash.`) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'The item could not be moved to trash.') }
    finally { setBusy(false) }
  }

  async function toggleTrash() {
    if (!trashOpen) {
      try { setTrash(await getServerFileTrash(serverId)); setError(null) }
      catch (issue) { setError(issue instanceof Error ? issue.message : 'The trash could not be loaded.'); return }
    }
    setTrashOpen((current) => !current)
  }

  async function restoreTrashItem(item: ServerFileTrash) {
    if (!window.confirm(`Restore “${item.originalPath}” to its original location?`)) return
    setBusy(true); setError(null)
    try {
      const next = await restoreTrashedServerFile(serverId, item.id)
      setTrash((items) => items.filter((entry) => entry.id !== item.id))
      const parent = item.originalPath.split('/').slice(0, -1).join('/')
      setPath(parent); setInventory(next); setNotice(`Restored ${item.originalPath}.`)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The trashed item could not be restored.') }
    finally { setBusy(false) }
  }

  function beginMove(entry: ServerFileEntry) {
    setDialog('move'); setDialogEntry(entry); setDialogName(entry.path)
  }

  if (!managed) return <LockedDetail title="Read only folder" text="The file manager is available only for servers created and managed by MMSManager. Imported folders remain unchanged." />
  const parentPath = path.split('/').slice(0, -1).join('/')
  const changed = Boolean(editor && editorText !== editor.text)
  return <div className="local-files-layout">
    <Card className="local-files-card"><div className="local-files-header"><div><div className="card-kicker"><Folder size={15} /> Managed server files</div><h3>File browser</h3><p>Scoped to this server · no shell access</p></div><div className="local-files-header-actions"><Button icon={RotateCcw} disabled={busy || loading} onClick={() => void reload()}>Refresh</Button><Button icon={Archive} onClick={() => void toggleTrash()}>{trashOpen ? 'Hide trash' : `Trash${inventory?.trashCount ? ` · ${inventory.trashCount}` : ''}`}</Button></div></div>
      <div className="local-files-toolbar"><nav className="local-files-breadcrumbs" aria-label="Server folder path"><button type="button" onClick={() => setPath('')}>Server root</button>{inventory?.breadcrumbs.map((crumb) => <span key={crumb.path}><ChevronRight size={13} /><button type="button" onClick={() => setPath(crumb.path)}>{crumb.name}</button></span>)}</nav><div className="local-files-actions"><Button icon={FolderPlus} disabled={busy} onClick={() => { setDialog('folder'); setDialogName(''); setDialogText('') }}>New folder</Button><Button icon={FilePlus2} disabled={busy} onClick={() => { setDialog('file'); setDialogName(''); setDialogText('') }}>New text file</Button><label className="local-file-upload-button"><Upload size={15} />Upload<input type="file" accept=".txt,.log,.md,.json,.yaml,.yml,.toml,.xml,.csv,.cfg,.ini,.conf,.png,.jpg,.jpeg,.webp" disabled={busy} onChange={(event) => void uploadFile(event)} /></label></div></div>
      {progress !== null && <div className="local-file-progress" role="status"><span>Uploading file</span><progress max={100} value={progress} /><strong>{progress}%</strong></div>}
      {error && <div className="local-inline-error" role="alert">{error}<Button icon={RotateCcw} onClick={() => void reload()}>Retry</Button></div>}{notice && <div className="local-saved-note" role="status"><Check size={15} />{notice}</div>}
      {runtimeStatus === 'running' && <div className="local-file-warning"><RefreshCw size={15} /> The server is running. File edits may require a restart and should avoid files currently in use.</div>}
      <div className="local-file-list-head"><span>Name</span><span>Size</span><span>Last modified</span><span>Actions</span></div>
      {loading ? <div className="local-files-empty"><span className="loading-pulse" /> Loading managed server files…</div> : !inventory ? <div className="local-files-empty"><AlertTriangle size={19} /><strong>Folder unavailable</strong><span>{error ?? 'The server directory could not be read.'}</span></div> : <div className="local-file-list">
        {path && <div className="local-file-row local-file-up"><div className="local-file-primary"><span className="local-file-icon"><Folder size={17} /></span><button type="button" onClick={() => setPath(parentPath)}>Parent folder</button></div><span>—</span><span>—</span><span /> </div>}
        {inventory.entries.map((entry) => <div className="local-file-row" key={entry.path}>
          <div className="local-file-primary"><span className={`local-file-icon ${entry.kind === 'folder' ? 'is-folder' : ''}`}>{entry.kind === 'folder' ? <Folder size={17} /> : entry.contentState === 'protected' || entry.contentState === 'unsafe' ? <LockKeyhole size={16} /> : <FileText size={16} />}</span>
            {entry.kind === 'folder' ? <button type="button" className="local-file-name" onClick={() => setPath(entry.path)}>{entry.name}</button> : entry.name === 'server.properties' ? <Link className="local-file-name" to={`/servers/${serverId}/properties`}>{entry.name}</Link> : entry.canEdit ? <button type="button" className="local-file-name" onClick={() => void openTextFile(entry)}>{entry.name}</button> : <span className="local-file-name" title={entry.reason ?? undefined}>{entry.name}</span>}
            {entry.reason && <small className="local-file-state">{entry.contentState === 'protected' ? 'Protected' : entry.contentState === 'unsafe' ? 'Unsafe' : entry.contentState === 'oversized' ? 'Large text' : 'Read only'}</small>}
          </div><span className="local-file-size">{entry.kind === 'folder' ? 'Folder' : formatFileSize(entry.sizeBytes)}</span><span className="local-file-date">{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : 'Unavailable'}</span>
          <div className="local-file-row-actions">{entry.canDownload && <Button kind="quiet" icon={ArrowDownToLine} title={`Download ${entry.name}`} aria-label={`Download ${entry.name}`} disabled={busy} onClick={() => void download(entry)}>Download</Button>}{entry.canRename && <Button kind="quiet" icon={PencilLine} title={`Rename or move ${entry.name}`} aria-label={`Rename or move ${entry.name}`} disabled={busy} onClick={() => beginMove(entry)}>Move</Button>}{entry.canTrash && <Button kind="quiet" icon={Trash2} title={`Move ${entry.name} to trash`} aria-label={`Move ${entry.name} to trash`} disabled={busy} onClick={() => void moveToTrash(entry)}>Trash</Button>}</div>
        </div>)}
        {inventory.entries.length === 0 && <div className="local-files-empty"><Folder size={20} /><strong>This folder is empty</strong><span>Create a text file or folder, or upload a supported item.</span></div>}
        {inventory.truncated && <div className="local-files-limit">Showing the first 500 entries. Open a narrower folder to see more.</div>}
      </div>}
      {trashOpen && <div className="local-files-trash"><div className="local-files-subheading"><div><strong>Recoverable trash</strong><span>Items remain on disk until restored. Permanent deletion is not available here.</span></div><Badge>{trash.length} items</Badge></div>{trash.length ? trash.map((item) => <div className="local-file-trash-row" key={item.id}><span className="local-file-icon"><Archive size={15} /></span><span><strong>{item.originalPath}</strong><small>{item.kind === 'folder' ? 'Folder' : formatFileSize(item.sizeBytes)} · {new Date(item.deletedAt).toLocaleString()}</small></span><Button icon={RotateCcw} disabled={busy} onClick={() => void restoreTrashItem(item)}>Restore</Button></div>) : <div className="local-files-empty compact">Trash is empty.</div>}</div>}
      <p className="local-files-footnote"><LockKeyhole size={14} /> Protected assets, credentials, world folders and loader directories stay outside file-manager edits. Imported servers are unavailable here.</p>
    </Card>

    {dialog && <div className="local-file-dialog-backdrop"><section className="local-file-dialog" role="dialog" aria-modal="true" aria-labelledby="server-file-dialog-title"><div className="local-file-dialog-heading"><span className="local-backup-icon">{dialog === 'folder' ? <FolderPlus size={16} /> : dialog === 'file' ? <FilePlus2 size={16} /> : <PencilLine size={16} />}</span><div><h3 id="server-file-dialog-title">{dialog === 'folder' ? 'Create folder' : dialog === 'file' ? 'Create text file' : 'Rename or move item'}</h3><p>Paths are relative to the managed server folder.</p></div></div><form onSubmit={(event) => void (dialog === 'move' ? moveItem(event) : createItem(event))}><label className="field"><span className="field-label">{dialog === 'move' ? 'Destination path' : 'Name'}</span><input autoFocus value={dialogName} onChange={(event) => setDialogName(event.target.value)} placeholder={dialog === 'move' ? 'config/example.txt' : dialog === 'folder' ? 'config' : 'notes.txt'} /></label>{dialog === 'file' && <label className="field"><span className="field-label">Initial text</span><textarea rows={5} value={dialogText} onChange={(event) => setDialogText(event.target.value)} /></label>}{error && <div className="local-inline-error" role="alert">{error}</div>}<div className="local-file-dialog-actions"><Button type="button" disabled={busy} onClick={() => { setDialog(null); setDialogEntry(null); setError(null) }}>Cancel</Button><Button kind="primary" icon={dialog === 'move' ? PencilLine : dialog === 'folder' ? FolderPlus : FilePlus2} disabled={busy || !dialogName.trim()} type="submit">{busy ? 'Working…' : dialog === 'move' ? 'Move item' : dialog === 'folder' ? 'Create folder' : 'Create file'}</Button></div></form></section></div>}

    {editor && <div className="local-file-dialog-backdrop"><section className="local-file-dialog local-file-editor" role="dialog" aria-modal="true" aria-labelledby="server-text-editor-title"><div className="local-file-dialog-heading"><span className="local-backup-icon"><FileText size={16} /></span><div><h3 id="server-text-editor-title">Edit {editor.path}</h3><p>{formatFileSize(editor.sizeBytes)} · SHA-256 {editor.sha256?.slice(0, 16)}…</p></div><Button kind="quiet" onClick={() => { setEditor(null); setEditorError(null) }}>Close</Button></div>{editorError && <div className="local-inline-error" role="alert">{editorError}<Button icon={RotateCcw} onClick={() => void openTextFile({ name: editor.path.split('/').at(-1)!, path: editor.path, kind: 'file', sizeBytes: editor.sizeBytes, modifiedAt: editor.modifiedAt, contentState: 'editable', reason: null, canDownload: true, canEdit: true, canRename: true, canTrash: true })}>Reload file</Button></div>}<form onSubmit={(event) => void saveTextFile(event)}><textarea className="local-file-textarea" aria-label="Text file contents" spellCheck={false} value={editorText} onChange={(event) => setEditorText(event.target.value)} /><div className="local-file-editor-footer"><span>{changed ? 'Unsaved edits' : 'No unsaved edits'} · saves create a private recovery copy</span><Button kind="primary" icon={Check} disabled={!changed || editorBusy} type="submit">{editorBusy ? 'Saving…' : 'Save text'}</Button></div></form>{recoveries.length > 0 && <div className="local-file-recovery-list"><strong>Private recovery copies</strong>{recoveries.slice(0, 5).map((recovery) => <div key={recovery.id}><span>{new Date(recovery.createdAt).toLocaleString()} · SHA-256 {recovery.sha256.slice(0, 10)}…</span><Button kind="quiet" icon={RotateCcw} disabled={editorBusy || !editor.sha256} onClick={() => void restoreTextRecovery(recovery)}>Restore</Button></div>)}</div>}</section></div>}
  </div>
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function LocalMods({ serverId, software, managed, isAdmin, runtimeStatus }: { serverId: string; software: string; managed: boolean; isAdmin: boolean; runtimeStatus: string }) {
  const [inventory, setInventory] = useState<ServerModsInventory | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled' | 'quarantined'>('all')

  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      setInventory(await getServerMods(serverId, signal))
      setError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(issue instanceof Error ? issue.message : 'The mod inventory is unavailable.')
    } finally { setLoading(false) }
  }, [serverId])

  useEffect(() => {
    const controller = new AbortController()
    void reload(controller.signal)
    return () => controller.abort()
  }, [reload])

  const canMutate = Boolean(isAdmin && managed && inventory?.supported && ['stopped', 'running', 'crashed', 'error'].includes(runtimeStatus))
  const visibleItems = (inventory?.items ?? []).filter((item) => (filter === 'all' || item.state === filter)
    && `${item.fileName} ${item.modId ?? ''} ${item.name ?? ''} ${item.artifactVersion ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const mutate = async (work: () => Promise<ServerModsInventory>, success: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const updated = await work()
      setInventory(updated)
      setNotice(updated.restartRequired ? `${success} Restart required before the change takes effect.` : `${success} The file will be used the next time this server starts.`)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The file operation could not be completed.') }
    finally { setBusy(false) }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('mod-file')
    if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return
    const file = input.files[0]
    setBusy(true)
    setError(null)
    setNotice(null)
    setProgress(0)
    try {
      const updated = await uploadServerMod(serverId, file, setProgress)
      setInventory(updated)
      setNotice(updated.restartRequired ? 'JAR installed. Restart required before it is loaded.' : 'JAR installed. It will be loaded when the server starts.')
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The upload could not be completed.') }
    finally { setBusy(false); setProgress(null); input.value = ''; setSelectedFileName(null) }
  }

  const loaderLabel = software === 'fabric' ? 'Fabric mods' : software === 'paper' ? 'Paper plugins' : 'Mod and plugin files'
  return <div className="local-mods-layout">
    <Card className="local-mods-card">
      <div className="local-mods-header"><div><div className="card-kicker"><Package size={15} /> File-backed inventory</div><h3>{loaderLabel}</h3><p>Reads JAR metadata from the registered server directory. Archives are never extracted.</p></div><div className="local-mods-header-actions"><Badge tone={inventory?.supported ? 'good' : 'warn'}>{inventory?.supported ? inventory.loader : software === 'vanilla' ? 'Not supported' : 'Unknown loader'}</Badge><Button icon={RefreshCw} disabled={loading || busy} onClick={() => void reload()}>Reload</Button></div></div>
      {!managed && <div className="local-inline-note"><Shield size={15} /> Imported server folders are read only.</div>}
      {inventory?.restartRequired && <div className="local-restart-banner"><RefreshCw size={16} /><span><strong>Restart required</strong><small>File changes are saved, but a running server does not hot-load or unload mods.</small></span></div>}
      {error && <div className="local-inline-error" role="alert">{error}</div>}
      {notice && <div className="local-saved-note" role="status"><Check size={15} />{notice}</div>}
      {inventory?.supported && isAdmin && managed && <form className="local-mod-upload" onSubmit={(event) => void upload(event)}>
        <label className="local-mod-file-picker"><Upload size={16} /><span>{selectedFileName ?? 'Choose JAR to install'}</span><input name="mod-file" aria-label="Choose mod or plugin JAR" type="file" accept=".jar,application/java-archive" disabled={busy || !canMutate} onChange={(event) => setSelectedFileName(event.target.files?.[0]?.name ?? null)} required /></label>
        <Button kind="primary" icon={Upload} disabled={busy || !canMutate}>{progress === null ? 'Upload JAR' : `Uploading ${progress}%`}</Button>
        <small>Maximum 128 MiB. Duplicate filenames are rejected.</small>
        {progress !== null && <progress aria-label="JAR upload progress" max="100" value={progress} />}
      </form>}
      {loading && !inventory ? <div className="local-mods-state"><span className="loading-pulse" /> Reading the local mod directory…</div>
        : error && !inventory ? <div className="local-mods-state"><AlertTriangle size={20} /><strong>Inventory unavailable</strong><Button icon={RefreshCw} onClick={() => void reload()}>Retry</Button></div>
          : !inventory?.supported ? <div className="local-mods-state"><Package size={20} /><strong>This server type is not supported</strong><span>Stage 5B supports Fabric mods and Paper plugins. Vanilla and unknown loaders do not have a managed mod directory.</span></div>
            : <>
              <div className="local-mods-toolbar"><label className="local-mod-search"><Search size={15} /><input aria-label="Search mods and plugins" placeholder="Search files and metadata" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="local-mod-filters" aria-label="Filter mod files">{(['all', 'enabled', 'disabled', 'quarantined'] as const).map((value) => <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value[0]!.toUpperCase() + value.slice(1)}</button>)}</div></div>
              <div className="local-mod-counts"><span><strong>{inventory.items.filter((item) => item.state === 'enabled').length}</strong> enabled</span><span><strong>{inventory.items.filter((item) => item.state === 'disabled').length}</strong> disabled</span><span><strong>{inventory.items.filter((item) => item.state === 'quarantined').length}</strong> in quarantine</span><span className="local-mod-directory"><Folder size={13} /> {inventory.loadDirectory}/</span></div>
              {inventory.truncated && <div className="local-inline-note">The inventory reached its safe scan limit. Some files may not be shown.</div>}
              {visibleItems.length ? <div className="local-mod-list">{visibleItems.map((item) => <LocalModRow key={`${item.state}:${item.id}`} item={item} canMutate={canMutate} busy={busy} onEnable={() => void mutate(() => setServerModEnabled(serverId, item.fileName, true), 'Mod enabled.')} onDisable={() => void mutate(() => setServerModEnabled(serverId, item.fileName, false), 'Mod disabled.')} onQuarantine={() => { if (window.confirm(`Move ${item.fileName} to recoverable quarantine? The file will be preserved outside the loader directory.`)) void mutate(() => quarantineServerMod(serverId, item.fileName), 'File moved to quarantine.') }} onRestore={() => void mutate(() => restoreQuarantinedMod(serverId, item.id), 'File restored to the loader directory.')} />)}</div>
                : <div className="local-mods-state"><Package size={20} /><strong>{query ? 'No matching files' : filter === 'all' ? 'No mod or plugin JARs found' : `No ${filter} files`}</strong><span>{query ? 'Try a different search.' : `The ${inventory.loadDirectory}/ directory contains no recognized JAR files.`}</span></div>}
            </>}
      <div className="local-detail-callout"><Shield size={15} /><span>Disabled JARs and quarantined files are stored under this managed server's private .mmsmanager directory. Changes never delete file contents or hot-unload a running artifact.</span></div>
    </Card>
  </div>
}

function LocalModRow({ item, canMutate, busy, onEnable, onDisable, onQuarantine, onRestore }: { item: ServerModEntry; canMutate: boolean; busy: boolean; onEnable: () => void; onDisable: () => void; onQuarantine: () => void; onRestore: () => void }) {
  const stateTone = item.state === 'enabled' ? 'good' : item.state === 'quarantined' ? 'warn' : 'neutral'
  return <article className="local-mod-row"><span className={`local-mod-file-icon state-${item.state}`}><Package size={17} /></span><div className="local-mod-info"><div className="local-mod-title"><strong>{item.name ?? item.fileName}</strong><Badge tone={stateTone}>{item.state}</Badge>{item.metadataState === 'unknown' && <Badge>Metadata unknown</Badge>}</div><p><span>{item.fileName}</span>{item.modId && <span> · ID {item.modId}</span>}{item.artifactVersion && <span> · Version {item.artifactVersion}</span>}</p><small>{item.metadataKind === 'fabric' ? 'Fabric metadata' : item.metadataKind === 'paper' ? 'Paper plugin metadata' : 'No recognized metadata'}{item.minecraftConstraint ? ` · Minecraft ${item.minecraftConstraint}` : ''}{item.loaderConstraint ? ` · Loader ${item.loaderConstraint}` : ''}{item.dependencies === null ? ' · Dependencies unknown' : item.dependencies.length ? ` · Dependencies ${item.dependencies.join(', ')}` : ''} · {formatBytes(item.sizeBytes)}</small></div><div className="local-mod-actions">
    {item.state === 'enabled' && <Button disabled={!canMutate || busy} icon={Ban} onClick={onDisable}>Disable</Button>}
    {item.state === 'disabled' && <Button disabled={!canMutate || busy} icon={Check} onClick={onEnable}>Enable</Button>}
    {item.state === 'quarantined' ? <Button disabled={!canMutate || busy} icon={RotateCcw} onClick={onRestore}>Restore</Button> : <Button kind="quiet" disabled={!canMutate || busy} icon={Trash2} onClick={onQuarantine}>Quarantine</Button>}
  </div></article>
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}

function LockedDetail({ title, text }: { title: string; text: string }) {
  return <Card className="local-lock-card"><span><LockKeyhole size={20} /></span><h3>{title}</h3><p>{text}</p></Card>
}

function ComingSoonDetail({ section, serverName }: { section: string; serverName: string }) {
  const item = tabs.find((tab) => tab.id === section)
  const Icon = item?.icon ?? FileText
  return <div className="preview-section-layout"><Card className="preview-section-card"><div className="preview-section-header"><span className="preview-section-icon"><Icon size={20} /></span><div><h3>{sectionTitle(section)}</h3><p>Real {section} data is not available in this stage.</p></div><ComingSoon /></div><div className="local-coming-soon-message"><span className="local-server-icon"><Icon size={19} /></span><strong>{item?.label ?? 'Server tools'}</strong><span>The local page navigation is ready. This feature will be connected in a later stage.</span></div><div className="preview-section-footer"><span>Server: {serverName} · local registry</span><Link to="/servers">All servers <ChevronRight size={14} /></Link></div></Card><div className="local-detail-callout"><Shield size={15} /><span>There is no mock player, mod, world, file, backup or automation data attached to this real server.</span></div></div>
}

function LocalAccessPolicy({ server, isAdmin }: { server: LocalServerSummary; isAdmin: boolean }) {
  return <div className="local-access-layout"><Card className="local-access-card"><div className="local-access-heading"><span><Shield size={19} /></span><div><div className="card-kicker">Read only access view</div><h3>{server.name}</h3><p>{isAdmin ? 'You are an Administrator in this local workspace.' : 'You are a Member in this local workspace.'}</p></div><Badge tone={isAdmin ? 'good' : 'neutral'}>{isAdmin ? 'Administrator' : 'Member'}</Badge></div>
    <div className="local-access-grid"><div><strong>Workspace visibility</strong><p>All enabled local workspace accounts can see this registered server and its non-sensitive status pages.</p></div><div><strong>Administrator controls</strong><p>Only Administrators can start, stop or restart a managed server, edit properties, manage files, worlds, backups, runtime and schedules.</p></div><div><strong>Imported folders</strong><p>{server.source === 'imported' ? 'This folder is imported and remains read only, including for Administrators.' : 'Panel-created instances are managed only while their process identity and folder checks remain valid.'}</p></div></div>
    <div className="local-detail-callout"><LockKeyhole size={15} /><span>This project uses workspace roles only. Per-server member grants and access-control editing are not configured here.</span></div>
  </Card><Card className="local-access-summary"><SectionHeading title="Visible pages" description="Current server-view permissions" /><div><span>Overview, console and process logs</span><Badge>Workspace</Badge></div><div><span>Player events and supported mod inventory</span><Badge>Workspace</Badge></div><div><span>Properties, files, worlds and recovery</span><Badge tone={isAdmin ? 'good' : 'warn'}>{isAdmin ? 'Administrator' : 'Restricted'}</Badge></div></Card></div>
}
