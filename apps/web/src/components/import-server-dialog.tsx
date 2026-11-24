import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { FolderSearch, LoaderCircle, ShieldCheck, X } from 'lucide-react'
import type { ServerImportPreview } from '@mmsmanager/shared'
import { inspectServerImport, registerServerImport } from '../api/servers'
import { Badge, Button, Field, IconButton } from './ui'

export function ImportServerDialog({ roots, onClose, onImported }: { roots: string[]; onClose: () => void; onImported: () => Promise<void> }) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [minimum, setMinimum] = useState('1024')
  const [maximum, setMaximum] = useState('4096')
  const [preview, setPreview] = useState<ServerImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const inspect = async () => {
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const result = await inspectServerImport(path)
      setPreview(result)
      if (!name) setName(result.directoryName)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The directory could not be inspected.')
    } finally {
      setBusy(false)
    }
  }

  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      await registerServerImport({
        path: preview.path,
        name: name.trim(),
        minMemoryMb: Number(minimum),
        maxMemoryMb: Number(maximum),
      })
      window.dispatchEvent(new Event('mmsmanager:server-lifecycle'))
      await onImported()
      onClose()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The server could not be added to the registry.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="overlay-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section className="server-import-dialog" role="dialog" aria-modal="true" aria-labelledby="server-import-title">
      <header className="server-import-header"><div><div className="wizard-kicker"><span className="wizard-kicker-icon"><FolderSearch size={14} /></span> SERVER INVENTORY <Badge>Read only scan</Badge></div><h2 id="server-import-title">Register a server folder</h2><p>This folder must already exist on the machine running MMSManager.</p></div><IconButton icon={X} label="Close import dialog" onClick={onClose} disabled={busy} /></header>
      <div className="server-import-body">
        <div className="server-import-roots"><strong>Import locations</strong><span>{roots.length ? 'Only folders in configured locations can be registered.' : 'No import locations are configured.'}</span></div>
        <details className="server-import-host-path"><summary>Advanced: register a folder already on this machine</summary><div className="server-import-path-row"><Field label="Server folder path" hint="Only its immediate entries, server.properties and eula.txt are inspected."><input autoFocus value={path} onChange={(event) => { setPath(event.target.value); setPreview(null) }} placeholder="/path/to/server" maxLength={1024} /></Field><Button type="button" icon={busy ? LoaderCircle : FolderSearch} disabled={busy || !path.trim()} onClick={() => void inspect()}>{busy ? 'Inspecting' : 'Inspect folder'}</Button></div></details>
        {preview && <form className="server-import-form" onSubmit={(event) => void register(event)}>
          <div className="server-import-preview"><div className="server-import-preview-top"><div><strong>{preview.directoryName}</strong><small>Existing server folder</small></div><Badge tone={preview.alreadyRegistered ? 'warn' : 'good'}>{preview.alreadyRegistered ? 'Already registered' : 'Folder found'}</Badge></div><div className="server-import-facts"><div><span>Software</span><strong>{preview.software === 'unknown' ? 'Unknown' : preview.software[0]!.toUpperCase() + preview.software.slice(1)}</strong></div><div><span>Version</span><strong>{preview.version ?? 'Not detected'}</strong></div><div><span>Server JAR</span><strong>{preview.jarName ?? 'Not detected'}</strong></div><div><span>Port</span><strong>{preview.port ?? 'Not detected'}</strong></div><div><span>EULA file</span><strong>{preview.eula === 'accepted' ? 'Accepted in file' : preview.eula === 'not-accepted' ? 'Not accepted' : 'Not found'}</strong></div><div><span>World folders</span><strong>{preview.worldFolders.length ? preview.worldFolders.join(', ') : 'Not found'}</strong></div></div></div>
          {!preview.alreadyRegistered && <>
            <Field label="Display name"><input required minLength={1} maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <div className="server-import-memory"><Field label="Minimum memory (MB)"><input type="number" min={512} max={131072} step={512} required value={minimum} onChange={(event) => setMinimum(event.target.value)} /></Field><Field label="Maximum memory (MB)"><input type="number" min={512} max={131072} step={512} required value={maximum} onChange={(event) => setMaximum(event.target.value)} /></Field></div>
          </>}
          <div className="server-import-safety"><ShieldCheck size={15} /><span><strong>Read only import</strong><small>No files are written and the server will remain unmanaged until a later ownership review.</small></span></div>
          {error && <p className="server-import-error" role="alert">{error}</p>}
          <footer className="server-import-footer"><Button type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button kind="primary" type="submit" disabled={busy || preview.alreadyRegistered || !name.trim() || Number(maximum) < Number(minimum)}>{busy ? 'Adding server' : 'Add to local registry'}</Button></footer>
        </form>}
        {error && !preview && <p className="server-import-error" role="alert">{error}</p>}
      </div>
    </section>
  </div>
}
