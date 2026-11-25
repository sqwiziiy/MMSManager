import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertCircle, ArrowDownToLine, Check, CircleUserRound, Clock3, KeyRound, LoaderCircle, LockKeyhole, Palette, Plus, Save, ShieldCheck, Trash2, UserRoundPlus, Users, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { AdminUser, AuditRecord, LandingPage, MonitoringSettings, UserRole } from '@mmsmanager/shared'
import {
  changePassword, createAdminUser, deleteAdminUser, getAuditEvents, getWorkspacePreferences, listAdminUsers, removeAvatar,
  resetAdminUserPassword, updateAdminUser, updateProfile, updateUserPreferences, updateWorkspacePreferences, uploadAvatar,
} from '../api/auth'
import { ApiRequestError } from '../api/auth'
import { Badge, Button, Card, Field, PageHeading, SectionHeading } from '../components/ui'
import { useAuth } from '../state/use-auth'
import { useMachineHistory } from '../state/use-machine-monitor'
import { NotificationsPanel } from '../components/notifications'
import { getMonitoringSettings, updateMonitoringSettings } from '../api/monitoring'
import { DEFAULT_MONITORING_SETTINGS } from '@mmsmanager/shared'
import { saveUiPreferencesInput } from '../i18n/preferences'
import { useUiPreferences } from '../i18n/locale-context'
import type { UiPreferences } from '../i18n/locale-context'
import { currentLocale, translateText } from '../i18n/catalog'

type Notice = { tone: 'ok' | 'error'; message: string }

function requestMessage(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'The local API could not complete this request.'
}

function auditActionLabel(action: string): string {
  const locale = currentLocale()
  const label = translateText(action.replaceAll('.', ' '), locale)
  return label.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase(locale))
}

function shortDate(value: string | null, locale: 'en' | 'ru' = currentLocale()): string {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unavailable' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function initials(name: string, fallback: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || fallback.slice(0, 2).toUpperCase()
}

function AccountAvatar({ name, fallback, url, size = 'normal' }: { name: string; fallback: string; url: string | null; size?: 'normal' | 'large' }) {
  return <span className={`avatar account-avatar ${size === 'large' ? 'account-avatar-large' : ''} ${url ? 'avatar-with-image' : ''}`} data-no-translate>
    {url ? <img src={url} alt="" /> : initials(name, fallback)}
  </span>
}

function NoticeBar({ notice }: { notice: Notice | null }) {
  if (!notice) return null
  return <div className={`account-notice ${notice.tone === 'error' ? 'notice-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
    {notice.tone === 'error' ? <AlertCircle size={15} /> : <Check size={15} />}{notice.message}
  </div>
}

function Dialog({ title, description, children, onClose, className = '' }: { title: string; description?: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return <div className="overlay-scrim account-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className={`account-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
      <header><div><h2 id="account-dialog-title">{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}><X size={17} /></button></header>
      {children}
    </section>
  </div>
}

export function UsersPage() {
  const auth = useAuth()
  const isAdmin = auth.snapshot?.user.role === 'administrator'
  const [users, setUsers] = useState<AdminUser[]>([])
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null)
  const [toggleTarget, setToggleTarget] = useState<AdminUser | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [userResult, auditResult] = await Promise.all([listAdminUsers(), getAuditEvents()])
      setUsers(userResult.users)
      setAudit(auditResult.events)
    } catch (error) {
      setNotice({ tone: 'error', message: requestMessage(error) })
    } finally { setLoading(false) }
  }

  useEffect(() => { if (isAdmin) void load(); else setLoading(false) }, [isAdmin])
  const visibleUsers = useMemo(() => users.filter((user) => `${user.username} ${user.displayName} ${user.role}`.toLowerCase().includes(search.toLowerCase())), [users, search])

  if (!isAdmin) return <div className="page-stack"><PageHeading title="Users" description="Workspace account administration." /><Card className="access-denied-card"><span><ShieldCheck size={19} /></span><div><h2>Administrator access required</h2><p>Members can view their own profile and local machine data. User management is limited to administrators.</p></div></Card></div>

  const saveRole = async (user: AdminUser, role: UserRole) => {
    setSavingId(user.id)
    setNotice(null)
    try {
      await updateAdminUser(user.id, { role, enabled: user.enabled })
      setNotice({ tone: 'ok', message: `${user.displayName}'s role was updated. Active sessions were revoked.` })
      await load()
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setSavingId(null) }
  }

  const confirmToggle = async () => {
    if (!toggleTarget) return
    const target = toggleTarget
    setToggleTarget(null)
    setSavingId(target.id)
    setNotice(null)
    try {
      await updateAdminUser(target.id, { role: target.role, enabled: !target.enabled })
      setNotice({ tone: 'ok', message: `${target.displayName} was ${target.enabled ? 'disabled' : 'enabled'}.` })
      await load()
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setSavingId(null) }
  }

  return <div className="page-stack">
    <PageHeading title="Users" description="Manage local workspace accounts, roles and access." actions={<Button kind="primary" icon={UserRoundPlus} onClick={() => setCreateOpen(true)}>Add user</Button>} />
    <NoticeBar notice={notice} />
    <Card className="data-table-card account-table-card">
      <div className="table-title-row"><div><h2>Accounts</h2></div><span className="table-count">{users.length} {users.length === 1 ? 'account' : 'accounts'}</span></div>
      <div className="account-toolbar"><label className="inline-search"><Users size={15} /><input aria-label="Search users" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an account" /></label><span className="field-hint">Changes are recorded in the security audit.</span></div>
      {loading ? <div className="account-loading"><LoaderCircle className="auth-spinner" size={17} />Loading accounts</div> : users.length === 0 ? <div className="account-empty">No accounts are available.</div> : <>
        <div className="data-table account-users-table"><div className="data-table-head"><span>User</span><span>Role</span><span>Last sign in</span><span>Sessions</span><span>Access</span><span>Actions</span></div>
          {visibleUsers.map((user) => <div className="data-table-row account-user-row" key={user.id}>
            <span className="user-cell"><AccountAvatar name={user.displayName} fallback={user.username} url={user.avatarUrl} /><span><strong data-no-translate>{user.displayName}</strong><small data-no-translate>@{user.username}</small>{user.mustChangePassword && <Badge tone="warn">Password change required</Badge>}</span></span>
            <label className="sr-only" htmlFor={`role-${user.id}`}>Role for <span data-no-translate>{user.username}</span></label>
            <select id={`role-${user.id}`} className="account-role-select" value={user.role} disabled={savingId === user.id} onChange={(event) => void saveRole(user, event.target.value as UserRole)}><option value="administrator">Administrator</option><option value="member">Member</option></select>
            <span className="account-last-seen">{shortDate(user.lastLoginAt)}</span><span className="account-session-count">{user.activeSessionCount}</span>
            <Badge tone={user.enabled ? 'good' : 'neutral'}>{user.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <span className="account-row-actions"><Button kind="quiet" icon={KeyRound} className="account-icon-action" aria-label={translateText(`Reset password for ${user.username}`, currentLocale())} onClick={() => setResetTarget(user)}>Reset</Button><Button kind={user.enabled ? 'danger' : 'secondary'} icon={user.enabled ? LockKeyhole : ShieldCheck} className="account-icon-action" disabled={savingId === user.id} onClick={() => setToggleTarget(user)}>{user.enabled ? 'Disable' : 'Enable'}</Button><Button kind="quiet" icon={Trash2} className="account-icon-action" aria-label={translateText(`Delete ${user.username}`, currentLocale())} title={user.id === auth.snapshot?.user.id ? 'You cannot delete the account you are using.' : undefined} disabled={savingId === user.id || user.id === auth.snapshot?.user.id} onClick={() => setDeleteTarget(user)}>Delete</Button></span>
          </div>)}
        </div>
        <div className="account-users-mobile">{visibleUsers.map((user) => <article className="account-mobile-user" key={`${user.id}-mobile`}>
          <div className="account-mobile-header"><AccountAvatar name={user.displayName} fallback={user.username} url={user.avatarUrl} /><div><strong data-no-translate>{user.displayName}</strong><small data-no-translate>@{user.username}</small>{user.mustChangePassword && <Badge tone="warn">Password change required</Badge>}</div><Badge tone={user.enabled ? 'good' : 'neutral'}>{user.enabled ? 'Enabled' : 'Disabled'}</Badge></div>
          <div className="account-mobile-fields"><label>Role<select value={user.role} disabled={savingId === user.id} onChange={(event) => void saveRole(user, event.target.value as UserRole)}><option value="administrator">Administrator</option><option value="member">Member</option></select></label><span><small>Last sign in</small><strong>{shortDate(user.lastLoginAt)}</strong></span><span><small>Active sessions</small><strong>{user.activeSessionCount}</strong></span></div>
          <div className="account-mobile-actions"><Button kind="secondary" icon={KeyRound} onClick={() => setResetTarget(user)}>Reset password</Button><Button kind={user.enabled ? 'danger' : 'secondary'} icon={user.enabled ? LockKeyhole : ShieldCheck} disabled={savingId === user.id} onClick={() => setToggleTarget(user)}>{user.enabled ? 'Disable account' : 'Enable account'}</Button><Button kind="quiet" icon={Trash2} title={user.id === auth.snapshot?.user.id ? 'You cannot delete the account you are using.' : undefined} disabled={savingId === user.id || user.id === auth.snapshot?.user.id} onClick={() => setDeleteTarget(user)}>Delete account</Button></div>
        </article>)}</div>
      </>}
    </Card>
    <Card className="audit-card"><SectionHeading title="Recent security activity" description="Real local account events. Passwords and session tokens are never included." /><div className="audit-list">{audit.slice(0, 8).map((event) => <div className="audit-row" key={event.id}><span className={`audit-state ${event.outcome === 'success' ? 'audit-state-ok' : ''}`} /><div><strong>{auditActionLabel(event.action)}</strong><small>{event.actor ? <span data-no-translate>{event.actor}</span> : 'System'}{event.subject ? <> · <span data-no-translate>{event.subject}</span></> : null}</small></div><time>{shortDate(event.occurredAt)}</time></div>)}</div>{audit.length === 0 && <p className="audit-empty">No security events have been recorded yet.</p>}</Card>

    {createOpen && <CreateUserDialog onClose={() => setCreateOpen(false)} onCreated={async () => { setCreateOpen(false); setNotice({ tone: 'ok', message: 'Account created. The user must change this password at first sign in.' }); await load() }} />}
    {resetTarget && <ResetPasswordDialog user={resetTarget} onClose={() => setResetTarget(null)} onReset={async () => { setResetTarget(null); setNotice({ tone: 'ok', message: 'Temporary password set. The user must change it at next sign in.' }); await load() }} />}
    {toggleTarget && <Dialog title={`${toggleTarget.enabled ? 'Disable' : 'Enable'} ${toggleTarget.displayName}?`} description={toggleTarget.enabled ? 'This account will lose access immediately and all sessions will be revoked.' : 'This account will be able to sign in again.'} onClose={() => setToggleTarget(null)} className="account-confirm-dialog"><div className="account-dialog-footer"><Button kind="secondary" onClick={() => setToggleTarget(null)}>Cancel</Button><Button kind={toggleTarget.enabled ? 'danger' : 'primary'} onClick={() => void confirmToggle()}>{toggleTarget.enabled ? 'Disable account' : 'Enable account'}</Button></div></Dialog>}
    {deleteTarget && <DeleteUserDialog user={deleteTarget} onClose={() => setDeleteTarget(null)} onDelete={async (user, avatarCleanup) => { setDeleteTarget(null); setNotice({ tone: avatarCleanup === 'done' ? 'ok' : 'error', message: avatarCleanup === 'done' ? `${user.displayName} was deleted. Their sessions were revoked; past activity remains anonymous.` : `${user.displayName} was deleted, but the profile image could not be cleaned up.` }); await load() }} />}
  </div>
}

function DeleteUserDialog({ user, onClose, onDelete }: { user: AdminUser; onClose: () => void; onDelete: (user: AdminUser, avatarCleanup: 'done' | 'pending') => Promise<void> }) {
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (confirmation !== user.username) return
    setBusy(true)
    setError(null)
    try {
      const result = await deleteAdminUser(user.id, confirmation)
      await onDelete(user, result.avatarCleanup)
    } catch (failure) { setError(requestMessage(failure)) }
    finally { setBusy(false) }
  }
  return <Dialog title={`Delete ${user.displayName}?`} description="This removes the account, sessions, profile image and personal preferences. Past activity remains without a user link." onClose={onClose} className="account-confirm-dialog">
    <form className="account-dialog-form" onSubmit={(event) => void submit(event)}>
      <p className="delete-warning">This cannot be undone. Deleting the last enabled administrator is blocked.</p>
      <Field label={`Type ${user.username} to confirm`}><input autoComplete="off" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>
      {error && <div className="auth-error" role="alert"><AlertCircle size={15} />{error}</div>}
      <div className="account-dialog-footer"><Button type="button" kind="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button kind="danger" icon={busy ? LoaderCircle : Trash2} disabled={busy || confirmation !== user.username}>{busy ? 'Deleting account' : 'Delete account'}</Button></div>
    </form>
  </Dialog>
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => Promise<void> }) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<UserRole>('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createAdminUser({ username: username.trim(), displayName: displayName.trim(), password, role })
      setPassword('')
      await onCreated(displayName.trim())
    } catch (failure) { setError(requestMessage(failure)) }
    finally { setBusy(false) }
  }
  return <Dialog title="Add a user" description="Create a local account and assign its initial role." onClose={onClose}>
    <form className="account-dialog-form" onSubmit={(event) => void submit(event)}>
      {error && <div className="auth-error" role="alert"><AlertCircle size={15} />{error}</div>}
      <Field label="Username"><input autoComplete="off" required minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
      <Field label="Display name"><input autoComplete="off" required maxLength={60} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
      <Field label="Initial password" hint="At least 14 characters. The user must change it before using the workspace."><input type="password" autoComplete="new-password" required minLength={14} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
      <Field label="Role"><select value={role} onChange={(event) => setRole(event.target.value as UserRole)}><option value="member">Member</option><option value="administrator">Administrator</option></select></Field>
      <div className="account-dialog-footer"><Button type="button" kind="secondary" onClick={onClose}>Cancel</Button><Button kind="primary" icon={busy ? LoaderCircle : Plus} disabled={busy}>{busy ? 'Creating account' : 'Create user'}</Button></div>
    </form>
  </Dialog>
}

function ResetPasswordDialog({ user, onClose, onReset }: { user: AdminUser; onClose: () => void; onReset: (name: string) => Promise<void> }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await resetAdminUserPassword(user.id, password)
      setPassword('')
      await onReset(user.displayName)
    } catch (failure) { setError(requestMessage(failure)) }
    finally { setBusy(false) }
  }
  return <Dialog title={`Reset ${user.displayName}'s password`} description="All sessions will be revoked. The user must change this temporary password at next sign in." onClose={onClose}>
    <form className="account-dialog-form" onSubmit={(event) => void submit(event)}>
      {error && <div className="auth-error" role="alert"><AlertCircle size={15} />{error}</div>}
      <Field label="New password" hint="At least 14 characters. Share it outside this app."><input type="password" autoComplete="new-password" required minLength={14} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
      <div className="account-dialog-footer"><Button type="button" kind="secondary" onClick={onClose}>Cancel</Button><Button kind="primary" icon={KeyRound} disabled={busy}>{busy ? 'Resetting' : 'Reset password'}</Button></div>
    </form>
  </Dialog>
}

export function ProfilePage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const { language } = useUiPreferences()
  const snapshot = auth.snapshot!
  const user = snapshot.user
  const [displayName, setDisplayName] = useState(user.displayName)
  const [profileBusy, setProfileBusy] = useState(false)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setDisplayName(user.displayName) }, [user.displayName])
  const saveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setProfileBusy(true)
    setNotice(null)
    try {
      const next = await updateProfile(displayName.trim())
      auth.replaceSnapshot(next)
      setNotice({ tone: 'ok', message: 'Your display name was saved.' })
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setProfileBusy(false) }
  }
  const changeAvatar = async (file: File | undefined) => {
    if (!file) return
    setAvatarBusy(true)
    setNotice(null)
    try {
      const next = await uploadAvatar(file)
      auth.replaceSnapshot(next)
      setNotice({ tone: 'ok', message: 'Your profile image was updated.' })
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally {
      setAvatarBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const deleteAvatar = async () => {
    setAvatarBusy(true)
    setNotice(null)
    try {
      const next = await removeAvatar()
      auth.replaceSnapshot(next)
      setNotice({ tone: 'ok', message: 'The profile image was removed.' })
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setAvatarBusy(false) }
  }
  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPasswordBusy(true)
    setNotice(null)
    try {
      await changePassword({ currentPassword, newPassword, confirmPassword })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      auth.expireSession()
      navigate('/login', { replace: true })
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setPasswordBusy(false) }
  }

  return <div className="page-stack">
    <PageHeading title="Profile" description="Your account, profile image and active local sessions." actions={<Badge tone="accent">{user.role === 'administrator' ? 'Administrator' : 'Member'}</Badge>} />
    <NoticeBar notice={notice} />
    <Card className="profile-card account-profile-card">
      <div className="profile-card-cover" />
      <div className="profile-card-main"><AccountAvatar name={user.displayName} fallback={user.username} url={user.avatarUrl} size="large" /><div className="profile-card-identity"><h2 data-no-translate>{user.displayName}</h2><p data-no-translate>@{user.username}</p><Badge tone="accent">{user.role === 'administrator' ? 'Administrator' : 'Member'}</Badge></div><span className="profile-created"><Clock3 size={14} />Joined {shortDate(user.createdAt, language)}</span></div>
      <div className="profile-details-grid"><div><span>Username</span><strong data-no-translate>@{user.username}</strong></div><div><span>Role</span><strong>{user.role === 'administrator' ? 'Administrator' : 'Member'}</strong></div><div><span>Last sign in</span><strong>{shortDate(user.lastLoginAt, language)}</strong></div><div><span>Workspace</span><strong data-no-translate>{snapshot.workspace.displayName}</strong></div></div>
    </Card>
    <div className="account-profile-grid">
      <Card><SectionHeading title="Profile details" description="Your display name is visible in the local workspace." /><form className="account-inline-form" onSubmit={(event) => void saveName(event)}><Field label="Display name"><input required maxLength={60} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field><Button kind="primary" icon={profileBusy ? LoaderCircle : Save} disabled={profileBusy}>{profileBusy ? 'Saving' : 'Save profile'}</Button></form></Card>
      <Card className="avatar-settings-card"><SectionHeading title="Profile image" description="PNG, JPEG or WebP · max 1 MiB." /><div className="avatar-settings-content"><AccountAvatar name={user.displayName} fallback={user.username} url={user.avatarUrl} size="large" /><div><input ref={fileRef} className="sr-only" aria-label="Choose profile image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void changeAvatar(event.target.files?.[0])} /><Button kind="secondary" icon={avatarBusy ? LoaderCircle : ArrowDownToLine} disabled={avatarBusy} onClick={() => fileRef.current?.click()}>{avatarBusy ? 'Uploading' : user.avatarUrl ? 'Change image' : 'Upload image'}</Button>{user.avatarUrl && <Button kind="quiet" icon={Trash2} disabled={avatarBusy} onClick={() => void deleteAvatar()}>Remove</Button>}</div></div></Card>
    </div>
    <div className="account-profile-grid">
      <Card><SectionHeading title="Change password" description="Changing your password revokes every active session, including this one." /><form className="account-password-form" onSubmit={(event) => void submitPassword(event)}><Field label="Current password"><input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></Field><Field label="New password" hint="At least 14 characters."><input type="password" autoComplete="new-password" required minLength={14} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></Field><Field label="Confirm new password"><input type="password" autoComplete="new-password" required minLength={14} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></Field><Button kind="primary" icon={passwordBusy ? LoaderCircle : KeyRound} disabled={passwordBusy}>{passwordBusy ? 'Changing password' : 'Change password'}</Button></form></Card>
      <Card><SectionHeading title="Active sessions" description="Sessions expire after 12 hours idle or 7 days absolute." /><div className="account-session-list">{snapshot.sessions.map((session) => <div className="account-session-row" key={session.id}><span className={session.current ? 'session-device-icon current' : 'session-device-icon'}><CircleUserRound size={16} /></span><div><strong>{session.current ? 'This browser' : `Session ${session.id}`}</strong><small>Last active {shortDate(session.lastSeenAt, language)}</small></div>{session.current && <Badge tone="good">Current</Badge>}</div>)}</div>{snapshot.sessions.length === 0 && <p className="audit-empty">No active sessions were returned.</p>}</Card>
    </div>
  </div>
}

type SettingsTab = 'Workspace' | 'Personal' | 'Language & appearance' | 'Notifications' | 'Monitoring'

export function SettingsPage() {
  const auth = useAuth()
  const { setPreview, clearPreview } = useUiPreferences()
  const { history } = useMachineHistory()
  const isAdmin = auth.snapshot?.user.role === 'administrator'
  const snapshot = auth.snapshot!
  const [tab, setTab] = useState<SettingsTab>(isAdmin ? 'Workspace' : 'Personal')
  const [workspaceName, setWorkspaceName] = useState(snapshot.workspace.displayName)
  const [workspaceLanding, setWorkspaceLanding] = useState<LandingPage>(snapshot.workspace.defaultLanding)
  const [compactNavigation, setCompactNavigation] = useState(snapshot.user.preferences.compactNavigation)
  const [personalLanding, setPersonalLanding] = useState<LandingPage>(snapshot.user.preferences.defaultLanding)
  const [appearanceDraft, setAppearanceDraft] = useState<UiPreferences>({
    language: snapshot.user.preferences.language,
    theme: snapshot.user.preferences.theme,
    accent: snapshot.user.preferences.accent,
    density: snapshot.user.preferences.density,
    reducedMotion: snapshot.user.preferences.reducedMotion,
  })
  const [monitoringSettings, setMonitoringSettings] = useState<MonitoringSettings>(DEFAULT_MONITORING_SETTINGS)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    if (!isAdmin) { setTab('Personal'); return }
    let active = true
    void getWorkspacePreferences().then((preferences) => {
      if (!active) return
      setWorkspaceName(preferences.displayName)
      setWorkspaceLanding(preferences.defaultLanding)
    }).catch((error: unknown) => {
      if (active) setNotice({ tone: 'error', message: requestMessage(error) })
    })
    return () => { active = false }
  }, [isAdmin])

  useEffect(() => {
    if (!isAdmin || tab !== 'Monitoring') return
    const controller = new AbortController()
    void getMonitoringSettings(controller.signal).then(setMonitoringSettings).catch((error: unknown) => {
      if (!controller.signal.aborted) setNotice({ tone: 'error', message: requestMessage(error) })
    })
    return () => controller.abort()
  }, [isAdmin, tab])

  const tabList: SettingsTab[] = isAdmin ? ['Workspace', 'Personal', 'Language & appearance', 'Monitoring', 'Notifications'] : ['Personal', 'Language & appearance', 'Notifications']
  const saveWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      const workspace = await updateWorkspacePreferences({ displayName: workspaceName.trim(), defaultLanding: workspaceLanding })
      auth.replaceSnapshot({ ...snapshot, workspace })
      setNotice({ tone: 'ok', message: 'Workspace preferences were saved.' })
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setBusy(false) }
  }
  const savePersonal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      const next = await updateUserPreferences({ compactNavigation, defaultLanding: personalLanding })
      auth.replaceSnapshot(next)
      setNotice({ tone: 'ok', message: 'Your preferences were saved.' })
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setBusy(false) }
  }
  const previewAppearance = (next: Partial<UiPreferences>) => {
    setAppearanceDraft((value) => ({ ...value, ...next }))
    setPreview(next)
  }
  const resetAppearance = () => {
    const defaults: UiPreferences = { language: 'en', theme: 'dark', accent: 'moss', density: 'comfortable', reducedMotion: false }
    setAppearanceDraft(defaults)
    setPreview(defaults)
  }
  const saveAppearance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      const next = await updateUserPreferences(saveUiPreferencesInput(appearanceDraft, compactNavigation, personalLanding))
      auth.replaceSnapshot(next)
      clearPreview()
      setNotice({ tone: 'ok', message: 'Your preferences were saved.' })
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setBusy(false) }
  }
  const saveMonitoring = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      setMonitoringSettings(await updateMonitoringSettings(monitoringSettings))
      setNotice({ tone: 'ok', message: 'Monitoring settings were applied.' })
    } catch (error) { setNotice({ tone: 'error', message: requestMessage(error) }) }
    finally { setBusy(false) }
  }

  return <div className="page-stack">
    <PageHeading title="Settings" description="Persistent settings for this local workspace and your account." />
    <NoticeBar notice={notice} />
    <div className="settings-layout account-settings-layout"><nav className="settings-nav" aria-label="Settings sections">{tabList.map((name) => <button key={name} className={name === tab ? 'selected' : ''} onClick={() => setTab(name)}>{name === 'Workspace' ? <Users size={16} /> : name === 'Personal' ? <CircleUserRound size={16} /> : name === 'Language & appearance' ? <Palette size={16} /> : name === 'Monitoring' ? <Clock3 size={16} /> : <AlertCircle size={16} />}{name}</button>)}</nav>
      <Card className="settings-content account-settings-content">
        <div className="settings-content-heading"><div><h2>{tab}</h2><p>{tab === 'Workspace' ? 'Shared defaults for the single local workspace' : tab === 'Personal' ? 'Saved to your account and applied on this device' : tab === 'Language & appearance' ? 'Language and display settings for your account' : tab === 'Monitoring' ? 'Saved operational settings for the local machine' : 'Saved operational alerts for your local account'}</p></div><Badge tone="good">{tab === 'Notifications' ? 'In-app' : 'Persistent'}</Badge></div>
        {tab === 'Workspace' && isAdmin && <form className="account-settings-form" onSubmit={(event) => void saveWorkspace(event)}><Field label="Workspace name"><input required maxLength={60} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></Field><Field label="Default landing page"><select value={workspaceLanding} onChange={(event) => setWorkspaceLanding(event.target.value as LandingPage)}><option value="dashboard">Dashboard</option><option value="machine">Machine overview</option></select></Field><div className="settings-readonly-row"><div><strong>Machine history timezone</strong><small>Configured when the local collector starts; raw timestamps remain UTC.</small></div><span>{history?.timeZone ? <span data-no-translate>{history.timeZone}</span> : 'Unavailable'}</span></div><div className="settings-footer"><span>Workspace changes apply for all local users.</span><Button kind="primary" icon={busy ? LoaderCircle : Save} disabled={busy}>{busy ? 'Saving' : 'Save workspace'}</Button></div></form>}
        {tab === 'Personal' && <form className="account-settings-form" onSubmit={(event) => void savePersonal(event)}><div className="settings-row account-settings-row"><div><strong>Compact navigation</strong><small>Remember a narrower sidebar for your account.</small></div><label className="account-switch"><input aria-label="Compact navigation" type="checkbox" checked={compactNavigation} onChange={(event) => setCompactNavigation(event.target.checked)} /><span aria-hidden="true" /></label></div><Field label="Default landing page"><select value={personalLanding} onChange={(event) => setPersonalLanding(event.target.value as LandingPage)}><option value="dashboard">Dashboard</option><option value="machine">Machine overview</option></select></Field><div className="settings-footer"><span>Saved to your profile.</span><Button kind="primary" icon={busy ? LoaderCircle : Save} disabled={busy}>{busy ? 'Saving' : 'Save preferences'}</Button></div></form>}
        {tab === 'Language & appearance' && <form className="account-settings-form appearance-form" onSubmit={(event) => void saveAppearance(event)}>
          <div className="appearance-grid">
            <Field label="Language"><select value={appearanceDraft.language} onChange={(event) => previewAppearance({ language: event.target.value as UiPreferences['language'] })}><option value="en">English</option><option value="ru">Русский</option></select></Field>
            <Field label="Theme"><select value={appearanceDraft.theme} onChange={(event) => previewAppearance({ theme: event.target.value as UiPreferences['theme'] })}><option value="dark">Dark</option><option value="light">Light</option><option value="system">Follow system</option></select></Field>
            <Field label="Accent color"><select value={appearanceDraft.accent} onChange={(event) => previewAppearance({ accent: event.target.value as UiPreferences['accent'] })}><option value="moss">Moss</option><option value="blue">Blue</option><option value="clay">Clay</option></select></Field>
            <Field label="Display density"><select value={appearanceDraft.density} onChange={(event) => previewAppearance({ density: event.target.value as UiPreferences['density'] })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></Field>
          </div>
          <div className="settings-row account-settings-row"><div><strong>Reduce motion</strong><small>Use shorter transitions and avoid non-essential movement.</small></div><label className="account-switch"><input aria-label="Reduce motion" type="checkbox" checked={appearanceDraft.reducedMotion} onChange={(event) => previewAppearance({ reducedMotion: event.target.checked })} /><span aria-hidden="true" /></label></div>
          <p className="appearance-help">Language changes menus, settings and help text. Minecraft values and user-entered names stay unchanged. Appearance changes preview immediately and are saved to your account.</p>
          <div className="settings-footer"><Button type="button" kind="secondary" disabled={busy} onClick={resetAppearance}>Reset appearance</Button><Button kind="primary" icon={busy ? LoaderCircle : Save} disabled={busy}>{busy ? 'Saving' : 'Save preferences'}</Button></div>
        </form>}
        {tab === 'Monitoring' && isAdmin && <form className="account-settings-form" onSubmit={(event) => void saveMonitoring(event)}><div className="settings-readonly-row"><div><strong>Live sample interval</strong><small>CPU, memory and network updates from one shared host sampler.</small></div><Field label="Seconds"><input type="number" min={1} max={60} step={1} value={monitoringSettings.fastSampleMs / 1000} onChange={(event) => setMonitoringSettings((value) => ({ ...value, fastSampleMs: Number(event.target.value) * 1000 }))} /></Field></div><div className="settings-readonly-row"><div><strong>History save interval</strong><small>Raw snapshots are saved less often; minute summaries include readings between saves.</small></div><Field label="Seconds"><input type="number" min={5} max={60} step={1} value={monitoringSettings.historySaveMs / 1000} onChange={(event) => setMonitoringSettings((value) => ({ ...value, historySaveMs: Number(event.target.value) * 1000 }))} /></Field></div><div className="settings-readonly-row"><div><strong>Disk refresh interval</strong><small>Disk usage refreshes separately from quick metrics.</small></div><Field label="Seconds"><input type="number" min={10} max={60} step={1} value={monitoringSettings.diskRefreshMs / 1000} onChange={(event) => setMonitoringSettings((value) => ({ ...value, diskRefreshMs: Number(event.target.value) * 1000 }))} /></Field></div><div className="settings-readonly-row"><div><strong>Server status check</strong><small>The dashboard player count updates after this interval.</small></div><Field label="Seconds"><input type="number" min={5} max={30} step={1} value={monitoringSettings.statusPollMs / 1000} onChange={(event) => setMonitoringSettings((value) => ({ ...value, statusPollMs: Number(event.target.value) * 1000 }))} /></Field></div><div className="settings-footer"><span>Changes apply immediately. History is retained using the current policy.</span><Button kind="primary" icon={busy ? LoaderCircle : Save} disabled={busy}>{busy ? 'Applying' : 'Apply monitoring'}</Button></div></form>}
        {tab === 'Notifications' && <NotificationsPanel />}
      </Card>
    </div>
  </div>
}
