import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, CircleAlert, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react'
import { ApiRequestError } from '../api/auth'
import { Button, Field } from '../components/ui'
import { useAuth } from '../state/use-auth'
import type { AuthMe } from '@mmsmanager/shared'
import { LanguagePicker } from '../i18n/locale'

function intendedPath(state: unknown): string | null {
  if (!state || typeof state !== 'object' || !('from' in state)) return null
  const from = (state as { from?: unknown }).from
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return null
  return from
}

function fallbackPath(snapshot: AuthMe): string {
  return snapshot.user.preferences.defaultLanding === 'machine' ? '/machine' : '/'
}

function AuthBrand() {
  return <div className="auth-brand"><span className="brand-glyph" aria-hidden="true"><i /><i /><i /><i /></span><span>MMSManager</span></div>
}

export function SetupPage() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (password !== confirmPassword) {
      setError('The passwords do not match.')
      return
    }
    setBusy(true)
    try {
      const snapshot = await auth.completeSetup({ token: token.trim(), username: username.trim(), displayName: displayName.trim(), password, confirmPassword })
      setToken('')
      setPassword('')
      setConfirmPassword('')
      navigate(intendedPath(location.state) ?? fallbackPath(snapshot), { replace: true })
    } catch (requestError) {
      setError(requestError instanceof ApiRequestError ? requestError.message : 'The administrator could not be created. Check the local API and try again.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-stage">
    <section className="auth-shell" aria-labelledby="setup-title">
      <AuthBrand />
      <LanguagePicker />
      <div className="auth-card">
        <div className="auth-icon"><ShieldCheck size={20} strokeWidth={1.7} /></div>
        <p className="auth-eyebrow">Local administrator setup</p>
        <h1 id="setup-title">Create your administrator</h1>
        <p className="auth-description">This is the first account for the local MMSManager workspace. Setup closes after the account is created.</p>
        <div className="auth-instructions"><KeyRound size={16} /><div><strong>Get the one-time setup key on the host</strong><p>The API prints its owner-only file path in the local terminal. Default location:</p><code>cat ~/.local/state/mmsmanager/bootstrap-token</code><small>If you set <code>MMSMANAGER_DATA_DIR</code>, read <code>bootstrap-token</code> from that directory. The key is never sent to this page.</small></div></div>
        {error && <div className="auth-error" role="alert"><CircleAlert size={15} />{error}</div>}
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <Field label="One-time setup key"><input aria-label="One-time setup key" name="bootstrap-token" type="password" autoComplete="off" required minLength={40} maxLength={80} value={token} onChange={(event) => setToken(event.target.value)} /></Field>
          <div className="auth-form-grid">
            <Field label="Username"><input name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
            <Field label="Display name"><input name="displayName" autoComplete="name" required maxLength={60} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
          </div>
          <Field label="Password" hint="Use at least 14 characters. Passwords are stored as Argon2id hashes."><input name="password" type="password" autoComplete="new-password" required minLength={14} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <Field label="Confirm password"><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={14} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></Field>
          <Button kind="primary" icon={busy ? LoaderCircle : ArrowRight} className={busy ? 'auth-submit is-busy' : 'auth-submit'} disabled={busy}>{busy ? 'Creating administrator' : 'Create administrator'}</Button>
        </form>
      </div>
      <p className="auth-footnote"><LockKeyhole size={13} /> Local only · the bootstrap key expires and can be rotated by restarting the API</p>
    </section>
  </main>
}

export function LoginPage() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const snapshot = await auth.signIn(username.trim(), password)
      setPassword('')
      navigate(intendedPath(location.state) ?? fallbackPath(snapshot), { replace: true })
    } catch (requestError) {
      setError(requestError instanceof ApiRequestError ? requestError.message : 'The local API could not complete sign in. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-stage">
    <section className="auth-shell auth-shell-login" aria-labelledby="login-title">
      <AuthBrand />
      <LanguagePicker />
      <div className="auth-card">
        <div className="auth-icon"><LockKeyhole size={19} strokeWidth={1.7} /></div>
        <p className="auth-eyebrow">Local workspace</p>
        <h1 id="login-title">Sign in to MMSManager</h1>
        <p className="auth-description">Use an account created by the administrator of this local workspace.</p>
        {error && <div className="auth-error" role="alert"><CircleAlert size={15} />{error}</div>}
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <Field label="Username"><input name="username" autoComplete="username" autoCapitalize="none" required minLength={3} maxLength={32} value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
          <Field label="Password"><input name="password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <Button kind="primary" icon={busy ? LoaderCircle : ArrowRight} className={busy ? 'auth-submit is-busy' : 'auth-submit'} disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</Button>
        </form>
      </div>
      <p className="auth-footnote">MMSManager · Mentality Minecraft Server Manager</p>
    </section>
  </main>
}

export function AuthLoadingPage({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <main className="auth-stage"><section className="auth-shell auth-state-shell"><AuthBrand /><div className="auth-card auth-state-card"><div className="auth-icon"><LoaderCircle className="auth-spinner" size={19} /></div><h1>Connecting to the local workspace</h1><p className="auth-description">Checking setup status and your current session.</p>{error && <div className="auth-error" role="alert">{error}</div>}{error && <Button kind="secondary" onClick={onRetry}>Retry connection</Button>}</div></section></main>
}
