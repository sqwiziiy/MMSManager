import { useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, Archive, Blocks, ChevronDown, ChevronRight, Command, Computer, FilePlus2,
  LayoutDashboard, Menu, PanelLeftClose, Search, Server, Settings2, ShieldCheck, Users, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { servers } from '../data'
import { Button, IconButton } from './ui'

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

export function AppShell({ children, onCreate }: { children: React.ReactNode; onCreate: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    setMobileOpen(false)
    setProfileOpen(false)
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
    if (location.pathname.startsWith('/servers/')) return servers.find((server) => location.pathname.includes(server.id))?.name ?? 'Server'
    return [...operations, ...library, ...administration].find((item) => item.to === location.pathname)?.label ?? 'MinePanel'
  }, [location.pathname])

  return (
    <div className={`app-frame ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {mobileOpen && <button aria-label="Close navigation" className="mobile-scrim" onClick={() => setMobileOpen(false)} />}
      <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="brand-row">
          <NavLink to="/" className="brand-mark" aria-label="MinePanel dashboard"><span className="brand-glyph"><i /><i /><i /><i /></span><span className="brand-name">MinePanel</span></NavLink>
          <IconButton icon={PanelLeftClose} label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="collapse-sidebar" onClick={() => setCollapsed((value) => !value)} />
          <IconButton icon={X} label="Close navigation" className="close-mobile" onClick={() => setMobileOpen(false)} />
        </div>

        <button className="sidebar-search" onClick={() => setSearchOpen(true)}><Search size={16} /><span>Search</span><kbd><Command size={11} /> K</kbd></button>

        <div className="sidebar-scroll">
          <NavGroup title="Workspace" items={operations} />
          <div className="sidebar-divider" />
          <NavGroup title="Library" items={library} />
          <div className="sidebar-divider" />
          <NavGroup title="Administration" items={administration} />
        </div>

        <div className="sidebar-bottom">
          <div className="local-node"><span className="node-icon"><Computer size={16} /></span><div><strong>Local node</strong><span>Demo environment</span></div><span className="node-dot" /></div>
          <button className="profile-trigger" onClick={() => setProfileOpen((value) => !value)} aria-expanded={profileOpen}>
            <span className="avatar avatar-green">AM</span><span className="profile-copy"><strong>Alex Mercer</strong><small>Administrator preview</small></span><ChevronDown size={15} className="profile-chevron" />
          </button>
          {profileOpen && <div className="profile-menu">
            <NavLink to="/profile"><span className="avatar avatar-green avatar-small">AM</span><span><strong>My profile</strong><small>Preview account</small></span></NavLink>
            <NavLink to="/users"><Users size={15} /><span><strong>User directory</strong><small>Sample users</small></span></NavLink>
            <NavLink to="/settings"><Settings2 size={15} /><span><strong>Settings</strong><small>Preferences preview</small></span></NavLink>
            <div className="profile-menu-note"><ShieldCheck size={14} /> No real account is signed in</div>
          </div>}
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left"><IconButton icon={Menu} label="Open navigation" className="menu-mobile" onClick={() => setMobileOpen(true)} /><span className="topbar-page">{pageTitle}</span><span className="breadcrumb-divider">/</span><span className="breadcrumb-current">Workspace</span></div>
          <div className="topbar-actions"><button className="top-search" onClick={() => setSearchOpen(true)}><Search size={15} /><span>Search pages</span><kbd>⌘ K</kbd></button><span className="topbar-separator" /><span className="top-demo"><span />Mock environment</span><Button kind="primary" icon={FilePlus2} onClick={onCreate} className="top-create">Create server</Button></div>
        </header>
        <div className="global-demo-bar"><span className="demo-bar-mark">i</span><span><strong>Preview workspace</strong><span className="demo-bar-divider">·</span> Server and machine values are fictional sample data</span><span className="demo-bar-right">No system access</span></div>
        <div className="page-content" key={location.pathname}>{children}</div>
      </main>
      {searchOpen && <QuickSearch onClose={() => setSearchOpen(false)} />}
    </div>
  )
}

function NavGroup({ title, items }: { title: string; items: NavItem[] }) {
  return <nav className="nav-group" aria-label={title}>
    <p className="nav-group-title">{title}</p>
    {items.map(({ label, to, icon: Icon, exact }) => <NavLink key={to} to={to} end={exact} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title={label}>
      <Icon size={17} strokeWidth={1.7} /><span>{label}</span>{label === 'Servers' && <span className="nav-count">03</span>}
    </NavLink>)}
  </nav>
}

function QuickSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const navigate = useNavigate()
  const entries = [
    ...operations.map(({ label, to, icon }) => ({ label, to, icon, group: 'Workspace' })),
    ...library.map(({ label, to, icon }) => ({ label, to, icon, group: 'Library' })),
    ...administration.map(({ label, to, icon }) => ({ label, to, icon, group: 'Administration' })),
    ...servers.map((server) => ({ label: server.name, to: `/servers/${server.id}`, icon: Server, group: 'Servers' })),
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
