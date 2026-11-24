import { useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, Archive, Blocks, CalendarDays, ChevronDown, ChevronRight, Computer, FilePlus2,
  LayoutDashboard, Menu, PanelLeftClose, PanelLeftOpen, Search, Server, Settings2, ShieldCheck, Users, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getLocalServers } from '../api/servers'
import type { LocalServerSummary } from '@mmsmanager/shared'
import { Button, IconButton } from './ui'
import { useMachineStatus } from '../state/use-machine-monitor'
import { useAuth } from '../state/use-auth'
import type { AuthUser } from '@mmsmanager/shared'
import { updateUserPreferences } from '../api/auth'

type NavItem = { label: string; to: string; icon: LucideIcon; exact?: boolean }
const operations: NavItem[] = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard, exact: true },
  { label: 'Servers', to: '/servers', icon: Server },
  { label: 'Machine', to: '/machine', icon: Computer },
  { label: 'Activity', to: '/activity', icon: Activity },
  { label: 'Backups', to: '/backups', icon: Archive },
]
const library: NavItem[] = [{ label: 'Templates', to: '/templates', icon: Blocks }]
const administration: NavItem[] = [
  { label: 'Users', to: '/users', icon: Users },
  { label: 'Settings', to: '/settings', icon: Settings2 },
]

export function AppShell({ children, onCreate, onSignOut, user, workspaceName }: { children: React.ReactNode; onCreate: () => void; onSignOut: () => void; user: AuthUser; workspaceName: string }) {
  const { replaceSnapshot } = useAuth()
  const [collapsed, setCollapsed] = useState(user.preferences.compactNavigation)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sidebarPreferenceError, setSidebarPreferenceError] = useState(false)
  const [sidebarSaving, setSidebarSaving] = useState(false)
  const [registeredServers, setRegisteredServers] = useState<LocalServerSummary[]>([])
  const location = useLocation()
  const accountNavigation = user.role === 'administrator' ? administration : administration.filter((item) => item.to !== '/users')

  useEffect(() => { setCollapsed(user.preferences.compactNavigation) }, [user.preferences.compactNavigation])

  const toggleSidebar = async () => {
    if (sidebarSaving) return
    const next = !collapsed
    setCollapsed(next)
    setSidebarSaving(true)
    setSidebarPreferenceError(false)
    try {
      const updated = await updateUserPreferences({ compactNavigation: next, defaultLanding: user.preferences.defaultLanding })
      // Update the shared session snapshot so settings and the shell stay in sync.
      replaceSnapshot(updated)
    } catch {
      setCollapsed(user.preferences.compactNavigation)
      setSidebarPreferenceError(true)
    } finally {
      setSidebarSaving(false)
    }
  }

  useEffect(() => {
    setMobileOpen(false)
    setProfileOpen(false)
  }, [location.pathname])

  useEffect(() => {
    const controller = new AbortController()
    const load = () => { void getLocalServers(controller.signal).then(setRegisteredServers).catch(() => undefined) }
    load()
    window.addEventListener('mmsmanager:server-lifecycle', load)
    return () => { controller.abort(); window.removeEventListener('mmsmanager:server-lifecycle', load) }
  }, [location.pathname])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen((open) => !open)
      }
      if (event.key === 'Escape') {
        setSearchOpen(false)
        setProfileOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pageTitle = useMemo(() => {
    if (location.pathname.startsWith('/servers/')) return registeredServers.find((server) => location.pathname.includes(server.id))?.name ?? 'Server'
    if (location.pathname === '/machine/history') return 'Machine history'
    return [...operations, ...library, ...accountNavigation].find((item) => item.to === location.pathname)?.label ?? workspaceName
  }, [location.pathname, accountNavigation, workspaceName, registeredServers])

  return (
    <div className={`app-frame ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {mobileOpen && <button aria-label="Close navigation" className="mobile-scrim" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="brand-row">
          <NavLink to="/" className="brand-mark" aria-label="MMSManager dashboard"><span className="brand-glyph"><i /><i /><i /><i /></span><span className="brand-name">MMSManager</span></NavLink>
          <IconButton icon={collapsed ? PanelLeftOpen : PanelLeftClose} label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="collapse-sidebar" aria-expanded={!collapsed} disabled={sidebarSaving} onClick={() => void toggleSidebar()} />
          <IconButton icon={X} label="Close navigation" className="close-mobile" onClick={() => setMobileOpen(false)} />
        </div>

        <button className="sidebar-search" onClick={() => setSearchOpen(true)}><Search size={16} /><span>Search</span><kbd>Ctrl K</kbd></button>

        <div className="sidebar-scroll">
          <NavGroup title="Workspace" items={operations} serverCount={registeredServers.length} />
          <div className="sidebar-divider" />
          <NavGroup title="Library" items={library} />
          <div className="sidebar-divider" />
          <NavGroup title="Account" items={accountNavigation} />
        </div>

        <div className="sidebar-bottom">
          <SidebarMachineStatus />
          <button className="profile-trigger" onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen}>
            <ProfileAvatar user={user} /><span className="profile-copy"><strong>{user.displayName}</strong><small>{user.role === 'administrator' ? 'Administrator' : 'Member'}</small></span><ChevronDown size={15} className="profile-chevron" />
          </button>
          {profileOpen && <div className="profile-menu">
            <NavLink to="/profile"><ProfileAvatar user={user} small /><span><strong>Profile</strong><small>Account details and security</small></span></NavLink>
            {user.role === 'administrator' && <NavLink to="/users"><Users size={15} /><span><strong>User directory</strong><small>Manage workspace accounts</small></span></NavLink>}
            <NavLink to="/settings"><Settings2 size={15} /><span><strong>Settings</strong><small>Workspace and preferences</small></span></NavLink>
            <button className="profile-menu-signout" onClick={onSignOut}><ShieldCheck size={15} /><span>Sign out</span></button>
          </div>}
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left"><IconButton icon={Menu} label="Open navigation" className="menu-mobile" onClick={() => setMobileOpen(true)} /><span className="topbar-page">{pageTitle}</span><span className="breadcrumb-divider">/</span><span className="breadcrumb-current">Workspace</span></div>
          <div className="topbar-actions"><button className="top-search" onClick={() => setSearchOpen(true)}><Search size={15} /><span>Search pages</span><kbd>Ctrl K</kbd></button><span className="topbar-separator" /><TopbarMachineStatus />{user.role === 'administrator' && <Button kind="primary" icon={FilePlus2} onClick={onCreate} className="top-create">Create server</Button>}</div>
        </header>
        {sidebarPreferenceError && <div className="sidebar-preference-error" role="status">Sidebar preference could not be saved.</div>}
        <div className="page-content" key={location.pathname}>{children}</div>
      </main>
      {searchOpen && <QuickSearch onClose={() => setSearchOpen(false)} includeUsers={user.role === 'administrator'} registeredServers={registeredServers} />}
    </div>
  )
}

function SidebarMachineStatus() {
  const { apiStatus, machineStatus } = useMachineStatus()
  const live = apiStatus === 'online' && machineStatus === 'live'
  const problem = apiStatus === 'offline' ? 'API offline' : apiStatus === 'checking' ? 'Checking' : machineStatus === 'stale' ? 'Stale sample' : machineStatus !== 'live' ? 'Waiting for sample' : ''
  const tone = live ? 'live' : apiStatus === 'offline' ? 'offline' : machineStatus === 'stale' ? 'stale' : ''
  return <div className="local-node"><span className="node-icon"><Computer size={16} /></span><div><strong>Local machine</strong>{problem && <span>{problem}</span>}</div><span className={`node-dot ${tone}`} role="status" aria-label={live ? 'Machine monitoring is current' : problem} title={live ? 'Monitoring current' : problem} /></div>
}

function TopbarMachineStatus() {
  const { apiStatus, machineStatus } = useMachineStatus()
  const live = apiStatus === 'online' && machineStatus === 'live'
  const problem = apiStatus === 'offline' ? 'API offline' : apiStatus === 'checking' ? 'Checking' : machineStatus === 'stale' ? 'Stale sample' : machineStatus !== 'live' ? 'Waiting for sample' : ''
  return <span className={`top-demo ${live ? 'machine-live' : problem ? 'machine-problem' : ''}`} title={problem || 'Monitoring current'} aria-label={live ? 'Local machine monitoring is current' : `Local machine: ${problem}`}><span aria-hidden="true" />Local machine</span>
}

function NavGroup({ title, items, serverCount }: { title: string; items: NavItem[]; serverCount?: number }) {
  return <nav className="nav-group" aria-label={title}>
    <p className="nav-group-title">{title}</p>
    {items.map(({ label, to, icon: Icon, exact }) => <NavLink key={to} to={to} end={exact} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title={label}>
      <Icon size={17} strokeWidth={1.7} /><span>{label}</span>{label === 'Servers' && serverCount !== undefined && <span className="nav-count">{serverCount}</span>}
    </NavLink>)}
  </nav>
}

function QuickSearch({ onClose, includeUsers, registeredServers }: { onClose: () => void; includeUsers: boolean; registeredServers: LocalServerSummary[] }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const navigate = useNavigate()
  const entries = [
    ...operations.map(({ label, to, icon }) => ({ label, to, icon, group: 'Workspace' })),
    { label: 'Machine history', to: '/machine/history', icon: CalendarDays, group: 'Machine' },
    ...library.map(({ label, to, icon }) => ({ label, to, icon, group: 'Library' })),
    ...administration.filter((item) => includeUsers || item.to !== '/users').map(({ label, to, icon }) => ({ label, to, icon, group: 'Account' })),
    ...registeredServers.map((server) => ({ label: server.name, to: `/servers/${server.id}/overview`, icon: Server, group: 'Servers' })),
  ]
  const shown = entries.filter((entry) => entry.label.toLowerCase().includes(query.toLowerCase()))
  const openEntry = (to: string) => {
    navigate(to)
    onClose()
  }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && shown.length) {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % shown.length)
    } else if (event.key === 'ArrowUp' && shown.length) {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + shown.length) % shown.length)
    } else if (event.key === 'Enter' && shown[activeIndex]) {
      event.preventDefault()
      openEntry(shown[activeIndex]!.to)
    }
  }
  return <div className="overlay-scrim quick-search-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="quick-search-dialog" role="dialog" aria-modal="true" aria-label="Search pages">
      <div className="quick-search-input"><Search size={18} /><input autoFocus value={query} onKeyDown={handleKeyDown} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }} placeholder="Search pages and servers" aria-label="Search pages and servers" /><kbd>ESC</kbd><IconButton icon={X} label="Close search" onClick={onClose} /></div>
      <div className="quick-search-results" role="listbox" aria-label="Search results">
        {shown.length ? shown.map(({ label, to, icon: Icon, group }, index) => <button id={`quick-result-${index}`} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} key={to} onMouseEnter={() => setActiveIndex(index)} onClick={() => openEntry(to)}><span className="search-result-icon"><Icon size={16} /></span><span>{label}</span><small>{group}</small><ChevronRight size={14} /></button>) : <div className="search-empty">No matching pages</div>}
      </div>
      <div className="quick-search-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>Enter</kbd> to open</span></div>
    </div>
  </div>
}

function ProfileAvatar({ user, small = false }: { user: AuthUser; small?: boolean }) {
  const initials = user.displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || user.username.slice(0, 2).toUpperCase()
  return <span className={`avatar ${user.role === 'administrator' ? 'avatar-green' : ''} ${small ? 'avatar-small' : ''} ${user.avatarUrl ? 'avatar-with-image' : ''}`}>
    {user.avatarUrl && <img src={user.avatarUrl} alt="" />}
    {!user.avatarUrl && initials}
  </span>
}
