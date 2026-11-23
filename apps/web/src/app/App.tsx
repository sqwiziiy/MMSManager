import { useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AppShell } from '../components/layout'
import { CreateServerWizard } from '../components/create-wizard'
import { DashboardPage } from '../pages/dashboard'
import { ActivityPage, BackupsPage, MachinePage, NotFoundPage, ProfilePage, ServersPage, SettingsPage, TemplatesPage, UsersPage } from '../pages/general'
import { ServerDetailPage } from '../pages/server-detail'
import { MachineHistoryPage } from '../pages/machine-history'
import { MachineMonitorProvider } from '../state/machine-monitor'

export function App() {
  return <BrowserRouter><MachineMonitorProvider><Workspace /></MachineMonitorProvider></BrowserRouter>
}

function Workspace() {
  const [createOpen, setCreateOpen] = useState(false)
  return <>
    <AppShell onCreate={() => setCreateOpen(true)}>
      <Routes>
        <Route path="/" element={<DashboardPage onCreate={() => setCreateOpen(true)} />} />
        <Route path="/servers" element={<ServersPage onCreate={() => setCreateOpen(true)} />} />
        <Route path="/servers/:serverId/*" element={<ServerDetailPage />} />
        <Route path="/machine" element={<MachinePage />} />
        <Route path="/machine/history" element={<MachineHistoryPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/backups" element={<BackupsPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
    {createOpen && <CreateServerWizard onClose={() => setCreateOpen(false)} />}
  </>
}
