import { useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowDownToLine, ArrowRight, Box, Braces, Check, ChevronRight, Clock3, Command,
  Cpu, FileText, Folder, Globe, HardDrive, KeyRound, Layers3, MoreHorizontal, Radio,
  RotateCw, ScrollText, Search, Settings2, Shield, ShieldAlert, Terminal, Users,
} from 'lucide-react'
import { Link, NavLink, useLocation, useParams } from 'react-router-dom'
import { formatMemory, mockLogs, mockMods, servers } from '../data'
import { ResourceTimeline, WorldBlocks } from '../components/charts'
import { Badge, Button, Card, ComingSoon, DisabledButton, Field, PageHeading, PreviewFlag, SectionHeading, StatusDot, SwitchPreview } from '../components/ui'
import { getLocalServers } from '../api/servers'
import type { LocalServerSummary } from '@mmsmanager/shared'
import { LocalServerDetail } from './local-server-detail'

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

export function ServerDetailPage() {
  const { serverId } = useParams()
  const location = useLocation()
  const [localServer, setLocalServer] = useState<LocalServerSummary | null>(null)
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const isLocalId = Boolean(serverId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serverId))
  useEffect(() => {
    if (!isLocalId || !serverId) return
    const controller = new AbortController()
    setLocalServer(null)
    setLocalLoading(true)
    void getLocalServers(controller.signal).then((items) => {
      setLocalServer(items.find((item) => item.id === serverId) ?? null)
      setLocalError(null)
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setLocalError(error instanceof Error ? error.message : 'The local server could not be loaded.')
    }).finally(() => setLocalLoading(false))
    return () => controller.abort()
  }, [isLocalId, serverId])
  if (isLocalId) {
    if (localLoading || (!localServer && !localError)) return <div className="page-stack"><PageHeading title="Loading local server" description="Reading the authenticated local registry." /></div>
    if (localServer) return <LocalServerDetail server={localServer} />
    return <div className="page-stack"><PageHeading title="Local server unavailable" description={localError ?? 'This server is not registered in the local inventory.'} /><Link className="text-link" to="/servers">Return to servers <ArrowRight size={14} /></Link></div>
  }
  const server = servers.find((item) => item.id === serverId)
  if (!server) return <div className="page-stack"><PageHeading title="Unknown server" description="This sample server is not in the preview data." /><Link className="text-link" to="/servers">Return to servers <ArrowRight size={14} /></Link></div>
  const section = location.pathname.split('/')[3] || 'overview'
  const active = tabs.find((tab) => tab.id === section) ?? tabs[0]!
  return <div className="page-stack server-detail-page">
    <div className="server-detail-heading"><div className="server-detail-identity"><WorldBlocks server={server} /><div><div className="server-detail-title"><h1>{server.name}</h1><Badge tone={server.status === 'Online' ? 'good' : 'neutral'}><StatusDot status={server.status} />{server.status}</Badge></div><p>{server.software} {server.version} <span>·</span> {server.address}</p></div></div>
      <div className="server-actions"><div className="server-action-disabled"><Button disabled kind="primary">{server.status === 'Offline' ? 'Start server' : 'Stop server'}</Button><ComingSoon /></div><DisabledButton icon={RotateCw}>Restart</DisabledButton><button className="icon-button" aria-label="More server actions" title="More actions coming soon" disabled><MoreHorizontal size={18} /></button></div>
    </div>
    <div className="server-detail-tabs" role="navigation" aria-label={`${server.name} pages`}>{tabs.map(({ id, label, icon: Icon }) => <NavLink key={id} to={`/servers/${server.id}/${id}`} className={section === id ? 'active' : ''}><Icon size={15} />{label}{['files', 'worlds', 'runtime', 'backups', 'automation', 'access'].includes(id) && <span className="tab-preview-dot" />}</NavLink>)}</div>
    <div className="server-section-heading"><div><p className="eyebrow">{server.name} / {active.label}</p><h2>{sectionTitle(section)}</h2></div><PreviewFlag>Mock server data</PreviewFlag></div>
    {section === 'overview' && <ServerOverview server={server} />}
    {section === 'console' && <ConsolePage serverName={server.name} />}
    {section === 'logs' && <LogsPage />}
    {section === 'players' && <PlayersPage server={server} />}
    {section === 'mods' && <ModsPage server={server} />}
    {section === 'properties' && <PropertiesPage />}
    {['files', 'worlds', 'runtime', 'backups', 'automation', 'access'].includes(section) && <PreviewSection section={section} serverName={server.name} />}
  </div>
}

function sectionTitle(section: string) {
  const titles: Record<string, string> = { overview: 'Server overview', console: 'Console preview', logs: 'Log history', players: 'Player directory', mods: 'Installed mods', properties: 'Visual properties', files: 'File browser preview', worlds: 'Worlds preview', runtime: 'Runtime preview', backups: 'Backup preview', automation: 'Automation preview', access: 'Access preview' }
  return titles[section] ?? 'Server overview'
}

function ServerOverview({ server }: { server: (typeof servers)[number] }) {
  return <>
    <div className="server-metric-strip"><div><span>Players</span><strong>{server.players}<small> / {server.capacity}</small></strong><span className="metric-subline">Current sample</span></div><div><span>Memory used</span><strong>{formatMemory(server.memoryUsed)}<small> / {server.memoryTotal} GB</small></strong><span className="metric-subline">Mock allocation</span></div><div><span>Uptime</span><strong>{server.uptime}</strong><span className="metric-subline">Sample status</span></div><div><span>World</span><strong>{server.world}</strong><span className="metric-subline">Preview record</span></div></div>
    <div className="server-overview-grid"><Card className="server-perf-card"><div className="card-heading-row"><div><div className="card-kicker"><Cpu size={15} /> Server performance</div><h2>Resource trend</h2></div><Badge>Last 24 hours</Badge></div><ResourceTimeline /><div className="server-perf-foot"><span><i className="legend-dot accent" />CPU 36%</span><span><i className="legend-dot muted" />Memory 5.2 GB of 8 GB</span><span>Sample only</span></div></Card>
      <Card className="world-card"><div className="card-heading-row"><div><div className="card-kicker"><Globe size={15} /> Active world</div><h2>{server.world}</h2></div><MoreHorizontal size={17} /></div><div className={`world-scene scene-${server.accent}`}><div className="scene-skyline"><i /><i /><i /><i /><i /><i /></div><div className="scene-ground"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="scene-structure"><span /><span /><span /><span /><span /><span /><span /><span /></div><div className="scene-coordinate">X 248 <span>·</span> Z −116</div></div><div className="world-card-foot"><span><strong>World status</strong><small>Overworld · sample view</small></span><Badge tone="good">Available</Badge></div></Card>
    </div>
    <Card className="server-quick-card"><div className="card-heading-row"><div><div className="card-kicker"><FileText size={15} /> At a glance</div><h2>Sample configuration</h2></div><Link className="text-link" to={`/servers/${server.id}/properties`}>View properties <ArrowRight size={14} /></Link></div><div className="quick-config-grid"><div><span>Game mode</span><strong>Survival</strong></div><div><span>Difficulty</span><strong>Normal</strong></div><div><span>Whitelist</span><strong>Enabled</strong></div><div><span>View distance</span><strong>10 chunks</strong></div><div><span>Java runtime</span><strong>Java 21</strong></div><div><span>Auto restart</span><strong>Disabled</strong></div></div></Card>
  </>
}

function ConsolePage({ serverName }: { serverName: string }) {
  return <div className="console-layout"><Card className="console-card"><div className="console-toolbar"><div><span className="console-live-dot" /><strong>Sample console stream</strong><span className="console-server">{serverName}</span></div><div><Badge>Read-only preview</Badge><button className="icon-button" disabled aria-label="Download console output, coming soon"><ArrowDownToLine size={16} /></button></div></div><div className="console-output" role="log" aria-label="Mock server console output">{mockLogs.map((row, index) => <div className="console-line" key={`${row.time}-${index}`}><time>{row.time}</time><span className={`console-level level-${row.level.toLowerCase()}`}>{row.level}</span><span>{row.message}</span></div>)}</div><div className="console-input-row"><span className="console-prompt">&gt;</span><input disabled placeholder="Console input is coming soon" aria-label="Console command input" /><kbd><Command size={11} /> Enter</kbd><Button disabled icon={ChevronRight}>Send</Button></div></Card><div className="console-side"><Card><SectionHeading title="Stream status" /><div className="stream-status"><span className="stream-status-icon"><Radio size={17} /></span><div><strong>Not connected</strong><span>Static sample output</span></div></div><div className="console-stat"><span>Lines shown</span><strong>{mockLogs.length}</strong></div><div className="console-stat"><span>Data source</span><strong>Mock fixture</strong></div></Card><div className="preview-note"><Terminal size={16} /><span><strong>Console is read-only</strong><small>Commands are disabled. No process or RCON connection exists.</small></span></div></div></div>
}

function LogsPage() {
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<'All levels' | 'INFO' | 'WARN'>('All levels')
  const filtered = useMemo(() => mockLogs.filter((item) => (level === 'All levels' || item.level === level) && `${item.message} ${item.source}`.toLowerCase().includes(query.toLowerCase())), [level, query])
  return <div className="logs-layout"><Card className="logs-card"><div className="logs-toolbar"><div className="filter-tabs" role="tablist" aria-label="Filter log level">{(['All levels', 'INFO', 'WARN'] as const).map((item) => <button className={level === item ? 'selected' : ''} key={item} role="tab" aria-selected={level === item} onClick={() => setLevel(item)}>{item}</button>)}</div><label className="inline-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search log messages" aria-label="Search log messages" /></label></div><div className="logs-list">{filtered.map((row) => <div className="log-row" key={row.time}><time>{row.time}</time><Badge tone={row.level === 'WARN' ? 'warn' : 'neutral'}>{row.level}</Badge><span className="log-message">{row.message}</span><span className="log-source">{row.source}</span></div>)}</div><div className="logs-foot"><span>{filtered.length} of {mockLogs.length} sample lines</span><span>Original stream is not connected</span></div></Card><div className="logs-side"><Card><SectionHeading title="Log source" /><div className="log-source-card"><span className="source-file-icon"><Braces size={17} /></span><div><strong>latest.log</strong><small>Sample file · read-only</small></div><Badge>Preview</Badge></div><p className="muted-paragraph">Filtering here works on the example rows in this page. No server log files are read.</p></Card><DisabledButton icon={ArrowDownToLine}>Export logs</DisabledButton></div></div>
}

const players = [
  { name: 'MiraWoods', id: '71a2…8f4e', seen: 'Online now', time: '02:14:32', status: 'Online' },
  { name: 'RiverOtter', id: '17c0…2b91', seen: 'Online now', time: '01:48:10', status: 'Online' },
  { name: 'StoneFern', id: 'c2a9…6d14', seen: 'Online now', time: '00:52:06', status: 'Online' },
  { name: 'PixelBirch', id: '3b14…a0c8', seen: 'Last seen yesterday', time: '—', status: 'Offline' },
]

function PlayersPage({ server }: { server: (typeof servers)[number] }) {
  return <div className="page-stack-inner"><div className="server-metric-strip player-stat-strip"><div><span>Player slots</span><strong>{server.players}<small> / {server.capacity}</small></strong><span className="metric-subline">Sample snapshot</span></div><div><span>Whitelist</span><strong>Enabled</strong><span className="metric-subline">Preview setting</span></div><div><span>Banned players</span><strong>2</strong><span className="metric-subline">Sample record count</span></div><div><span>Player actions</span><strong>Disabled</strong><span className="metric-subline">Coming soon</span></div></div><Card className="data-table-card"><div className="table-title-row"><div><h2>Player list</h2><p>Sample identities and session history</p></div><DisabledButton icon={Users}>Invite player</DisabledButton></div><div className="data-table players-table"><div className="data-table-head"><span>Player</span><span>UUID</span><span>Last seen</span><span>Play time</span><span /></div>{players.map((player) => <div className="data-table-row" key={player.name}><span className="player-cell"><span className={`player-avatar player-${player.status.toLowerCase()}`}>{player.name.slice(0, 1)}</span><span><strong>{player.name}</strong><small><StatusDot status={player.status as 'Online' | 'Offline'} />{player.status}</small></span></span><code>{player.id}</code><span>{player.seen}</span><span>{player.time}</span><button className="row-action" disabled title="Coming soon"><span>Manage</span><ComingSoon /></button></div>)}</div><div className="players-mobile-list">{players.map((player) => <div className="player-mobile-row" key={`${player.name}-mobile`}><span className={`player-avatar player-${player.status.toLowerCase()}`}>{player.name.slice(0, 1)}</span><div><strong>{player.name}</strong><small>{player.seen} · {player.time}</small></div><Badge tone={player.status === 'Online' ? 'good' : 'neutral'}>{player.status}</Badge></div>)}</div><div className="preview-note compact-note"><ShieldAlert size={15} /><span><strong>Moderation controls are unavailable</strong><small>Ban, kick, whitelist and invite actions are disabled in this stage.</small></span></div></Card></div>
}

function ModsPage({ server }: { server: (typeof servers)[number] }) {
  return <div className="page-stack-inner"><div className="mods-summary"><div><span className="mods-summary-icon"><Layers3 size={18} /></span><div><strong>{mockMods.length} sample mods</strong><small>{server.software} · {server.version}</small></div></div><div className="mods-summary-meta"><span>4 enabled</span><span>·</span><span>1 staged off</span></div><DisabledButton icon={Braces} kind="primary">Add mod</DisabledButton></div><div className="mod-grid">{mockMods.map((mod) => <Card className="mod-card" key={mod.name}><div className="mod-card-top"><span className="mod-icon"><Box size={17} /></span><Badge>{mod.category}</Badge><button className="icon-button" disabled aria-label={`${mod.name} options, coming soon`}><MoreHorizontal size={16} /></button></div><h3>{mod.name}</h3><p>{mod.author} <span>·</span> {mod.version}</p><div className="mod-card-bottom"><div><span className={`mod-state ${mod.enabled ? 'is-enabled' : 'is-disabled'}`} /><span>{mod.enabled ? 'Enabled' : 'Disabled in sample'}</span></div><span className="switch-caption"><SwitchPreview checked={mod.enabled} label={mod.name} /><ComingSoon /></span></div></Card>)}</div><div className="preview-note"><Layers3 size={16} /><span><strong>Mod changes are staged for a later milestone</strong><small>These toggles are visual only. No files were scanned or changed.</small></span></div></div>
}

function PropertiesPage() {
  return <div className="properties-layout"><div className="properties-main"><div className="property-preview-banner"><Settings2 size={16} /><span>Every control below is a visual preview and is disabled</span><Badge>Not saved</Badge></div><Card className="property-card"><SectionHeading title="Gameplay" description="Sample values for a community survival server" /><div className="property-grid"><Field label="Game mode"><select value="Survival" disabled><option>Survival</option></select></Field><Field label="Difficulty"><select value="Normal" disabled><option>Normal</option></select></Field><Field label="Maximum players"><input value="40" readOnly /></Field><Field label="View distance" hint="Chunks sent to each player"><select value="10 chunks" disabled><option>10 chunks</option></select></Field><Field label="Simulation distance"><select value="8 chunks" disabled><option>8 chunks</option></select></Field><Field label="Spawn protection"><input value="16 blocks" readOnly /></Field></div></Card><Card className="property-card"><SectionHeading title="Access and play" description="Boolean options appear as switches in the full editor" /><div className="property-toggle-list">{[['Whitelist', true, 'Only listed players can join'], ['PVP', true, 'Players can damage each other'], ['Command blocks', false, 'Allow command blocks'], ['Online mode', true, 'Require authenticated game accounts']].map(([name, checked, detail]) => <div className="property-toggle-row" key={String(name)}><div><strong>{String(name)}</strong><small>{String(detail)}</small></div><span className="switch-caption"><SwitchPreview checked={Boolean(checked)} label={String(name)} /><ComingSoon /></span></div>)}</div></Card></div><aside className="properties-aside"><Card><div className="properties-aside-icon"><KeyRound size={18} /></div><h3>Review before applying</h3><p>Property edits will need a review step and may require a restart. No changes can be staged in this preview.</p><DisabledButton icon={Check} kind="primary">Review changes</DisabledButton><small>Changes not saved</small></Card><Card className="property-source-card"><div className="card-kicker"><FileText size={14} /> Source details</div><div><span>File</span><strong>server.properties</strong></div><div><span>Version</span><strong>Minecraft 1.21.4</strong></div><div><span>Profile</span><strong>Fabric</strong></div><div className="property-source-note">No properties file is read or written</div></Card></aside></div>
}

function PreviewSection({ section, serverName }: { section: string; serverName: string }) {
  const content: Record<string, { icon: typeof Folder; title: string; description: string; rows: string[]; action: string }> = {
    files: { icon: Folder, title: 'File browser', description: 'A future view of server files and directories.', rows: ['world/', 'mods/', 'logs/', 'server.properties'], action: 'Open file browser' },
    worlds: { icon: Globe, title: 'World manager', description: 'Sample world inventory for this server.', rows: ['Overworld · active · 2.1 GB', 'Nether · active · 640 MB', 'The End · active · 180 MB'], action: 'Create world' },
    runtime: { icon: Cpu, title: 'Java runtime', description: 'A sample runtime profile selected for this instance.', rows: ['Java 21 · Temurin', 'Maximum heap · 8 GB', 'Garbage collector · G1GC'], action: 'Change runtime' },
    backups: { icon: HardDrive, title: 'Backup history', description: 'Illustrative restore points, not stored files.', rows: ['Today · 08:00 · 842 MB', 'Yesterday · 08:00 · 831 MB', 'Nov 21 · 08:00 · 817 MB'], action: 'Create backup' },
    automation: { icon: Clock3, title: 'Scheduled tasks', description: 'A visual sample of future server automation.', rows: ['Daily restart · 04:00 · paused', 'Snapshot · daily · preview', 'Message players · not configured'], action: 'Add schedule' },
    access: { icon: Shield, title: 'Access policy', description: 'A placeholder for per-user server permissions.', rows: ['Alex Mercer · Administrator preview', 'Mira Woods · Member preview', 'Jonah Reed · Member preview'], action: 'Manage access' },
  }
  const item = content[section] ?? content['files']!
  const Icon = item.icon
  return <div className="preview-section-layout"><Card className="preview-section-card"><div className="preview-section-header"><span className="preview-section-icon"><Icon size={20} /></span><div><h3>{item.title}</h3><p>{item.description}</p></div><Badge>Preview</Badge></div><div className="preview-section-list">{item.rows.map((row, index) => <div key={row}><span className="preview-row-icon">{section === 'files' ? <Folder size={15} /> : <span className="preview-row-index">0{index + 1}</span>}</span><span>{row}</span><ChevronRight size={14} /></div>)}</div><div className="preview-section-footer"><span>Server: {serverName} <span>·</span> sample layout</span><DisabledButton icon={ChevronRight}>{item.action}</DisabledButton></div></Card><div className="preview-section-side"><div className="preview-note"><Shield size={16} /><span><strong>Nothing is connected</strong><small>This page describes a future surface. No real files or permissions are shown.</small></span></div><Link to={`/servers/${servers[0]!.id}/overview`} className="text-link">View server overview <ArrowRight size={14} /></Link></div></div>
}
