import { useCallback, useEffect, useState } from 'react'
import { Check, CircleHelp, Cpu, LoaderCircle, Search, ShieldCheck } from 'lucide-react'
import type { JavaRuntime } from '@mmsmanager/shared'
import { getJavaRuntimes, probeJavaRuntime, scanJavaRuntimes } from '../api/servers'
import { Badge, Button, Card, Field, SectionHeading } from './ui'
import { useAuth } from '../state/use-auth'

export function JavaInventoryCard() {
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const [runtimes, setRuntimes] = useState<JavaRuntime[]>([])
  const [checked, setChecked] = useState(false)
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(isAdmin)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!isAdmin) return
    setLoading(true)
    try {
      const result = await getJavaRuntimes(signal)
      setRuntimes(result)
      setChecked(result.length > 0)
      setError(null)
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return
      setError(requestError instanceof Error ? requestError.message : 'Java runtimes could not be listed.')
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const probe = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await probeJavaRuntime(path)
      setRuntimes((current) => [...current.filter((item) => item.path !== result.path), result].sort((a, b) => b.major - a.major || a.path.localeCompare(b.path)))
      setChecked(true)
      setPath('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The Java executable could not be checked.')
    } finally {
      setBusy(false)
    }
  }

  const scan = async () => {
    setBusy(true)
    setError(null)
    try {
      setRuntimes(await scanJavaRuntimes())
      setChecked(true)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Java runtimes could not be checked.')
    } finally {
      setBusy(false)
    }
  }

  return <Card className="java-inventory-card"><SectionHeading title="Java runtime inventory" description="Admin-only local version checks; no game server is started." action={<Badge tone={isAdmin ? 'good' : 'neutral'}>{isAdmin ? 'Local host' : 'Restricted'}</Badge>} />
    {!isAdmin ? <div className="machine-coming-preview"><span className="machine-icon"><ShieldCheck size={18} /></span><div><strong>Administrator access required</strong><small>Java paths are only shown to administrators.</small></div></div> : <>
      <div className="java-inventory-note"><CircleHelp size={14} /><span>Checks start only when you select a button below. Each Java executable receives <code>-version</code> with a short timeout; Minecraft is never launched.</span></div>
      {loading ? <div className="local-server-empty"><LoaderCircle size={15} className="spinner" /> Reading checked runtimes…</div> : runtimes.length ? <div className="java-runtime-list">{runtimes.map((runtime) => <div className="java-runtime-row" key={runtime.path}><span className="java-runtime-icon"><Cpu size={15} /></span><span className="java-runtime-main"><strong>{runtime.vendor ?? 'Java'} {runtime.major}</strong><small>{runtime.version} · {runtime.source === 'discovered' ? 'discovered' : 'custom check'}</small><code>{runtime.path}</code></span><Badge tone="good"><Check size={11} /> Available</Badge></div>)}</div> : <div className="local-server-empty"><Search size={15} />{checked ? 'No Java runtime was found in standard local locations.' : 'No Java runtime has been checked in this session.'}</div>}
      <div className="java-custom-probe"><Field label="Custom Java executable path" hint="An administrator may check a specific absolute path. The path is not saved to a server yet."><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/usr/lib/jvm/java-21/bin/java" maxLength={1024} /></Field><Button type="button" icon={busy ? LoaderCircle : Search} disabled={busy || !path.trim()} onClick={() => void probe()}>{busy ? 'Checking' : 'Check path'}</Button></div>
      {error && <p className="server-import-error" role="alert">{error}</p>}
      <Button className="java-refresh-button" icon={busy ? LoaderCircle : Search} disabled={loading || busy} onClick={() => void scan()}>{busy ? 'Checking paths' : runtimes.length ? 'Rescan standard paths' : 'Scan standard paths'}</Button>
    </>}
  </Card>
}
