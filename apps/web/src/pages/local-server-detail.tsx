import { currentLocale, pluralCount } from "../i18n/catalog"
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity, AlertTriangle, Archive, ArrowDownToLine, Ban, Check, ChevronRight, CircleCheck, Clock3, Cpu, FilePlus2, FileText, LoaderCircle,
  Folder, FolderPlus, FolderUp, Globe, HardDrive, Layers3, LockKeyhole, Package, PencilLine, Play, RefreshCw, RotateCcw, ScrollText,
  Search, Send, Server, Settings2, Shield, Square, Terminal, Trash2, Upload, Users, Wifi,
} from 'lucide-react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import type { LocalServerSummary, ServerConsoleEntry, ServerConsoleSession, ServerModEntry, ServerModsInventory, ServerRuntime, ServerStatus, ServerPlayerList, ServerPlayerAction, ServerFileEntry, ServerFileList, ServerFileRead, ServerFileRecovery, ServerFileTrash, ServerWorlds, ServerAccessPermissions, ServerAccessGrantUser } from '@mmsmanager/shared'
import {
  confirmLocalServerStopped, createServerFile, downloadServerFile, getAuthoritativePlayers, getMyServerAccess, getServerAccessUsers, getServerConsole, getServerConsoleSessions, getServerRuntime, getServerStatus, getServerFiles, getServerFileRecoveries, getServerFileTrash, getServerWorlds, restoreServerFileRecovery, restoreTrashedServerFile, sendPlayerAction, updateServerAccess,
  sendLocalServerCommand, startLocalServer, stopLocalServer, restartLocalServer, removeLocalServer,
  getServerMods, uploadServerMod, uploadServerFiles, setServerModEnabled, quarantineServerMod, restoreQuarantinedMod, moveServerFile, readServerFile, saveServerFileText, trashServerFile, updateServerMetadata,
} from '../api/servers'
import type { ServerFileUploadRequest } from '../api/servers'
import { ApiRequestError } from '../api/client'
import { translateText } from '../i18n/catalog'
import { useAuth } from '../state/use-auth'
import { Badge, Button, Card, ComingSoon, Field, SectionHeading } from '../components/ui'
import { LocalServerBackups } from './local-server-backups'
import { LocalServerRuntime } from './local-server-runtime'
import { LocalServerAutomation } from './local-server-automation'
import { ServerPropertiesEditor } from './server-properties-editor'

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
  const [permissions, setPermissions] = useState<ServerAccessPermissions | null>(null)
  const [accessDenied, setAccessDenied] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)

  useEffect(() => { setDisplayName(server.name); setNameDraft(server.name) }, [server.id, server.name])

  useEffect(() => {
    let active = true
    const refreshAccess = async () => {
      try {
        const result = await getMyServerAccess(server.id)
        if (active) { setPermissions(result.permissions); setAccessDenied(false); setAccessError(null) }
      } catch (issue) {
        if (!active) return
        if (issue instanceof ApiRequestError && (issue.status === 403 || issue.status === 404)) {
          setPermissions(null); setAccessDenied(true); setAccessError(null)
        } else setAccessError(accessText('Server permissions could not be refreshed.'))
      }
    }
    void refreshAccess()
    const timer = window.setInterval(() => void refreshAccess(), 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [server.id])

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
  const hasPermission = (capability: keyof ServerAccessPermissions) => isAdmin || permissions?.[capability] === true
  const canStartState = isManaged && ['stopped', 'crashed', 'error'].includes(status)
  const canStart = hasPermission('startServer') && canStartState && server.eula === 'accepted' && Boolean(server.jarName && server.javaMajor)
  const canStopState = isManaged && ['running', 'starting'].includes(status)
  const canStop = hasPermission('stopServer') && canStopState
  const canRestart = hasPermission('restartServer') && isManaged && status === 'running'
  const canConfirmStopped = isAdmin && isManaged && status === 'external/unmanaged'
  const canReadConsole = hasPermission('viewLogs') && isManaged && ['starting', 'running', 'stopping'].includes(status)
  const canReadPlayers = hasPermission('viewPlayers') && isManaged && status === 'running' && runtime?.ready === true
  const sectionCapability: Partial<Record<string, keyof ServerAccessPermissions>> = {
    overview: 'viewServer', console: 'viewLogs', logs: 'viewLogs', players: 'viewPlayers', mods: 'viewMods',
    files: 'viewFiles', properties: 'viewSettings', worlds: 'viewWorlds', backups: 'viewBackups',
  }
  if (accessDenied) return <div className="page-stack"><Card className="section-unavailable"><div className="local-console-empty"><Shield size={20} /><strong>{accessText('Server access was removed')}</strong><span>{accessText('This server is no longer available to your account.')}</span><Link to="/servers" className="text-link">{accessText('Return to servers')}</Link></div></Card></div>
  return <div className="page-stack server-detail-page local-detail-page">
    <div className="server-detail-heading">
      <div className="server-detail-identity"><span className="local-server-icon detail-server-icon"><Server size={19} /></span><div><div className="server-detail-title"><h1 data-no-translate>{displayName}</h1><Badge tone={statusTone}>{statusLabel(status)}</Badge></div><p>{server.software === 'unknown' ? 'Unknown software' : `${capitalize(server.software)}${server.version ? ` ${server.version}` : ''}`} <span>·</span> {server.port ? `Game port ${server.port}` : 'No game port detected'}</p></div></div>
      <div className="server-actions">
        {isAdmin && <Button kind="quiet" icon={PencilLine} onClick={() => { setNameDraft(displayName); setNameError(null); setNameDialogOpen(true) }}>Edit name</Button>}
        {isManaged && canStartState && <Button kind="primary" icon={Play} disabled={!canStart || busy} title={!hasPermission('startServer') ? 'Start permission has not been granted.' : server.eula !== 'accepted' ? 'EULA acceptance is required' : 'The server runtime is unavailable.'} onClick={() => void runAction('start')}>Start server</Button>}
        {canStopState && <Button kind="danger" icon={Square} disabled={!canStop || busy} title={!hasPermission('stopServer') ? 'Stop permission has not been granted.' : undefined} onClick={() => void runAction('stop')}>Stop server</Button>}
        {canConfirmStopped && <Button icon={CircleCheck} disabled={busy} onClick={() => void runAction('confirm')}>Confirm it has stopped</Button>}
        {isManaged && <Button icon={RefreshCw} disabled={!canRestart || busy} title={status === 'running' && !hasPermission('restartServer') ? 'Restart permission has not been granted.' : undefined} onClick={() => void runAction('restart')}>{busy && status === 'running' ? 'Restarting…' : 'Restart'}</Button>}
      </div>
    </div>
    <div className="server-detail-tabs" role="navigation" aria-label={`${displayName} pages`}>
      {tabs.map(({ id, label, icon: Icon }) => {
        const missingPermission = sectionCapability[id] !== undefined && !hasPermission(sectionCapability[id]!)
        const disabled = missingPermission || (id === 'console' && !canReadConsole) || (id === 'players' && !canReadPlayers) || ((id === 'runtime' || id === 'automation') && !isAdmin)
        const content = <><Icon size={15} />{label}</>
        return disabled
          ? <span key={id} className={`server-detail-tab-disabled ${section === id ? 'active' : ''}`} aria-disabled="true" title={missingPermission ? 'This server permission has not been granted.' : id === 'console' ? 'Available during a panel-owned process session.' : id === 'players' ? 'Available while a panel-owned server is ready.' : 'Administrator access is required.'}>{content}</span>
          : <NavLink key={id} to={`/servers/${server.id}/${id}`} className={section === id ? 'active' : ''}>{content}</NavLink>
      })}
    </div>
    <div className="server-section-heading"><div><p className="eyebrow">{displayName} / {active.label}</p><h2>{sectionTitle(section)}</h2></div></div>
    {(runtimeError || actionError || accessError) && <div className="local-runtime-alert" role="status"><AlertTriangle size={16} /><span>{actionError ?? runtimeError ?? accessText('Server permissions could not be refreshed.')}</span><Button icon={RefreshCw} onClick={() => { void refreshRuntime(); void getMyServerAccess(server.id).then((result) => setPermissions(result.permissions)).catch(() => undefined) }}>Retry</Button></div>}
    {runtime?.errorMessage && <div className="local-runtime-alert" role="status"><AlertTriangle size={16} /><span>{runtime.errorMessage}</span></div>}
    {runtime?.restartRequired && <div className="local-restart-banner" role="status"><RefreshCw size={16} /><span><strong>Restart required</strong><small>Server properties changed while this process was running. The new values take effect after the next start.</small></span></div>}
    {section === 'overview' && hasPermission('viewServer') && <><LocalOverview server={server} runtime={runtime} statusSample={statusSample} />{isAdmin && <LocalServerRemovalCard server={{ ...server, name: displayName }} />}</>}
    {section === 'players' && (canReadPlayers
      ? <LocalPlayers serverId={server.id} canView={hasPermission('viewPlayers')} canAct={hasPermission('moderatePlayers') && canReadPlayers} statusSample={statusSample} error={statusError} />
      : <SectionUnavailable title={isAdmin ? 'Players unavailable' : 'Administrator access required'} text={isAdmin ? 'Player names and moderation actions are available while a panel-owned server is ready.' : 'Player names and moderation actions require an administrator.'} />)}
    {section === 'mods' && hasPermission('viewMods') && <LocalMods serverId={server.id} software={server.software} managed={isManaged} canManage={hasPermission('manageMods')} runtimeStatus={status} />}
    {section === 'console' && (canReadConsole
      ? <LocalConsole serverId={server.id} runtime={runtime} canSendCommands={hasPermission('sendConsoleCommands')} />
      : <SectionUnavailable title="Console unavailable" text="The live console requires an active panel-owned process session. Historical process output remains available in Logs." logsHref={`/servers/${server.id}/logs`} />)}
    {section === 'logs' && hasPermission('viewLogs') && <LocalLogs serverId={server.id} runtimeStatus={status} />}
    {section === 'properties' && hasPermission('viewSettings') && <ServerPropertiesEditor serverId={server.id} managed={isManaged} runtimeStatus={runtime?.status ?? 'unavailable'} serverPort={server.port} canEdit={hasPermission('manageSettings')} canRestore={isAdmin} />}
    {section === 'files' && hasPermission('viewFiles') && <LocalFiles serverId={server.id} managed={isManaged} runtimeStatus={status} canManage={hasPermission('manageFiles')} />}
    {section === 'worlds' && hasPermission('viewWorlds') && <LocalWorlds serverId={server.id} managed={isManaged} />}
    {section === 'backups' && hasPermission('viewBackups') && <LocalServerBackups serverId={server.id} serverName={server.name} managed={isManaged} canView={hasPermission('viewBackups')} canCreate={hasPermission('createBackups')} isAdmin={isAdmin} runtimeStatus={status} />}
    {section === 'runtime' && <LocalServerRuntime serverId={server.id} managed={isManaged} isAdmin={isAdmin} />}
    {section === 'automation' && <LocalServerAutomation serverId={server.id} managed={isManaged} isAdmin={isAdmin} />}
    {section === 'access' && <LocalAccessPolicy server={{ ...server, name: displayName }} isAdmin={isAdmin} selfPermissions={permissions} accessError={accessError} />}
    {sectionCapability[section] && !hasPermission(sectionCapability[section]!) && <LockedDetail title={accessText('Access not granted')} text={accessText('Ask an Administrator to grant this server permission.')} />}
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

function LocalOverview({ server, runtime, statusSample }: { server: LocalServerSummary; runtime: ServerRuntime | null; statusSample: ServerStatus | null }) {
  return <>
    <div className="local-runtime-metrics">
      <div><span>Players online</span><strong>{statusSample?.state === 'reachable' ? statusSample.playersOnline : 'Unavailable'}</strong><small>{statusSample?.state === 'reachable' ? 'Local status ping · count only' : 'No current local status response'}</small></div>
      <div><span>Process memory</span><strong>{bytes(runtime?.memoryRssBytes ?? null)}</strong><small>Resident memory from this child process</small></div>
      <div><span>Uptime</span><strong>{duration(runtime?.uptimeSeconds ?? null)}</strong><small>{runtime?.startedAt ? `Started ${new Date(runtime.startedAt).toLocaleString(currentLocale())}` : 'No running process'}</small></div>
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
      </div></Card>
      <Card><SectionHeading title="Local process" description="Runtime values are separate from machine-wide telemetry." /><div className="local-process-state"><span className={`local-process-indicator ${runtime?.status === 'running' ? 'active' : ''}`} /><div><strong>{statusLabel(runtime?.status ?? server.runtimeStatus ?? 'unavailable')}</strong><small>{runtime?.ready ? 'Minecraft reported readiness in its output.' : runtime?.status === 'starting' ? 'Waiting for the Minecraft readiness line.' : 'No panel-owned ready process.'}</small></div></div>
        <div className="local-detail-facts compact"><div><span>Process CPU</span><strong>{runtime?.cpuPercent === null || runtime?.cpuPercent === undefined ? 'Unavailable' : `${runtime.cpuPercent.toFixed(1)}%`}</strong><small>Share of host capacity; needs two samples</small></div><div><span>Last exit code</span><strong>{runtime?.lastExitCode ?? '—'}</strong></div></div>
      </Card>
    </div>
  </>
}

function LocalServerRemovalCard({ server }: { server: LocalServerSummary }) {
  const navigate = useNavigate()
  const imported = server.source === 'imported' || !server.managed
  const [mode, setMode] = useState<'unregister' | 'permanent' | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tr = accessText
  const execute = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!mode || confirmation !== server.name || mode === 'permanent' && !understood) return
    setBusy(true)
    setError(null)
    try {
      const operation = await removeLocalServer(server.id, { mode, confirmation })
      window.dispatchEvent(new Event('mmsmanager:server-lifecycle'))
      if (operation.state === 'failed' || operation.state === 'recovery-required') {
        setError(operation.errorMessage ? tr(operation.errorMessage) : tr('The operation needs recovery. The server files were preserved.'))
        return
      }
      navigate('/servers')
    } catch (requestError) {
      setError(requestError instanceof Error ? tr(requestError.message) : tr('The server could not be removed.'))
    } finally { setBusy(false) }
  }
  const close = () => { if (busy) return; setMode(null); setConfirmation(''); setUnderstood(false); setError(null) }
  return <>
    <Card className="server-removal-card">
      <div><div className="server-removal-kicker"><AlertTriangle size={15} />{tr('Administrator actions')}</div><h3>{tr('Remove this server')}</h3><p>{imported ? tr('Unregistering removes this record and keeps the existing folder untouched.') : tr('You can unregister this server and keep its folder, or permanently delete its managed files.')}</p></div>
      {!imported && <Link className="server-removal-backup-link" to={`/servers/${server.id}/backups`}>{tr('Review existing backups')}</Link>}
      <div className="server-removal-actions"><Button kind="secondary" icon={Trash2} onClick={() => setMode('unregister')}>{tr('Unregister and keep files')}</Button>{!imported && <Button kind="danger" icon={Trash2} onClick={() => setMode('permanent')}>{tr('Delete server permanently')}</Button>}</div>
    </Card>
    {mode && <div className="local-file-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="local-file-dialog server-removal-dialog" role="dialog" aria-modal="true" aria-labelledby="server-removal-title">
        <div className="local-file-dialog-heading"><span className="server-removal-dialog-icon"><AlertTriangle size={17} /></span><div><h3 id="server-removal-title">{mode === 'unregister' ? tr('Unregister server') : tr('Permanently delete server files')}</h3><p>{mode === 'unregister' ? tr('The server record will be hidden. Its folder, worlds, backups and history are kept.') : tr('This removes the managed folder, including worlds, mods, settings and other server files. Existing backup archives, server history and audit records are kept separately. No new backup is created.')}</p></div></div>
        {mode === 'permanent' && <p className="server-removal-backup-hint"><Link to={`/servers/${server.id}/backups`} onClick={close}>{tr('Review existing backups')}</Link> · {tr('There may be no backup for this server.')}</p>}
        <form onSubmit={(event) => void execute(event)}>
          <Field label={`${tr('Type the exact server name to confirm')}: ${server.name}`}><input autoFocus autoComplete="off" spellCheck={false} maxLength={60} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>
          {mode === 'permanent' && <label className="server-removal-confirm-check"><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} /><span>{tr('I understand that this permanently deletes the server folder.')}</span></label>}
          {error && <div className="local-inline-error" role="alert">{error}</div>}
          <div className="local-file-dialog-actions"><Button type="button" disabled={busy} onClick={close}>{tr('Cancel')}</Button><Button kind={mode === 'permanent' ? 'danger' : 'primary'} icon={busy ? LoaderCircle : Trash2} disabled={busy || confirmation !== server.name || mode === 'permanent' && !understood}>{busy ? tr('Removing') : mode === 'unregister' ? tr('Unregister server') : tr('Permanently delete')}</Button></div>
        </form>
      </section>
    </div>}
  </>
}

const playerActionLabels: Record<ServerPlayerAction, string> = {
  kick: 'Kick player', ban: 'Ban player', pardon: 'Pardon ban', op: 'Grant operator', deop: 'Remove operator',
  'whitelist-add': 'Add to whitelist', 'whitelist-remove': 'Remove from whitelist', 'whitelist-list': 'List whitelist',
}
const playerActions: ServerPlayerAction[] = ['kick', 'ban', 'pardon', 'op', 'deop', 'whitelist-add', 'whitelist-remove', 'whitelist-list']

function LocalPlayers({ serverId, canView, canAct, statusSample, error }: { serverId: string; canView: boolean; canAct: boolean; statusSample: ServerStatus | null; error: string | null }) {
  const [players, setPlayers] = useState<ServerPlayerList | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<ServerPlayerAction>('kick')
  const [username, setUsername] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!canView) return
    setLoading(true)
    try {
      setPlayers(await getAuthoritativePlayers(serverId, signal))
      setListError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setListError(issue instanceof Error ? issue.message : 'The owned process player list is unavailable.')
    } finally { setLoading(false) }
  }, [serverId, canView])
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
        ? `The server confirmed ${playerActionLabels[action].toLowerCase()}${target ? ` for ${target}` : ''} at ${new Date(result.confirmedAt!).toLocaleTimeString(currentLocale())}.`
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
    <div className="local-detail-facts"><div><span>Online count</span><strong>{statusSample?.state === 'reachable' ? statusSample.playersOnline : 'Unavailable'}</strong></div><div><span>Maximum slots</span><strong>{statusSample?.state === 'reachable' ? statusSample.playersMax : 'Unavailable'}</strong></div><div><span>Count source</span><strong>Local status ping</strong></div><div><span>Checked</span><strong>{statusSample ? new Date(statusSample.checkedAt).toLocaleString(currentLocale()) : 'Waiting for response'}</strong></div></div>
    <div className="local-player-list"><div className="card-heading-row"><div><div className="card-kicker"><Users size={15} /> Owned process</div><h3>Online identities</h3></div>{canView && <Button icon={RefreshCw} disabled={loading} onClick={() => void refresh()}>Refresh list</Button>}</div>
      {!canView ? <p>Player visibility has not been granted.</p>
        : loading && !players ? <p>Asking the owned process for its player list…</p>
          : players?.state === 'authoritative' ? <><p>Reported by the owned console at {new Date(players.sampledAt!).toLocaleString(currentLocale())}. Names are not UUID verified.</p>{players.names.length ? <div className="local-player-names">{players.names.map((name) => <strong key={name}>{name}</strong>)}</div> : <p>No players were reported by the owned process.</p>}</>
            : <p>{players?.reason ?? 'An owned, ready process is required for a verified player list.'}</p>}
    </div>
    {canAct && <div className="local-player-actions"><SectionHeading title="Player commands" description="Fixed Minecraft commands sent only to this panel-owned process." />
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

function useConsoleHistory(serverId: string, runtimeStatus: string) {
  const [sessions, setSessions] = useState<ServerConsoleSession[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [entries, setEntries] = useState<ServerConsoleEntry[]>([])
  const [olderThan, setOlderThan] = useState<number | null>(null)
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cursor = useRef(0)
  const selectionVersion = useRef(0)
  const selected = sessions.find((session) => session.id === sessionId) ?? null
  const refreshSessions = useCallback(async (signal?: AbortSignal) => {
    const next = await getServerConsoleSessions(serverId, signal)
    if (signal?.aborted) return next
    setSessions(next)
    setSessionId((current) => next.some((session) => session.id === current)
      ? current
      : next.find((session) => session.live)?.id ?? next[0]?.id ?? null)
    setError(null)
    return next
  }, [serverId])

  useEffect(() => {
    const controller = new AbortController()
    void refreshSessions(controller.signal).catch((issue: unknown) => {
      if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : 'Console sessions are unavailable.')
    })
    return () => controller.abort()
  }, [refreshSessions, runtimeStatus])

  const hasLiveSession = sessions.some((session) => session.live)
  useEffect(() => {
    if (runtimeStatus !== 'starting' || hasLiveSession) return
    const timer = window.setInterval(() => {
      void refreshSessions().catch((issue: unknown) => setError(issue instanceof Error ? issue.message : 'Console sessions are unavailable.'))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [runtimeStatus, hasLiveSession, refreshSessions])

  useEffect(() => {
    const version = selectionVersion.current + 1
    selectionVersion.current = version
    cursor.current = 0
    setEntries([])
    setOlderThan(null)
    setLoadedSessionId(null)
    setError(null)
    if (!sessionId) return
    let active = true
    const controller = new AbortController()
    void getServerConsole(serverId, { sessionId, after: 0, limit: 200, signal: controller.signal }).then((result) => {
      if (!active || version !== selectionVersion.current) return
      if (result.sessionId !== sessionId) throw new Error('The server returned a different console session.')
      setEntries(result.entries)
      cursor.current = result.entries.at(-1)?.id ?? 0
      setOlderThan(result.olderThan)
      setLoadedSessionId(sessionId)
    }).catch((issue: unknown) => {
      if (active && !controller.signal.aborted) setError(issue instanceof Error ? issue.message : 'Process output is unavailable.')
    })
    return () => { active = false; controller.abort() }
  }, [serverId, sessionId])

  useEffect(() => {
    if (!sessionId || !selected?.live || loadedSessionId !== sessionId) return
    let active = true
    let timer = 0
    let controller: AbortController | null = null
    let retryDelay = 1000
    const poll = async () => {
      controller = new AbortController()
      try {
        for (let page = 0; page < 5 && active; page += 1) {
          const result = await getServerConsole(serverId, { sessionId, after: cursor.current, limit: 200, signal: controller.signal })
          if (!active) return
          if (result.sessionId !== sessionId) throw new Error('The server returned a different console session.')
          if (result.entries.length) {
            const latest = result.entries.at(-1)!.id
            cursor.current = Math.max(cursor.current, latest)
            setEntries((current) => {
              const known = new Set(current.map((entry) => entry.id))
              return [...current, ...result.entries.filter((entry) => !known.has(entry.id))].sort((left, right) => left.id - right.id).slice(-2000)
            })
          }
          if (result.nextAfter === null || !result.entries.length) break
        }
        if (!active) return
        retryDelay = 1000
        setError(null)
        timer = window.setTimeout(() => void poll(), 1000)
      } catch (issue) {
        if (!active || controller.signal.aborted) return
        setError(issue instanceof Error ? issue.message : 'Process output is unavailable.')
        retryDelay = Math.min(retryDelay * 2, 15_000)
        timer = window.setTimeout(() => void poll(), retryDelay)
      }
    }
    timer = window.setTimeout(() => void poll(), 1000)
    return () => { active = false; window.clearTimeout(timer); controller?.abort() }
  }, [serverId, sessionId, selected?.live, loadedSessionId])

  const loadOlder = useCallback(async () => {
    if (!sessionId || olderThan === null) return 0
    const version = selectionVersion.current
    const result = await getServerConsole(serverId, { sessionId, before: olderThan, limit: 200 })
    if (version !== selectionVersion.current) return 0
    if (result.sessionId !== sessionId) throw new Error('The server returned a different console session.')
    setEntries((current) => {
      const known = new Set(current.map((entry) => entry.id))
      return [...result.entries.filter((entry) => !known.has(entry.id)), ...current].sort((left, right) => left.id - right.id)
    })
    setOlderThan(result.olderThan)
    return result.entries.length
  }, [serverId, sessionId, olderThan])

  return { sessions, sessionId, setSessionId, selected, entries, olderThan, loadedSessionId, error, setError, refreshSessions, loadOlder }
}

function useLogTail(entries: ServerConsoleEntry[], sessionId: string | null) {
  const viewport = useRef<HTMLDivElement>(null)
  const [autoFollow, setAutoFollow] = useState(true)
  const [newLines, setNewLines] = useState(0)
  const lastId = useRef(0)
  useEffect(() => {
    lastId.current = 0
    setAutoFollow(true)
    setNewLines(0)
  }, [sessionId])
  useEffect(() => {
    const latest = entries.at(-1)?.id ?? 0
    const previous = lastId.current
    if (previous > 0 && latest > previous && !autoFollow) {
      setNewLines((current) => current + entries.filter((entry) => entry.id > previous).length)
    }
    lastId.current = latest
    if (autoFollow && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
      setNewLines(0)
    }
  }, [entries, autoFollow])
  const onScroll = useCallback(() => {
    const element = viewport.current
    if (element && autoFollow && element.scrollHeight - element.scrollTop - element.clientHeight > 48) {
      setAutoFollow(false)
      setNewLines(0)
    }
  }, [autoFollow])
  const jumpToLatest = useCallback(() => {
    setAutoFollow(true)
    setNewLines(0)
    requestAnimationFrame(() => { if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight })
  }, [])
  return { viewport, autoFollow, setAutoFollow, newLines, setNewLines, onScroll, jumpToLatest }
}

function sessionOutcomeLabel(outcome: ServerConsoleSession['outcome']) {
  return translateText(({ running: 'Running', stopped: 'Stopped', crashed: 'Crashed', interrupted: 'Interrupted', legacy: 'Older entries' })[outcome], currentLocale())
}

function ConsoleSessionPicker({ sessions, sessionId, onChange }: { sessions: ServerConsoleSession[]; sessionId: string | null; onChange: (id: string) => void }) {
  if (!sessions.length) return null
  return <label className="console-session-picker"><Clock3 size={14} /><span>{translateText('Session', currentLocale())}</span><select aria-label={translateText('Choose process session', currentLocale())} value={sessionId ?? ''} onChange={(event) => onChange(event.target.value)}>
    {sessions.map((session) => <option key={session.id} value={session.id}>{session.live ? translateText('Current session · Live', currentLocale()) : `${new Date(session.startedAt).toLocaleString(currentLocale())} · ${sessionOutcomeLabel(session.outcome)}`}</option>)}
  </select></label>
}

function LogFollowControls({ autoFollow, newLines, onToggle, onJump }: { autoFollow: boolean; newLines: number; onToggle: () => void; onJump: () => void }) {
  return <div className="log-follow-controls">
    <Button kind={autoFollow ? 'secondary' : 'quiet'} onClick={onToggle}>{autoFollow ? translateText('Auto-follow on', currentLocale()) : translateText('Auto-follow off', currentLocale())}</Button>
    {!autoFollow && newLines > 0 && <Button kind="primary" icon={ArrowDownToLine} onClick={onJump}>{pluralCount(newLines, currentLocale(), { en: ['new line', 'new lines'], ru: ['новая строка', 'новые строки', 'новых строк'] })} · {translateText('Jump to latest', currentLocale())}</Button>}
  </div>
}

function LocalConsole({ serverId, runtime, canSendCommands }: { serverId: string; runtime: ServerRuntime | null; canSendCommands: boolean }) {
  const history = useConsoleHistory(serverId, runtime?.status ?? 'unavailable')
  const tail = useLogTail(history.entries, history.sessionId)
  const [command, setCommand] = useState('')
  const [sending, setSending] = useState(false)
  const readySession = Boolean(history.selected?.live && canSendCommands && runtime?.status === 'running' && runtime.ready)
  const liveSession = Boolean(history.selected?.live)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = command.trim()
    if (!value || !readySession || sending) return
    setSending(true)
    try {
      await sendLocalServerCommand(serverId, value)
      setCommand('')
      history.setError(null)
    } catch (issue) { history.setError(issue instanceof Error ? issue.message : 'The command could not be sent.') }
    finally { setSending(false) }
  }
  return <div className="local-console-layout"><Card className="local-console-card"><div className="local-console-toolbar"><div><span className={`console-live-dot ${liveSession ? '' : 'idle'}`} /><strong>{liveSession ? runtime?.ready ? 'Connected to owned process' : 'Owned process starting' : statusLabel(runtime?.status ?? 'unavailable')}</strong><span>{pluralCount(history.entries.length, currentLocale(), { en: ['retained line loaded', 'retained lines loaded'], ru: ['строка загружена', 'строки загружено', 'строк загружено'] })}</span></div><Badge tone={liveSession ? 'good' : 'neutral'}>{liveSession ? 'Live output' : 'Session history'}</Badge></div>
    <div className="local-console-controls"><ConsoleSessionPicker sessions={history.sessions} sessionId={history.sessionId} onChange={history.setSessionId} /><LogFollowControls autoFollow={tail.autoFollow} newLines={tail.newLines} onToggle={() => { if (tail.autoFollow) { tail.setAutoFollow(false); tail.setNewLines(0) } else tail.jumpToLatest() }} onJump={tail.jumpToLatest} /></div>
    {history.error && <div className="local-inline-error" role="status">{history.error}<Button icon={RefreshCw} onClick={() => void history.refreshSessions()}>Retry</Button></div>}
    <div className="console-output local-console-output" ref={tail.viewport} onScroll={tail.onScroll} role="log" aria-label="Local server process output" aria-live="polite" aria-relevant="additions text">
      {history.entries.length ? history.entries.map((entry) => <div className="console-line" key={entry.id}><time>{new Date(entry.occurredAt).toLocaleTimeString(currentLocale())}</time><span className={`console-level level-${entry.severity}`}>{entry.source === 'stdout' ? 'OUT' : entry.source === 'stderr' ? 'ERR' : entry.source.toUpperCase()}</span><span>{entry.message}</span></div>) : <div className="local-console-empty"><Terminal size={22} /><strong>{history.sessions.length ? 'No output in this session' : 'Waiting for an owned process session'}</strong><span>{history.sessions.length ? 'Choose another launch to inspect its retained output.' : 'Console output appears after the managed process starts.'}</span></div>}
    </div>
    <form className="console-input-row local-command-row" onSubmit={(event) => void submit(event)}><span className="console-prompt">&gt;</span><input value={command} onChange={(event) => setCommand(event.target.value)} maxLength={256} disabled={!readySession || sending} placeholder={readySession ? 'Enter a Minecraft server command' : 'Commands require a ready owned server'} aria-label="Minecraft server command" /><kbd>Enter</kbd><Button kind="primary" disabled={!readySession || !command.trim() || sending} icon={Send}>{sending ? 'Sending…' : 'Send'}</Button></form>
  </Card><div className="local-console-side"><Card><SectionHeading title="Output source" description="Captured from the panel-owned Java child process." /><div className="local-source-list"><div><Wifi size={15} /><span>stdout and stderr</span></div><div><FileText size={15} /><span>Stored locally with bounded rotation</span></div><div><Shield size={15} /><span>Browser input goes to Minecraft stdin, never a shell</span></div></div></Card><div className="local-detail-callout"><AlertTriangle size={15} /><span>Commands are sent only while the process is ready and owned. Output is capped for display; raw logs remain in the private application data directory.</span></div></div></div>
}

function LocalLogs({ serverId, runtimeStatus }: { serverId: string; runtimeStatus: string }) {
  const history = useConsoleHistory(serverId, runtimeStatus)
  const tail = useLogTail(history.entries, history.sessionId)
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<string | null>(null)
  const filtered = useMemo(() => history.entries.filter((entry) => (level === 'all' || entry.severity === level) && `${entry.message} ${entry.source}`.toLowerCase().includes(query.toLowerCase())), [history.entries, level, query])
  async function loadOlder() {
    const viewport = tail.viewport.current
    const oldHeight = viewport?.scrollHeight ?? 0
    const oldTop = viewport?.scrollTop ?? 0
    tail.setAutoFollow(false)
    tail.setNewLines(0)
    setLoadingOlder(true); setOlderError(null)
    try {
      await history.loadOlder()
      requestAnimationFrame(() => { if (viewport) viewport.scrollTop = oldTop + viewport.scrollHeight - oldHeight })
    } catch (issue) { setOlderError(issue instanceof Error ? issue.message : 'Earlier process output could not be loaded.') }
    finally { setLoadingOlder(false) }
  }
  return <Card className="logs-card local-logs-card"><div className="logs-toolbar"><div className="filter-tabs" role="tablist" aria-label="Filter process log severity">{['all', 'info', 'warn', 'error', 'debug'].map((item) => <button key={item} role="tab" aria-selected={level === item} className={level === item ? 'selected' : ''} onClick={() => setLevel(item)}>{item === 'all' ? 'All' : item.toUpperCase()}</button>)}</div><label className="inline-search"><ScrollText size={15} /><input aria-label="Search local process logs" placeholder="Search output" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    <div className="local-logs-session-row"><ConsoleSessionPicker sessions={history.sessions} sessionId={history.sessionId} onChange={history.setSessionId} /><LogFollowControls autoFollow={tail.autoFollow} newLines={tail.newLines} onToggle={() => { if (tail.autoFollow) { tail.setAutoFollow(false); tail.setNewLines(0) } else tail.jumpToLatest() }} onJump={tail.jumpToLatest} /></div>
    {history.error && <div className="local-inline-error" role="status">{history.error}<Button icon={RefreshCw} onClick={() => void history.refreshSessions()}>Retry</Button></div>}
    {olderError && <div className="local-inline-error" role="status">{olderError}</div>}
    {history.olderThan !== null && <div className="logs-load-older"><Button kind="quiet" icon={ArrowDownToLine} disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? 'Loading…' : 'Load earlier lines'}</Button></div>}
    {filtered.length ? <div className="logs-list" ref={tail.viewport} onScroll={tail.onScroll} role="log" aria-label="Local server process logs" aria-live="polite">{filtered.map((entry) => <div className="log-row" key={entry.id}><time>{new Date(entry.occurredAt).toLocaleString(currentLocale())}</time><Badge tone={entry.severity === 'error' ? 'danger' : entry.severity === 'warn' ? 'warn' : 'neutral'}>{entry.severity.toUpperCase()}</Badge><span className="log-message">{entry.message}</span><span className="log-source">{entry.source}</span></div>)}</div> : <div className="local-console-empty"><ScrollText size={21} /><strong>{history.entries.length ? 'No matching process output' : 'No process output in this session'}</strong><span>{history.entries.length ? 'Clear the search or change the level filter.' : 'Older sessions remain available here after a panel-owned server stops.'}</span></div>}
    <div className="logs-foot"><span>{filtered.length} of {history.entries.length} loaded entries</span><span>{history.selected ? `${new Date(history.selected.startedAt).toLocaleString(currentLocale())} · ${sessionOutcomeLabel(history.selected.outcome)}` : 'Private local log history'}</span></div>
  </Card>
}

function SectionUnavailable({ title, text, logsHref }: { title: string; text: string; logsHref?: string }) {
  return <Card className="section-unavailable"><div className="local-console-empty"><Shield size={20} /><strong>{title}</strong><span>{text}</span>{logsHref && <Link to={logsHref} className="text-link"><ScrollText size={14} /> View process history</Link>}</div></Card>
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
      <div className="local-worlds-header"><div><div className="card-kicker"><Globe size={15} /> Worlds</div><h3>World folders</h3></div><Button icon={RotateCcw} disabled={loading} onClick={() => setReloadKey((value) => value + 1)}>Refresh</Button></div>
      {error && <div className="local-inline-error" role="alert">{error}<Button icon={RotateCcw} onClick={() => setReloadKey((value) => value + 1)}>Retry</Button></div>}
      {loading && <div className="local-files-empty" role="status"><span className="loading-pulse" /> Inspecting registered world folders…</div>}
      {!loading && worlds?.status === 'unavailable' && <div className="local-files-empty"><AlertTriangle size={19} /><strong>World inventory unavailable</strong><span>{worlds.reason}</span></div>}
      {worlds?.status === 'available' && <>
        <div className="local-worlds-level"><span>Configured level-name</span><strong>{worlds.levelName}</strong><Badge tone="neutral">{worlds.levelNameSource === 'minecraft-default' ? 'Minecraft default' : 'server.properties'}</Badge></div>
        <div className="local-world-list">
          {worlds.entries.map((world) => <article className="local-world-row" key={world.path}>
            <span className="local-world-icon"><Globe size={17} /></span>
            <div className="local-world-primary"><strong data-no-translate>{world.name}</strong><span data-no-translate>{world.path} · {world.dimension}</span>{world.reason && <small>{world.reason}</small>}</div>
            <Badge tone={world.state === 'available' ? 'good' : world.state === 'unsafe' ? 'danger' : 'warn'}>{world.state}</Badge>
            <div className="local-world-stat"><span>Stored size</span><strong>{world.sizeBytes === null ? 'Unavailable' : `${world.sizeComplete ? '' : '≥ '}${formatWorldSize(world.sizeBytes)}`}</strong></div>
            <div className="local-world-stat"><span>Last modified</span><strong>{world.modifiedAt ? new Date(world.modifiedAt).toLocaleString(currentLocale()) : 'Unavailable'}</strong></div>
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

type BrowserFileEntry = {
  name: string
  isFile: boolean
  isDirectory: boolean
  file?: (success: (file: File) => void, failure?: (error: DOMException) => void) => void
  createReader?: () => { readEntries: (success: (entries: BrowserFileEntry[]) => void, failure?: (error: DOMException) => void) => void }
}

const uploadErrorText: Record<string, string> = {
  BAD_REQUEST: 'The upload request is invalid.',
  FILE_ALREADY_EXISTS: 'A file or folder with that path already exists. Nothing was overwritten.',
  FILE_BATCH_EMPTY: 'Choose at least one file or folder.',
  FILE_BATCH_LIMIT: 'The upload exceeds its file, folder or total size limit.',
  FILE_BATCH_MISMATCH: 'The selected files did not match the upload list. No files were published.',
  FILE_CONTENT_REJECTED: 'A text file is not valid UTF-8 or exceeds the text limit.',
  FILE_MOUNT_CHECK_UNAVAILABLE: 'Filesystem boundaries could not be checked, so the upload was stopped.',
  FILE_MOUNT_REJECTED: 'Uploads cannot cross a nested filesystem boundary.',
  FILE_NAME_COLLISION: 'Two files or folders have names that collide. Nothing was overwritten.',
  FILE_PATH_REJECTED: 'The upload contains an unsafe or too-deep folder path.',
  FILE_PROTECTED: 'A selected path is protected. Use the dedicated server tools for that item.',
  FILE_TOO_LARGE: 'A file exceeds the 64 MiB limit.',
  FILE_UPLOAD_FAILED: 'The upload could not be completed. Refresh the folder and try again.',
  SERVER_NOT_PANEL_MANAGED: 'Files can only be uploaded to servers managed by MMSManager.',
}

function describeUploadFailure(issue: unknown): { message: string; path: string | null } {
  const candidate = issue as { message?: unknown; code?: unknown }
  const raw = typeof candidate?.message === 'string' ? candidate.message : 'The file upload could not be completed.'
  const code = typeof candidate?.code === 'string' ? candidate.code : ''
  const path = /(?:Upload failed for |File |Folder )“([^”]+)”/.exec(raw)?.[1]
    ?? /“([^”]+)” already exists/.exec(raw)?.[1]
    ?? null
  const english = uploadErrorText[code] ?? raw
  return { message: translateText(english, currentLocale()), path }
}

async function collectDroppedEntries(items: DataTransferItemList): Promise<{ files: { file: File; relativePath: string }[]; directories: string[] }> {
  const files: { file: File; relativePath: string }[] = []
  const directories: string[] = []
  const visit = async (entry: BrowserFileEntry, parent: string): Promise<void> => {
    const relativePath = parent ? `${parent}/${entry.name}` : entry.name
    if (entry.isFile && entry.file) {
      const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject))
      files.push({ file, relativePath })
      return
    }
    if (!entry.isDirectory || !entry.createReader) return
    directories.push(relativePath)
    const reader = entry.createReader()
    while (true) {
      const batch = await new Promise<BrowserFileEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) break
      for (const child of batch) await visit(child, relativePath)
    }
  }
  const candidates = Array.from(items)
  for (const item of candidates) {
    const directoryItem = item as DataTransferItem & { webkitGetAsEntry?: () => BrowserFileEntry | null }
    const entry = directoryItem.webkitGetAsEntry?.()
    if (entry) await visit(entry, '')
    else {
      const file = item.getAsFile()
      if (file) files.push({ file, relativePath: file.name })
    }
  }
  return { files, directories }
}

function LocalFiles({ serverId, managed, runtimeStatus, canManage }: { serverId: string; managed: boolean; runtimeStatus: string; canManage: boolean }) {
  const [path, setPath] = useState('')
  const [inventory, setInventory] = useState<ServerFileList | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState<{ message: string; path: string | null } | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [folderPickerSupported, setFolderPickerSupported] = useState(false)
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
  const uploadRequest = useRef<ServerFileUploadRequest | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => () => uploadRequest.current?.cancel(), [])
  useEffect(() => {
    const input = folderInput.current as (HTMLInputElement & { webkitdirectory?: boolean }) | null
    const supported = Boolean(input && 'webkitdirectory' in input)
    if (input && supported) { input.webkitdirectory = true; input.setAttribute('directory', '') }
    setFolderPickerSupported(supported)
  }, [])

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
    if (!canManage || !editor?.sha256) return
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
    if (!canManage || !editor?.sha256 || !window.confirm(`Restore the saved version of ${recovery.path}? The current text will be kept as another recovery copy.`)) return
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
    if (!canManage) return
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
    if (!canManage) return
    if (!dialogEntry || !dialogName.trim()) return
    setBusy(true); setError(null)
    try {
      const destination = dialogName.trim().replace(/^\/+|\/+$/g, '')
      const next = await moveServerFile(serverId, dialogEntry.path, destination)
      setInventory(next); setNotice(`Moved ${dialogEntry.name} to ${destination}.`); setDialog(null); setDialogEntry(null); setDialogName('')
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The item could not be moved.') }
    finally { setBusy(false) }
  }

  async function uploadSelection(files: { file: File; relativePath: string }[], directories: string[]) {
    if (!canManage) return
    if (!files.length && !directories.length) return
    setBusy(true); setProgress(0); setError(null); setNotice(null); setUploadError(null)
    try {
      const request = uploadServerFiles(serverId, path, files, directories, setProgress)
      uploadRequest.current = request
      setInventory(await request.promise)
      setNotice('Upload complete.')
    } catch (issue) {
      setUploadError(describeUploadFailure(issue))
    } finally {
      uploadRequest.current = null
      setBusy(false); setProgress(null); setDragActive(false)
    }
  }

  function uploadPickedFiles(event: React.ChangeEvent<HTMLInputElement>, kind: 'files' | 'folder') {
    const selected = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (!selected.length) {
      if (kind === 'folder') setUploadError({ message: translateText('This folder has no files. Use New folder to create an empty folder.', currentLocale()), path: null })
      return
    }
    const files = selected.map((file) => ({ file, relativePath: kind === 'folder' ? file.webkitRelativePath || file.name : file.name }))
    setUploadError(null)
    void uploadSelection(files, [])
  }

  async function uploadDroppedFiles(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDragActive(false)
    if (!canManage) return
    try {
      const selected = await collectDroppedEntries(event.dataTransfer.items)
      if (!selected.files.length && !selected.directories.length) {
        setUploadError({ message: translateText('Drop files or folders to upload them.', currentLocale()), path: null })
        return
      }
      void uploadSelection(selected.files, selected.directories)
    } catch (issue) {
      setUploadError(describeUploadFailure(issue))
    }
  }

  function cancelUpload() {
    uploadRequest.current?.cancel()
  }

  async function download(entry: ServerFileEntry) {
    setBusy(true); setError(null)
    try { await downloadServerFile(serverId, entry.path); setNotice(`Download started for ${entry.name}.`) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'The file could not be downloaded.') }
    finally { setBusy(false) }
  }

  async function moveToTrash(entry: ServerFileEntry) {
    if (!canManage) return
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
    if (!canManage) return
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
    <Card className="local-files-card"><div className="local-files-header"><div><h3>Files</h3></div><div className="local-files-header-actions"><Button icon={RotateCcw} disabled={busy || loading} onClick={() => void reload()}>Refresh</Button><Button icon={Archive} onClick={() => void toggleTrash()}>{trashOpen ? 'Hide trash' : `Trash${inventory?.trashCount ? ` · ${inventory.trashCount}` : ''}`}</Button></div></div>
      <div className="local-files-toolbar"><nav className="local-files-breadcrumbs" aria-label="Server folder path"><button type="button" onClick={() => setPath('')}>Server root</button>{inventory?.breadcrumbs.map((crumb) => <span key={crumb.path}><ChevronRight size={13} /><button type="button" onClick={() => setPath(crumb.path)}>{crumb.name}</button></span>)}</nav><div className="local-files-actions">{canManage && <><Button icon={FolderPlus} disabled={busy} onClick={() => { setDialog('folder'); setDialogName(''); setDialogText('') }}>New folder</Button><Button icon={FilePlus2} disabled={busy} onClick={() => { setDialog('file'); setDialogName(''); setDialogText('') }}>New text file</Button><label className="local-file-upload-button"><Upload size={15} /><span>Upload files</span><input ref={fileInput} data-testid="server-file-upload-input" type="file" multiple disabled={busy} onChange={(event) => uploadPickedFiles(event, 'files')} /></label><label className={`local-file-upload-button${folderPickerSupported ? '' : ' is-unavailable'}`} aria-disabled={!folderPickerSupported} title={folderPickerSupported ? undefined : 'Folder selection is not supported in this browser. Select multiple files instead.'}><FolderUp size={15} /><span>Upload folder</span><input ref={folderInput} data-testid="server-folder-upload-input" type="file" multiple disabled={busy || !folderPickerSupported} onChange={(event) => uploadPickedFiles(event, 'folder')} /></label></>}</div></div>
      {!folderPickerSupported && <p className="local-file-picker-note">Folder selection is not supported in this browser. Select multiple files instead.</p>}
      {progress !== null && <div className="local-file-progress" role="status"><span>Uploading files</span><progress max={100} value={progress} /><strong>{progress}%</strong><Button icon={Square} disabled={progress >= 100} onClick={cancelUpload}>Cancel upload</Button></div>}
      {error && <div className="local-inline-error" role="alert">{error}<Button icon={RotateCcw} onClick={() => void reload()}>Retry</Button></div>}
      {uploadError && <div className="local-inline-error local-file-upload-error" role="alert"><span>{uploadError.message}</span>{uploadError.path && <code data-no-translate>{uploadError.path}</code>}<Button icon={RotateCcw} onClick={() => { setUploadError(null); void reload() }}>Refresh</Button></div>}
      {notice && <div className="local-saved-note" role="status"><Check size={15} />{notice}</div>}
      {runtimeStatus === 'running' && <div className="local-file-warning"><RefreshCw size={15} /> The server is running. File edits may require a restart and should avoid files currently in use.</div>}
      <div className="local-file-list-head"><span>Name</span><span>Size</span><span>Last modified</span><span>Actions</span></div>
      {loading ? <div className="local-files-empty"><span className="loading-pulse" /> Loading managed server files…</div> : !inventory ? <div className="local-files-empty"><AlertTriangle size={19} /><strong>Folder unavailable</strong><span>{error ?? 'The server directory could not be read.'}</span></div> : <div className={`local-file-list${dragActive ? ' is-drag-active' : ''}`} onDragEnter={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) setDragActive(true) }} onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDragActive(true) } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false) }} onDrop={(event) => void uploadDroppedFiles(event)}>
        {dragActive && <div className="local-file-drop-message" role="status">Drop files or folders to upload them.</div>}
        {path && <div className="local-file-row local-file-up"><div className="local-file-primary"><span className="local-file-icon"><Folder size={17} /></span><button type="button" onClick={() => setPath(parentPath)}>Parent folder</button></div><span>—</span><span>—</span><span /> </div>}
        {inventory.entries.map((entry) => <div className="local-file-row" key={entry.path}>
          <div className="local-file-primary"><span className={`local-file-icon ${entry.kind === 'folder' ? 'is-folder' : ''}`}>{entry.kind === 'folder' ? <Folder size={17} /> : entry.contentState === 'protected' || entry.contentState === 'unsafe' ? <LockKeyhole size={16} /> : <FileText size={16} />}</span>
            {entry.kind === 'folder' ? <button type="button" className="local-file-name" onClick={() => setPath(entry.path)}>{entry.name}</button> : entry.name === 'server.properties' ? <Link className="local-file-name" to={`/servers/${serverId}/properties`}>{entry.name}</Link> : entry.canEdit ? <button type="button" className="local-file-name" onClick={() => void openTextFile(entry)}>{entry.name}</button> : <span className="local-file-name" title={entry.reason ?? undefined}>{entry.name}</span>}
            {entry.reason && <small className="local-file-state">{entry.contentState === 'protected' ? 'Protected' : entry.contentState === 'unsafe' ? 'Unsafe' : entry.contentState === 'oversized' ? 'Large text' : 'Read only'}</small>}
          </div><span className="local-file-size">{entry.kind === 'folder' ? 'Folder' : formatFileSize(entry.sizeBytes)}</span><span className="local-file-date">{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString(currentLocale()) : 'Unavailable'}</span>
          <div className="local-file-row-actions">{entry.canDownload && <Button kind="quiet" icon={ArrowDownToLine} title={`Download ${entry.name}`} aria-label={`Download ${entry.name}`} disabled={busy} onClick={() => void download(entry)}>Download</Button>}{canManage && entry.canRename && <Button kind="quiet" icon={PencilLine} title={`Rename or move ${entry.name}`} aria-label={`Rename or move ${entry.name}`} disabled={busy} onClick={() => beginMove(entry)}>Move</Button>}{canManage && entry.canTrash && <Button kind="quiet" icon={Trash2} title={`Move ${entry.name} to trash`} aria-label={`Move ${entry.name} to trash`} disabled={busy} onClick={() => void moveToTrash(entry)}>Trash</Button>}</div>
        </div>)}
        {inventory.entries.length === 0 && <div className="local-files-empty"><Folder size={20} /><strong>This folder is empty</strong><span>Create a text file or folder, or upload a supported item.</span></div>}
        {inventory.truncated && <div className="local-files-limit">Showing the first 500 entries. Open a narrower folder to see more.</div>}
      </div>}
      {trashOpen && <div className="local-files-trash"><div className="local-files-subheading"><div><strong>Recoverable trash</strong><span>Items remain on disk until restored. Permanent deletion is not available here.</span></div><Badge>{trash.length} items</Badge></div>{trash.length ? trash.map((item) => <div className="local-file-trash-row" key={item.id}><span className="local-file-icon"><Archive size={15} /></span><span><strong>{item.originalPath}</strong><small>{item.kind === 'folder' ? 'Folder' : formatFileSize(item.sizeBytes)} · {new Date(item.deletedAt).toLocaleString(currentLocale())}</small></span>{canManage && <Button icon={RotateCcw} disabled={busy} onClick={() => void restoreTrashItem(item)}>Restore</Button>}</div>) : <div className="local-files-empty compact">Trash is empty.</div>}</div>}
    </Card>

    {dialog && <div className="local-file-dialog-backdrop"><section className="local-file-dialog" role="dialog" aria-modal="true" aria-labelledby="server-file-dialog-title"><div className="local-file-dialog-heading"><span className="local-backup-icon">{dialog === 'folder' ? <FolderPlus size={16} /> : dialog === 'file' ? <FilePlus2 size={16} /> : <PencilLine size={16} />}</span><div><h3 id="server-file-dialog-title">{dialog === 'folder' ? 'Create folder' : dialog === 'file' ? 'Create text file' : 'Rename or move item'}</h3><p>Paths are relative to the managed server folder.</p></div></div><form onSubmit={(event) => void (dialog === 'move' ? moveItem(event) : createItem(event))}><label className="field"><span className="field-label">{dialog === 'move' ? 'Destination path' : 'Name'}</span><input autoFocus value={dialogName} onChange={(event) => setDialogName(event.target.value)} placeholder={dialog === 'move' ? 'config/example.txt' : dialog === 'folder' ? 'config' : 'notes.txt'} /></label>{dialog === 'file' && <label className="field"><span className="field-label">Initial text</span><textarea rows={5} value={dialogText} onChange={(event) => setDialogText(event.target.value)} /></label>}{error && <div className="local-inline-error" role="alert">{error}</div>}<div className="local-file-dialog-actions"><Button type="button" disabled={busy} onClick={() => { setDialog(null); setDialogEntry(null); setError(null) }}>Cancel</Button><Button kind="primary" icon={dialog === 'move' ? PencilLine : dialog === 'folder' ? FolderPlus : FilePlus2} disabled={busy || !dialogName.trim()} type="submit">{busy ? 'Working…' : dialog === 'move' ? 'Move item' : dialog === 'folder' ? 'Create folder' : 'Create file'}</Button></div></form></section></div>}

    {editor && <div className="local-file-dialog-backdrop"><section className="local-file-dialog local-file-editor" role="dialog" aria-modal="true" aria-labelledby="server-text-editor-title"><div className="local-file-dialog-heading"><span className="local-backup-icon"><FileText size={16} /></span><div><h3 id="server-text-editor-title">{canManage ? 'Edit' : 'View'} {editor.path}</h3><p>{formatFileSize(editor.sizeBytes)} · SHA-256 {editor.sha256?.slice(0, 16)}…</p></div><Button kind="quiet" onClick={() => { setEditor(null); setEditorError(null) }}>Close</Button></div>{editorError && <div className="local-inline-error" role="alert">{editorError}<Button icon={RotateCcw} onClick={() => void openTextFile({ name: editor.path.split('/').at(-1)!, path: editor.path, kind: 'file', sizeBytes: editor.sizeBytes, modifiedAt: editor.modifiedAt, contentState: 'editable', reason: null, canDownload: true, canEdit: true, canRename: true, canTrash: true })}>Reload file</Button></div>}<form onSubmit={(event) => void saveTextFile(event)}><textarea className="local-file-textarea" aria-label="Text file contents" spellCheck={false} value={editorText} readOnly={!canManage} onChange={(event) => setEditorText(event.target.value)} /><div className="local-file-editor-footer"><span>{canManage ? `${changed ? 'Unsaved edits' : 'No unsaved edits'} · saves create a private recovery copy` : 'Read only access'}</span>{canManage && <Button kind="primary" icon={Check} disabled={!changed || editorBusy} type="submit">{editorBusy ? 'Saving…' : 'Save text'}</Button>}</div></form>{canManage && recoveries.length > 0 && <div className="local-file-recovery-list"><strong>Private recovery copies</strong>{recoveries.slice(0, 5).map((recovery) => <div key={recovery.id}><span>{new Date(recovery.createdAt).toLocaleString(currentLocale())} · SHA-256 {recovery.sha256.slice(0, 10)}…</span><Button kind="quiet" icon={RotateCcw} disabled={editorBusy || !editor.sha256} onClick={() => void restoreTextRecovery(recovery)}>Restore</Button></div>)}</div>}</section></div>}
  </div>
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function LocalMods({ serverId, software, managed, canManage, runtimeStatus }: { serverId: string; software: string; managed: boolean; canManage: boolean; runtimeStatus: string }) {
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

  const canMutate = Boolean(canManage && managed && inventory?.supported && ['stopped', 'running', 'crashed', 'error'].includes(runtimeStatus))
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
      {inventory?.supported && canManage && managed && <form className="local-mod-upload" onSubmit={(event) => void upload(event)}>
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
  return <div className="preview-section-layout"><Card className="preview-section-card"><div className="preview-section-header"><span className="preview-section-icon"><Icon size={20} /></span><div><h3>{sectionTitle(section)}</h3><p>This section is not available yet.</p></div><ComingSoon /></div><div className="preview-section-footer"><span>{serverName}</span><Link to="/servers">All servers <ChevronRight size={14} /></Link></div></Card></div>
}

type AccessPermissionItem = { key: keyof ServerAccessPermissions; label: string; description: string; adminOnly?: boolean }
type AccessPermissionGroup = { title: string; permissions: AccessPermissionItem[] }
const accessGroups: AccessPermissionGroup[] = [
  { title: 'Server visibility', permissions: [{ key: 'viewServer', label: 'View overview and status', description: 'See this server in lists and inspect its status.' }] },
  { title: 'Console and logs', permissions: [
    { key: 'viewLogs', label: 'View console and process logs', description: 'Read live output and retained process sessions.' },
    { key: 'sendConsoleCommands', label: 'Unrestricted Minecraft console commands', description: 'Raw commands can bypass scoped permissions. Administrators only.', adminOnly: true },
  ] },
  { title: 'Server lifecycle', permissions: [
    { key: 'startServer', label: 'Start server', description: 'Start an eligible stopped managed server.' },
    { key: 'stopServer', label: 'Stop server', description: 'Gracefully stop a running panel-owned process.' },
    { key: 'restartServer', label: 'Restart server', description: 'Restart a running ready process; cannot start an offline server.' },
  ] },
  { title: 'Players', permissions: [
    { key: 'viewPlayers', label: 'View player names and events', description: 'Read the owned process player list and player history.' },
    { key: 'moderatePlayers', label: 'Moderate players', description: 'Submit fixed kick, ban, whitelist and operator commands.' },
  ] },
  { title: 'Mods and plugins', permissions: [
    { key: 'viewMods', label: 'View mod and plugin inventory', description: 'Read supported JAR metadata and status.' },
    { key: 'manageMods', label: 'Manage mod and plugin files', description: 'Upload, enable, disable, quarantine and restore JARs.' },
  ] },
  { title: 'Server files', permissions: [
    { key: 'viewFiles', label: 'View and download server files', description: 'Browse files, read supported text and download allowed items.' },
    { key: 'manageFiles', label: 'Change server files', description: 'Upload, create, edit, move, trash and recover files.' },
  ] },
  { title: 'Properties', permissions: [
    { key: 'viewSettings', label: 'View server properties', description: 'Read supported settings; protected values remain hidden.' },
    { key: 'manageSettings', label: 'Edit server properties', description: 'Change supported settings with safety confirmations.' },
  ] },
  { title: 'Worlds', permissions: [{ key: 'viewWorlds', label: 'View world inventory', description: 'Inspect detected managed world folders.' }] },
  { title: 'Backups', permissions: [
    { key: 'viewBackups', label: 'View and download backups', description: 'Inspect manifests and download retained archives.' },
    { key: 'createBackups', label: 'Create backups', description: 'Create a verified backup while the server is stopped.' },
  ] },
]
const accessDependencies: Partial<Record<keyof ServerAccessPermissions, keyof ServerAccessPermissions>> = {
  moderatePlayers: 'viewPlayers', manageMods: 'viewMods', manageFiles: 'viewFiles', manageSettings: 'viewSettings', createBackups: 'viewBackups',
}
const allAccessKeys = accessGroups.flatMap((group) => group.permissions.map((item) => item.key))
function accessText(value: string) { return translateText(value, currentLocale()) }
function applyPermissionChange(current: ServerAccessPermissions, key: keyof ServerAccessPermissions, checked: boolean): ServerAccessPermissions {
  const next = { ...current, [key]: checked }
  if (key === 'viewServer' && !checked) for (const field of allAccessKeys) next[field] = false
  const parent = accessDependencies[key]
  if (parent && checked) next[parent] = true
  if (checked && key !== 'viewServer') next.viewServer = true
  if (Object.values(accessDependencies).includes(key) && !checked) {
    for (const [dependent, dependency] of Object.entries(accessDependencies) as Array<[keyof ServerAccessPermissions, keyof ServerAccessPermissions]>) if (dependency === key) next[dependent] = false
  }
  return next
}

function AccessGroupCheckbox({ checked, mixed, disabled, label, onChange }: { checked: boolean; mixed: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <input ref={ref} type="checkbox" aria-label={accessText(label)} aria-checked={mixed ? 'mixed' : checked} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
}

function LocalAccessPolicy({ server, isAdmin, selfPermissions, accessError }: { server: LocalServerSummary; isAdmin: boolean; selfPermissions: ServerAccessPermissions | null; accessError: string | null }) {
  const [users, setUsers] = useState<ServerAccessGrantUser[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<ServerAccessPermissions | null>(null)
  const [loading, setLoading] = useState(isAdmin)
  const [saving, setSaving] = useState(false)
  const [accessMode, setAccessMode] = useState<'basic' | 'advanced'>('basic')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!isAdmin) { setLoading(false); return }
    setLoading(true)
    try {
      const result = await getServerAccessUsers(server.id, signal)
      setUsers(result)
      setError(null)
      setSelectedId((current) => result.some((user) => user.userId === current) ? current : result.find((user) => user.role === 'member')?.userId ?? '')
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(accessText('Server access could not be loaded.'))
    } finally { setLoading(false) }
  }, [isAdmin, server.id])
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load])

  const selectedUser = users.find((user) => user.userId === selectedId) ?? null
  useEffect(() => { setDraft(selectedUser?.permissions ?? null) }, [selectedId, selectedUser?.permissions])
  useEffect(() => { setNotice(null) }, [selectedId])
  const dirty = Boolean(selectedUser && draft && JSON.stringify(selectedUser.permissions) !== JSON.stringify(draft))
  function changePermission(key: keyof ServerAccessPermissions, checked: boolean) {
    setDraft((current) => current ? applyPermissionChange(current, key, checked) : current)
    setNotice(null)
  }
  function changePermissionGroup(group: AccessPermissionGroup, checked: boolean) {
    const keys = group.permissions.filter((item) => !item.adminOnly).map((item) => item.key)
    setDraft((current) => current ? keys.reduce((next, key) => applyPermissionChange(next, key, checked), current) : current)
    setNotice(null)
  }
  async function save() {
    if (!selectedUser || !draft || !dirty || !selectedUser.enabled) return
    setSaving(true); setError(null); setNotice(null)
    try {
      const updated = await updateServerAccess(server.id, selectedUser.userId, draft)
      setUsers(updated)
      const savedUser = updated.find((user) => user.userId === selectedUser.userId)
      if (savedUser) setDraft(savedUser.permissions)
      setNotice(accessText('Permissions saved and active immediately.'))
    } catch { setError(accessText('Permissions could not be saved.')) }
    finally { setSaving(false) }
  }

  const visiblePermissions = selfPermissions ?? allAccessKeys.reduce((result, key) => ({ ...result, [key]: false }), {} as ServerAccessPermissions)
  return <div className="local-access-layout access-control-layout">
    <Card className="local-access-card"><div className="local-access-heading"><span><Shield size={19} /></span><div><div className="card-kicker">{accessText('Server access')}</div><h3>{server.name}</h3><p>{accessText(isAdmin ? 'Administrators have full access to this server.' : 'These are the permissions assigned to your account for this server.')}</p></div><Badge tone={isAdmin ? 'good' : 'neutral'}>{accessText(isAdmin ? 'Administrator' : 'Member')}</Badge></div>
      {accessError && <div className="local-inline-error" role="status">{accessText('Your current server access could not be refreshed.')}</div>}
      {error && <div className="local-inline-error" role="alert">{error}</div>}
      {notice && <div className="local-saved-note" role="status"><Check size={15} />{notice}</div>}
      {isAdmin ? <>
        <div className="access-editor-toolbar"><label><span>{accessText('Member account')}</span><select aria-label={accessText('Choose member account')} value={selectedId} disabled={loading || users.every((user) => user.role !== 'member')} onChange={(event) => { setSelectedId(event.target.value); setError(null); setNotice(null) }}><option value="">{accessText('Choose a Member')}</option>{users.filter((user) => user.role === 'member').map((user) => <option key={user.userId} value={user.userId} disabled={!user.enabled}>{user.displayName} · @{user.username}{user.enabled ? '' : ` · ${accessText('Disabled')}`}</option>)}</select></label><Button icon={RefreshCw} disabled={loading || saving} onClick={() => void load()}>{loading ? accessText('Loading…') : accessText('Refresh')}</Button></div>
        {loading ? <div className="local-files-empty"><span className="loading-pulse" />{accessText('Loading member permissions…')}</div>
          : !users.some((user) => user.role === 'member') ? <div className="local-files-empty"><Users size={20} /><strong>{accessText('No Member accounts')}</strong><span>{accessText('Create a Member account in Users before assigning server access.')}</span></div>
            : selectedUser && draft ? <>
              <div className="access-selected-user"><div><strong>{selectedUser.displayName}</strong><span>@{selectedUser.username}</span></div><Badge tone={selectedUser.enabled ? 'good' : 'warn'}>{accessText(selectedUser.enabled ? 'Enabled' : 'Disabled')}</Badge></div>
              <div className="access-mode-switch" role="group" aria-label={accessText('Permission detail')}><button type="button" aria-pressed={accessMode === 'basic'} onClick={() => setAccessMode('basic')}>{accessText('Basic')}</button><button type="button" aria-pressed={accessMode === 'advanced'} onClick={() => setAccessMode('advanced')}>{accessText('Advanced')}</button></div>
              <div className="access-permission-groups">{accessGroups.map((group) => {
                const selectable = group.permissions.filter((item) => !item.adminOnly).map((item) => item.key)
                const count = selectable.filter((key) => draft[key]).length
                const all = selectable.length > 0 && count === selectable.length
                const mixed = count > 0 && !all
                const state = all ? 'All granted' : mixed ? 'Some granted' : 'None granted'
                return <fieldset key={group.title} className="access-permission-group" disabled={!selectedUser.enabled || saving}><legend>{accessText(group.title)}</legend>
                  {accessMode === 'basic' ? <label className="access-group-toggle"><AccessGroupCheckbox checked={all} mixed={mixed} disabled={!selectedUser.enabled || saving} label={group.title} onChange={(checked) => changePermissionGroup(group, checked)} /><span><strong>{accessText(group.title)}</strong><small>{accessText(state)}</small></span></label>
                    : group.permissions.map(({ key, label, description, adminOnly }) => adminOnly
                      ? <div className="access-permission-row access-admin-row" key={key}><LockKeyhole size={14} /><span><strong>{accessText(label)}</strong><small>{accessText(description)}</small></span><Badge tone="warn">{accessText('Administrator only')}</Badge></div>
                      : <label className="access-permission-row" key={key}><input type="checkbox" checked={draft[key]} disabled={!selectedUser.enabled || saving} onChange={(event) => changePermission(key, event.target.checked)} /><span><strong>{accessText(label)}</strong><small>{accessText(description)}</small></span></label>)}
                </fieldset>
              })}</div>
              {accessMode === 'basic' && <div className="access-admin-only"><LockKeyhole size={15} /><span>{accessText('Unrestricted console commands are Administrator-only because raw commands can bypass scoped permissions.')}</span></div>}
              <div className="access-admin-only"><LockKeyhole size={15} /><span>{accessText('Only Administrators can manage accounts, installations, runtime settings, schedules, backup restore and server deletion.')}</span></div>
              <div className="access-save-row"><span>{accessText('Changes are recorded in local audit history.')}</span><Button kind="primary" icon={saving ? RefreshCw : Check} disabled={!dirty || saving || !selectedUser.enabled} onClick={() => void save()}>{saving ? accessText('Saving…') : accessText('Save permissions')}</Button></div>
            </> : <div className="local-files-empty"><Users size={20} /><span>{accessText('Choose a Member account to review its access.')}</span></div>}
      </> : <>
        <SectionHeading title={accessText('Your server permissions')} description={accessText('Permission changes take effect immediately when an Administrator saves them.')} />
        <div className="access-permission-groups access-self-groups">{accessGroups.map((group) => <section key={group.title} className="access-permission-group"><h4>{accessText(group.title)}</h4>{group.permissions.map(({ key, label, description, adminOnly }) => <div className="access-permission-row self" key={key}><span className={`access-permission-state ${visiblePermissions[key] ? 'granted' : ''}`}>{adminOnly ? <LockKeyhole size={13} /> : visiblePermissions[key] ? <Check size={14} /> : <LockKeyhole size={13} />}</span><span><strong>{accessText(label)}</strong><small>{accessText(description)}</small></span><Badge tone={adminOnly ? 'warn' : visiblePermissions[key] ? 'good' : 'neutral'}>{accessText(adminOnly ? 'Administrator only' : visiblePermissions[key] ? 'Granted' : 'Not granted')}</Badge></div>)}</section>)}</div>
        <div className="access-admin-only"><LockKeyhole size={15} /><span>{accessText('Only Administrators can manage accounts, installations, runtime settings, schedules, backup restore and server deletion.')}</span></div>
      </>}
    </Card>
    <Card className="local-access-summary"><SectionHeading title={accessText('Access rules')} description={accessText('Each account has its own permissions for this server.')} /><div><span>{accessText('Changes take effect as soon as they are saved.')}</span><Badge tone="good">{accessText('Immediate')}</Badge></div><div><span>{accessText('Members see only their own permissions.')}</span><Badge>{accessText('Private')}</Badge></div><div><span>{accessText(server.source === 'imported' ? 'Imported folders stay read only.' : 'Server management is available only for servers created by MMSManager.')}</span><Badge tone="warn">{accessText(server.source === 'imported' ? 'Read only' : 'Managed only')}</Badge></div></Card>
  </div>
}
