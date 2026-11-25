import { useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AppShell } from '../components/layout'
import { CreateServerWizard } from '../components/create-wizard'
import { DashboardPage } from '../pages/dashboard'
import { ActivityPage, BackupsPage, MachinePage, NotFoundPage, ProfilePage, ServersPage, SettingsPage, UsersPage } from '../pages/general'
import { TemplatesPage } from '../pages/templates'
import type { ServerTemplate } from '@mmsmanager/shared'
import { ServerDetailPage } from '../pages/server-detail'
import { MachineHistoryPage } from '../pages/machine-history'
import { AuthLoadingPage, LoginPage, SetupPage } from '../pages/auth-pages'
import { AuthProvider } from '../state/auth-provider'
import { useAuth } from '../state/use-auth'
import { MachineMonitorProvider } from '../state/machine-monitor'
import { LocaleProvider } from '../i18n/locale'

export function App() {
  return <BrowserRouter><AuthProvider><LocaleProvider><SessionRouter /></LocaleProvider></AuthProvider></BrowserRouter>
}

function SessionRouter() {
  const auth = useAuth()
  const location = useLocation()
  const intended = `${location.pathname}${location.search}${location.hash}`
  const safeState = location.pathname === '/login' || location.pathname === '/setup' ? location.state : { from: intended }

  if (auth.phase === 'loading') return <AuthLoadingPage error="" onRetry={() => void auth.refresh()} />
  if (auth.phase === 'unavailable') return <AuthLoadingPage error={auth.error ?? 'The local API is unavailable.'} onRetry={() => void auth.refresh()} />

  if (auth.phase === 'setup-required') {
    if (location.pathname === '/setup') return <SetupPage />
    return <Navigate to="/setup" replace state={safeState} />
  }

  if (auth.phase === 'authenticated') {
    if (location.pathname === '/login' || location.pathname === '/setup') {
      const fallback = auth.snapshot?.user.preferences.defaultLanding === 'machine' ? '/machine' : '/'
      const from = location.state && typeof location.state === 'object' && 'from' in location.state ? location.state.from : null
      const target = typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : fallback
      return <Navigate to={target} replace />
    }
    return <AuthenticatedWorkspace />
  }

  if (location.pathname === '/setup') return <Navigate to="/login" replace />
  if (location.pathname === '/login') return <LoginPage />
  return <Navigate to="/login" replace state={safeState} />
}

function AuthenticatedWorkspace() {
  const auth = useAuth()
  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  const [wizardPreset, setWizardPreset] = useState<ServerTemplate | null>(null)
  const snapshot = auth.snapshot
  if (!snapshot) return <AuthLoadingPage error="" onRetry={() => void auth.refresh()} />

  const handleSignOut = async () => {
    try { await auth.signOut() } catch { /* The local session is cleared in the client even if the API is offline. */ }
    navigate('/login', { replace: true })
  }
  const openCreate = () => { setWizardPreset(null); setCreateOpen(true) }
  const openFromTemplate = (template: ServerTemplate) => { setWizardPreset(template); setCreateOpen(true) }

  return <MachineMonitorProvider>
    <AppShell
      user={snapshot.user}
      workspaceName={snapshot.workspace.displayName}
      onSignOut={() => void handleSignOut()}
      onCreate={openCreate}
    >
      <Routes>
        <Route path="/" element={<DashboardPage onCreate={openCreate} />} />
        <Route path="/servers" element={<ServersPage onCreate={openCreate} />} />
        <Route path="/servers/:serverId/*" element={<ServerDetailPage />} />
        <Route path="/machine" element={<MachinePage />} />
        <Route path="/machine/history" element={<MachineHistoryPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/backups" element={<BackupsPage />} />
        <Route path="/templates" element={<TemplatesPage onCreate={openFromTemplate} />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
    {createOpen && <CreateServerWizard key={wizardPreset?.id ?? 'new-server'} preset={wizardPreset ?? undefined} onClose={() => { setCreateOpen(false); setWizardPreset(null) }} />}
  </MachineMonitorProvider>
}
