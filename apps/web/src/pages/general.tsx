import { useMemo, useState } from 'react'
import {
  Archive, ArrowDownToLine, ArrowRight, Bell, CalendarClock, Check, ChevronRight, CircleHelp,
  CloudDownload, Cpu, Database, HardDrive, KeyRound, Layers3, MemoryStick, Monitor, Plus,
  Search, Settings2, Shield, ShieldCheck, Users, Wifi,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { activities, mockUsers, servers } from '../data'
import { MetricTrack, ResourceTimeline, WorldBlocks } from '../components/charts'
import { Badge, Button, Card, ComingSoon, DisabledButton, PageHeading, PreviewFlag, SectionHeading, StatusDot, SwitchPreview } from '../components/ui'
import { ServerTile } from './dashboard'

type ServerFilter = 'All servers' | 'Online' | 'Offline'

export function ServersPage({ onCreate }: { onCreate: () => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ServerFilter>('All servers')
  const filtered = useMemo(() => servers.filter((server) => {
    const matchesStatus = filter === 'All servers' || server.status === filter
    const matchesQuery = `${server.name} ${server.software} ${server.version}`.toLowerCase().includes(query.toLowerCase())
    return matchesStatus && matchesQuery
  }), [filter, query])
  return <div className="page-stack">
    <PageHeading title="Servers" description="Sample Minecraft instances in this preview workspace." actions={<Button kind="primary" icon={Plus} onClick={onCreate}>Create server</Button>} />
    <div className="list-toolbar"><div className="filter-tabs" role="tablist" aria-label="Filter servers">{(['All servers', 'Online', 'Offline'] as const).map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item}<span>{item === 'All servers' ? servers.length : servers.filter((server) => server.status === item).length}</span></button>)}</div>
      <label className="inline-search"><Search size={15} /><input aria-label="Search servers" placeholder="Search servers" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
    <div className="server-grid">{filtered.map((server) => <ServerTile server={server} key={server.id} />)}</div>
    {!filtered.length && <Card><div className="empty-list"><Search size={20} /><strong>No servers match</strong><span>Try another name or status filter</span></div></Card>}
    <div className="list-footnote"><span className="footnote-dot" /> Showing fictional sample servers only <span>·</span> no local directories were scanned</div>
  </div>
}

export function MachinePage() {
  return <div className="page-stack">
    <PageHeading eyebrow="Local node preview" title="Machine" description="A sample host profile with illustrative resource values." actions={<PreviewFlag>Mock metrics</PreviewFlag>} />
    <div className="machine-hero"><div className="machine-hero-icon"><Monitor size={24} /></div><div className="machine-hero-copy"><div><h2>minepanel-node</h2><Badge tone="neutral"><span className="status-dot status-online" />Local profile</Badge></div><p>Linux · 8 logical cores · sample configuration</p></div><div className="machine-hero-state"><span>Connection</span><strong><i /> Preview only</strong></div></div>
    <div className="overview-strip machine-overview-strip"><div className="overview-number"><span className="overview-icon"><Cpu size={17} /></span><div><span>Processor load</span><strong>36<small>% mock</small></strong></div></div><div className="overview-number"><span className="overview-icon"><MemoryStick size={17} /></span><div><span>Memory used</span><strong>9.9<small> / 16 GB</small></strong></div></div><div className="overview-number"><span className="overview-icon"><HardDrive size={17} /></span><div><span>Storage used</span><strong>240<small> / 500 GB</small></strong></div></div><div className="overview-number"><span className="overview-icon"><Wifi size={17} /></span><div><span>Network rate</span><strong>12.4<small> Mbps mock</small></strong></div></div></div>
    <div className="machine-page-grid"><Card className="machine-chart-card"><div className="card-heading-row"><div><div className="card-kicker"><Cpu size={15} /> CPU · last 24 hours</div><h2>Processor activity</h2></div><PreviewFlag /></div><ResourceTimeline /></Card>
      <Card className="machine-resource-card"><div className="card-heading-row"><div><div className="card-kicker"><MemoryStick size={15} /> Resource allocation</div><h2>Usage sample</h2></div></div><div className="resource-breakdown full"><MetricTrack label="CPU" value={36} detail="2.9 / 8 cores equivalent" /><MetricTrack label="Memory" value={62} detail="9.9 / 16 GB" tone="blue" /><MetricTrack label="Storage" value={48} detail="240 / 500 GB" tone="amber" /></div><p className="data-note"><CircleHelp size={14} /> No system metrics are collected in this stage</p></Card></div>
    <div className="machine-page-grid lower"><Card><SectionHeading title="Storage volumes" description="Illustrative capacity, not read from disk" /><div className="volume-row"><div className="volume-heading"><span className="volume-icon"><Database size={17} /></span><div><strong>Primary volume</strong><small>System and server data · mock</small></div><span className="volume-space">240 GB <small>of 500 GB</small></span></div><div className="volume-track"><span style={{ width: '48%' }} /></div><div className="volume-footer"><span>48% used</span><span>260 GB available</span></div></div></Card>
      <Card><SectionHeading title="Java inventory" description="Future local runtime discovery" /><div className="java-row"><span className="java-mark">J</span><div><strong>Java 21</strong><small>Temurin · sample entry</small></div><Badge>Default preview</Badge></div><div className="java-row"><span className="java-mark">J</span><div><strong>Java 17</strong><small>Temurin · sample entry</small></div><Badge>Available</Badge></div><div className="preview-inline"><Shield size={14} /> Nothing was detected on this computer</div></Card></div>
  </div>
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

export function UsersPage() {
  return <div className="page-stack"><PageHeading title="Users" description="Account and role layouts for a future local setup." actions={<DisabledButton icon={Plus} kind="primary">Add user</DisabledButton>} /><div className="account-callout"><span className="account-callout-icon"><ShieldCheck size={18} /></span><div><strong>Account system is not active</strong><p>These are fictional profile previews. No one can sign in, and these roles grant no real permissions.</p></div><Badge>Preview</Badge></div><Card className="data-table-card"><div className="table-title-row"><div><h2>Profile directory</h2><p>Sample accounts for reviewing the interface</p></div><span className="table-count">3 entries</span></div><div className="data-table users-table"><div className="data-table-head"><span>User</span><span>Role</span><span>Last seen</span><span>Access</span><span /></div>{mockUsers.map((user) => <div className="data-table-row" key={user.email}><span className="user-cell"><span className={`avatar ${user.initials === 'AM' ? 'avatar-green' : ''}`}>{user.initials}</span><span><strong>{user.name}</strong><small>{user.email}</small></span></span><Badge tone={user.role === 'Administrator' ? 'accent' : 'neutral'}>{user.role}</Badge><span>{user.lastSeen}</span><span className="access-preview"><span className="status-dot status-offline" />Not enabled</span><button className="row-action" disabled title="Coming soon"><span>Edit</span><ComingSoon /></button></div>)}</div><div className="users-mobile-list">{mockUsers.map((user) => <div className="user-mobile-row" key={`${user.email}-mobile`}><span className={`avatar ${user.initials === 'AM' ? 'avatar-green' : ''}`}>{user.initials}</span><div><strong>{user.name}</strong><small>{user.email}</small><span>{user.role} · {user.lastSeen}</span></div><Badge>{user.role}</Badge></div>)}</div></Card><div className="security-preview"><KeyRound size={16} /><span>First-run administrator setup, SQLite persistence, role checks and Argon2id password hashes are deferred to Stage 4.</span></div></div>
}

export function ProfilePage() {
  return <div className="page-stack"><PageHeading title="Profile" description="A preview of the account settings planned for a later stage." actions={<PreviewFlag>Account preview</PreviewFlag>} /><Card className="profile-card"><div className="profile-card-cover" /><div className="profile-card-main"><div className="avatar avatar-xl avatar-green">AM</div><div className="profile-card-identity"><h2>Alex Mercer</h2><p>alex@example.test</p><Badge tone="accent">Administrator preview</Badge></div><DisabledButton icon={Users}>Edit profile</DisabledButton></div><div className="profile-details-grid"><div><span>Display name</span><strong>Alex Mercer</strong></div><div><span>Email address</span><strong>alex@example.test</strong></div><div><span>Workspace role</span><strong>Administrator <small>preview only</small></strong></div><div><span>Avatar</span><strong>Initials preview</strong></div></div><div className="profile-card-note"><ShieldCheck size={15} /> This is a visual sample, not an authenticated account</div></Card><Card className="avatar-preview-card"><div className="avatar-sample-large">AM</div><div><h2>Profile image</h2><p>Avatar uploads will be available with the account system. This screen does not read or upload files.</p></div><DisabledButton icon={ArrowDownToLine}>Upload image</DisabledButton></Card></div>
}

type SettingsTab = 'General' | 'Appearance' | 'Notifications'

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('General')
  return <div className="page-stack"><PageHeading title="Settings" description="Visual preference layouts for the future application." actions={<PreviewFlag />} /><div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">{(['General', 'Appearance', 'Notifications'] as const).map((name) => <button key={name} className={name === tab ? 'selected' : ''} onClick={() => setTab(name)}>{name === 'General' ? <Settings2 size={16} /> : name === 'Appearance' ? <Monitor size={16} /> : <Bell size={16} />}{name}</button>)}</nav><Card className="settings-content"><div className="settings-content-heading"><div><h2>{tab}</h2><p>{tab === 'General' ? 'Workspace defaults and regional display' : tab === 'Appearance' ? 'Color and density preferences' : 'Notification preferences'}</p></div><Badge>Preview only</Badge></div>
      {tab === 'General' && <div className="settings-rows"><div className="settings-row"><div><strong>Workspace name</strong><small>Shown in the navigation and page titles</small></div><input value="MinePanel preview" readOnly /></div><div className="settings-row"><div><strong>Language</strong><small>Display language for the interface</small></div><select value="English" disabled><option>English</option></select></div><div className="settings-row"><div><strong>Time zone</strong><small>Used for activity and schedule previews</small></div><select value="Europe/Paris" disabled><option>Europe/Paris</option></select></div><div className="settings-row"><div><strong>Week starts on</strong><small>Calendar display preference</small></div><select value="Monday" disabled><option>Monday</option></select></div></div>}
      {tab === 'Appearance' && <div className="settings-rows"><div className="settings-row"><div><strong>Theme</strong><small>Dark-first interface theme</small></div><div className="theme-choice"><span className="theme-swatch selected" />Dark <span className="theme-swatch light" />Light <ComingSoon /></div></div><div className="settings-row"><div><strong>Compact navigation</strong><small>Use a narrower sidebar</small></div><div className="switch-caption"><SwitchPreview checked={false} label="Compact navigation" /><ComingSoon /></div></div><div className="settings-row"><div><strong>Reduced motion</strong><small>Respect system animation preferences</small></div><div className="switch-caption"><SwitchPreview checked={false} label="Reduced motion" /><span className="field-hint">Follows your device</span></div></div></div>}
      {tab === 'Notifications' && <div className="settings-rows">{[['Server status changes', true], ['Backup summaries', true], ['Player activity', false], ['Product updates', false]].map(([label, checked]) => <div className="settings-row" key={String(label)}><div><strong>{label}</strong><small>Email and in-app preference preview</small></div><div className="switch-caption"><SwitchPreview checked={Boolean(checked)} label={String(label)} /><ComingSoon /></div></div>)}</div>}
      <div className="settings-footer"><span>Changes are not saved in this preview</span><DisabledButton icon={Check} kind="primary">Save changes</DisabledButton></div>
    </Card></div></div>
}

export function NotFoundPage() {
  return <div className="not-found"><div className="not-found-code">404</div><h1>Page not found</h1><p>This preview route does not exist.</p><Link className="button button-secondary" to="/">Return to dashboard <ChevronRight size={15} /></Link></div>
}

export function DataSummary({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <div className="compact-summary"><span>{title}</span><strong>{value}</strong><small>{detail}</small></div>
}

export function SmallServerList() {
  return <div className="small-server-list">{servers.map((server) => <Link to={`/servers/${server.id}`} key={server.id}><WorldBlocks server={server} compact /><span><strong>{server.name}</strong><small>{server.software} · {server.version}</small></span><StatusDot status={server.status} /></Link>)}</div>
}
