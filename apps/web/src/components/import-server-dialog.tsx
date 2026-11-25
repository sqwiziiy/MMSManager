import { useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { Archive, Check, FileArchive, FolderSearch, LoaderCircle, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react'
import type { JavaRuntime, ServerImportPreview, ServerZipImportPreview } from '@mmsmanager/shared'
import { getJavaRuntimes, inspectServerImport, publishServerZip, registerServerImport, scanJavaRuntimes, uploadServerZip } from '../api/servers'
import { currentLocale, translateText } from '../i18n/catalog'
import { Badge, Button, Field, IconButton } from './ui'

export function ImportServerDialog({ roots, onClose, onImported }: { roots: string[]; onClose: () => void; onImported: () => Promise<void> }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadAbort = useRef<AbortController | null>(null)
  const locale = currentLocale()
  const tr = (value: string) => translateText(value, locale)
  const [preview, setPreview] = useState<ServerZipImportPreview | null>(null)
  const [javaRuntimes, setJavaRuntimes] = useState<JavaRuntime[]>([])
  const [javaPath, setJavaPath] = useState('')
  const [name, setName] = useState('')
  const [minimum, setMinimum] = useState('1024')
  const [maximum, setMaximum] = useState('4096')
  const [acceptEula, setAcceptEula] = useState(false)
  const [trustExecutable, setTrustExecutable] = useState(false)
  const [startAfterImport, setStartAfterImport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'upload' | 'publish'>('idle')
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null)
  const [scanning, setScanning] = useState(false)
  const [hostFolderOpen, setHostFolderOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState<{ name: string; started: boolean; startError: string | null } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void getJavaRuntimes(controller.signal).then((items) => {
      setJavaRuntimes(items)
      if (items[0]) setJavaPath(items[0].path)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])
  useEffect(() => () => uploadAbort.current?.abort(), [])

  const selectFile = async (file?: File) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.zip')) { setError(tr('Choose a ZIP archive file.')); return }
    uploadAbort.current?.abort()
    const controller = new AbortController()
    uploadAbort.current = controller
    setBusy(true)
    setPhase('upload')
    setProgress({ loaded: 0, total: file.size })
    setError(null)
    setCompleted(null)
    setPreview(null)
    setAcceptEula(false)
    setTrustExecutable(false)
    setStartAfterImport(false)
    try {
      const result = await uploadServerZip(file, (loaded, total) => setProgress({ loaded, total }), controller.signal)
      setPreview(result)
      setName((result.rootFolder || result.uploadName.replace(/\.zip$/i, '')).slice(0, 60))
      setError(null)
    } catch (requestError) {
      if (!(requestError instanceof DOMException && requestError.name === 'AbortError')) setError(requestError instanceof Error ? tr(requestError.message) : tr('The archive could not be uploaded.'))
    } finally {
      if (uploadAbort.current === controller) uploadAbort.current = null
      setBusy(false)
      setPhase('idle')
      setProgress(null)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void selectFile(event.dataTransfer.files[0])
  }
  const scanJava = async () => {
    setScanning(true)
    setError(null)
    try {
      const items = await scanJavaRuntimes()
      setJavaRuntimes(items)
      setJavaPath(items[0]?.path ?? '')
    } catch (requestError) {
      setError(requestError instanceof Error ? tr(requestError.message) : tr('Java runtimes could not be scanned.'))
    } finally { setScanning(false) }
  }
  const publish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!preview || !preview.supported || !trustExecutable || !javaPath) return
    setBusy(true)
    setPhase('publish')
    setError(null)
    try {
      const result = await publishServerZip({
        token: preview.token, name: name.trim(), javaPath, minMemoryMb: Number(minimum), maxMemoryMb: Number(maximum),
        acceptEula, trustExecutable: true, startAfterImport,
      })
      window.dispatchEvent(new Event('mmsmanager:server-lifecycle'))
      await onImported()
      setCompleted({ name: result.server.name, started: result.started, startError: result.startError })
    } catch (requestError) {
      setError(requestError instanceof Error ? tr(requestError.message) : tr('The server archive could not be imported.'))
    } finally { setBusy(false); setPhase('idle') }
  }

  const cancelUpload = () => uploadAbort.current?.abort()
  const selectedRuntime = javaRuntimes.find((item) => item.path === javaPath)
  const compatibleRuntimes = preview?.requiredJavaMajor ? javaRuntimes.filter((item) => item.major >= preview.requiredJavaMajor!) : javaRuntimes
  const canPublish = Boolean(preview?.supported && name.trim() && javaPath && trustExecutable && Number(minimum) >= 512 && Number(maximum) >= Number(minimum) && Number(maximum) <= 131072)

  return <>
    <div className="overlay-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="server-import-dialog server-zip-dialog" role="dialog" aria-modal="true" aria-labelledby="server-import-title">
        <header className="server-import-header"><div><div className="wizard-kicker"><span className="wizard-kicker-icon"><Archive size={14} /></span> {tr('SERVER IMPORT')} <Badge>{tr('ZIP archive')}</Badge></div><h2 id="server-import-title">{tr('Import a server archive')}</h2><p>{tr('Choose a ZIP from this device. We will inspect it before creating a server folder.')}</p></div><IconButton icon={X} label={tr('Close import dialog')} onClick={onClose} disabled={busy} /></header>
        <div className="server-import-body">
          {!completed && <div className="server-zip-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <input ref={fileInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" className="sr-only" aria-label={tr('Choose a server ZIP archive')} onChange={(event) => { void selectFile(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
            <span className="server-zip-file-icon"><FileArchive size={22} /></span>
            <strong>{preview ? preview.uploadName : tr('Drop a ZIP archive here')}</strong>
            <span>{tr('Compressed uploads are limited to 128 MiB. ZIP64 is supported.')}</span>
            <Button type="button" icon={Upload} disabled={busy} onClick={() => fileInput.current?.click()}>{preview ? tr('Choose another archive') : tr('Choose ZIP archive')}</Button>
          </div>}
          {phase === 'upload' && progress && <div className="server-zip-upload-progress" role="status"><div><span>{tr('Uploading archive')}</span><strong>{progress.total ? `${Math.min(100, Math.round(progress.loaded / progress.total * 100))}%` : tr('Uploading')}</strong></div><progress max={progress.total ?? undefined} value={progress.total ? progress.loaded : undefined} /><Button type="button" onClick={cancelUpload}>{tr('Cancel upload')}</Button></div>}
          {preview && !completed && <form className="server-zip-publish-form" onSubmit={(event) => void publish(event)}>
            <div className="server-import-preview"><div className="server-import-preview-top"><div><strong>{name || preview.rootFolder || preview.uploadName}</strong><small>{preview.rootFolder ? `${tr('Top-level folder')}: ${preview.rootFolder}` : tr('Flat archive')}</small></div><Badge tone={preview.supported ? 'good' : 'danger'}>{preview.supported ? tr('Supported server') : tr('Unsupported loader')}</Badge></div>
              <div className="server-import-facts"><div><span>{tr('Software')}</span><strong>{preview.software === 'unknown' ? tr('Unknown') : `${preview.software[0]!.toUpperCase()}${preview.software.slice(1)}`}</strong></div><div><span>{tr('Version')}</span><strong>{preview.version ?? tr('Not detected')}</strong></div><div><span>{tr('Server JAR')}</span><strong>{preview.jarName ?? tr('Not detected')}</strong></div><div><span>{tr('Required Java')}</span><strong>{preview.requiredJavaMajor ? `Java ${preview.requiredJavaMajor}+` : tr('Not detected')}</strong></div><div><span>{tr('Game port')}</span><strong>{preview.port ?? tr('Not detected')}</strong></div><div><span>{tr('EULA in archive')}</span><strong>{preview.eula === 'accepted' ? tr('Accepted in file') : preview.eula === 'not-accepted' ? tr('Not accepted') : tr('Not found')}</strong></div><div><span>{tr('World folders')}</span><strong>{preview.worldFolders.length ? preview.worldFolders.join(', ') : tr('Not found')}</strong></div><div><span>{tr('Archive size')}</span><strong>{formatBytes(preview.compressedBytes)} · {formatBytes(preview.extractedBytes)} {tr('expanded')}</strong></div></div>
            </div>
            {!preview.supported && <div className="server-import-error" role="status">{preview.unsupportedReason ? tr(preview.unsupportedReason) : null}</div>}
            {preview.warnings.map((warning) => <div className="server-zip-warning" key={warning}><ShieldCheck size={15} /><span>{tr(warning)}</span></div>)}
            {preview.excludedPaths.length > 0 && <details className="server-zip-exclusions"><summary>{tr('Excluded metadata')} ({preview.excludedPaths.length}{preview.excludedPathsTruncated ? '+' : ''})</summary><ul>{preview.excludedPaths.map((path) => <li key={path} data-no-translate>{path}</li>)}</ul></details>}
            {preview.supported && <>
              <Field label={tr('Server name')}><input required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></Field>
              <div className="server-import-memory"><Field label={tr('Minimum memory (MB)')}><input type="number" min={512} max={131072} step={512} required value={minimum} onChange={(event) => setMinimum(event.target.value)} /></Field><Field label={tr('Maximum memory (MB)')}><input type="number" min={512} max={131072} step={512} required value={maximum} onChange={(event) => setMaximum(event.target.value)} /></Field></div>
              <div className="server-zip-java-row"><Field label={tr('Java runtime')}><select required value={javaPath} onChange={(event) => setJavaPath(event.target.value)}><option value="">{tr('Choose installed Java')}</option>{compatibleRuntimes.map((runtime) => <option key={runtime.path} value={runtime.path}>{`Java ${runtime.major} · ${runtime.vendor ?? runtime.version}${runtime.vendor ? ` (${runtime.version})` : ''}`}</option>)}</select></Field><Button type="button" icon={scanning ? LoaderCircle : RefreshCw} disabled={scanning || busy} onClick={() => void scanJava()}>{scanning ? tr('Scanning') : tr('Scan Java')}</Button></div>
              {compatibleRuntimes.length === 0 && <p className="server-import-note">{tr('Scan installed Java runtimes to choose a compatible version.')}</p>}
              {selectedRuntime && preview.requiredJavaMajor && selectedRuntime.major < preview.requiredJavaMajor && <p className="server-import-error" role="alert">{tr('The selected Java version is older than this server requires.')}</p>}
              <label className="server-zip-check"><input type="checkbox" checked={acceptEula} onChange={(event) => setAcceptEula(event.target.checked)} /><span><strong>{tr('I have read and accept the Minecraft EULA')}</strong><small>{tr('This choice is saved in the new server folder. It is required before the server can start.')}</small></span></label>
              <label className="server-zip-check server-zip-trust"><input type="checkbox" checked={trustExecutable} onChange={(event) => setTrustExecutable(event.target.checked)} /><span><strong>{tr('I trust this server JAR and its mods')}</strong><small>{tr('MMSManager will not execute supplied files during import. Starting the server runs this JAR.')}</small></span></label>
              <label className={`server-zip-check ${!acceptEula || !trustExecutable ? 'is-disabled' : ''}`}><input type="checkbox" checked={startAfterImport} disabled={!acceptEula || !trustExecutable} onChange={(event) => setStartAfterImport(event.target.checked)} /><span><strong>{tr('Start after import')}</strong><small>{tr('Leave unchecked to create the server in a stopped state.')}</small></span></label>
            </>}
            {error && <p className="server-import-error" role="alert">{error}</p>}
            <footer className="server-import-footer"><Button type="button" onClick={onClose} disabled={busy}>{tr('Cancel')}</Button><Button kind="primary" icon={phase === 'publish' ? LoaderCircle : Check} type="submit" disabled={busy || !canPublish}>{phase === 'publish' ? tr('Publishing archive') : tr('Import server')}</Button></footer>
          </form>}
          {completed && <div className="server-zip-complete" role="status"><span className="server-zip-complete-icon"><Check size={20} /></span><div><strong>{tr('Server imported')}: {completed.name}</strong><p>{completed.started ? tr('The server start was requested.') : tr('The server was added and remains stopped.')}</p>{completed.startError && <p className="server-import-error">{tr('Import succeeded, but the server did not start')}: {tr(completed.startError)}</p>}</div><Button kind="primary" onClick={onClose}>{tr('Done')}</Button></div>}
          {error && !preview && phase !== 'upload' && <p className="server-import-error" role="alert">{error}</p>}
          {!completed && <details className="server-import-host-path"><summary>{tr('Advanced: register a folder already on this machine')}</summary><p>{tr('Use this option when the server folder already exists on the local machine.')}</p><Button type="button" icon={FolderSearch} disabled={busy} onClick={() => setHostFolderOpen(true)}>{tr('Register host folder')}</Button></details>}
        </div>
      </section>
    </div>
    {hostFolderOpen && <HostFolderImportDialog roots={roots} onClose={() => setHostFolderOpen(false)} onImported={onImported} />}
  </>
}

function HostFolderImportDialog({ roots, onClose, onImported }: { roots: string[]; onClose: () => void; onImported: () => Promise<void> }) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [minimum, setMinimum] = useState('1024')
  const [maximum, setMaximum] = useState('4096')
  const [preview, setPreview] = useState<ServerImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locale = currentLocale()
  const tr = (value: string) => translateText(value, locale)

  const inspect = async () => {
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const result = await inspectServerImport(path)
      setPreview(result)
      if (!name) setName(result.directoryName)
    } catch (requestError) {
      setError(requestError instanceof Error ? tr(requestError.message) : tr('The directory could not be inspected.'))
    } finally { setBusy(false) }
  }
  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      await registerServerImport({ path: preview.path, name: name.trim(), minMemoryMb: Number(minimum), maxMemoryMb: Number(maximum) })
      window.dispatchEvent(new Event('mmsmanager:server-lifecycle'))
      await onImported()
      onClose()
    } catch (requestError) {
      setError(requestError instanceof Error ? tr(requestError.message) : tr('The server could not be added to the registry.'))
    } finally { setBusy(false) }
  }
  return <div className="overlay-scrim" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <section className="server-import-dialog" role="dialog" aria-modal="true" aria-labelledby="server-host-import-title">
      <header className="server-import-header"><div><div className="wizard-kicker"><span className="wizard-kicker-icon"><FolderSearch size={14} /></span> {tr('SERVER INVENTORY')} <Badge>{tr('Read only scan')}</Badge></div><h2 id="server-host-import-title">{tr('Register a server folder')}</h2><p>{tr('This folder must already exist on the machine running MMSManager.')}</p></div><IconButton icon={X} label={tr('Close import dialog')} onClick={onClose} disabled={busy} /></header>
      <div className="server-import-body">
        <div className="server-import-roots"><strong>{tr('Import locations')}</strong><span>{roots.length ? tr('Only folders in configured locations can be registered.') : tr('No import locations are configured.')}</span></div>
        <div className="server-import-path-row"><Field label={tr('Server folder path')} hint={tr('Only immediate entries, server.properties and eula.txt are inspected.')}><input autoFocus value={path} onChange={(event) => { setPath(event.target.value); setPreview(null) }} placeholder="/path/to/server" maxLength={1024} /></Field><Button type="button" icon={busy ? LoaderCircle : FolderSearch} disabled={busy || !path.trim()} onClick={() => void inspect()}>{busy ? tr('Inspecting') : tr('Inspect folder')}</Button></div>
        {preview && <form className="server-import-form" onSubmit={(event) => void register(event)}>
          <div className="server-import-preview"><div className="server-import-preview-top"><div><strong>{preview.directoryName}</strong><small>{tr('Existing server folder')}</small></div><Badge tone={preview.alreadyRegistered ? 'warn' : 'good'}>{preview.alreadyRegistered ? tr('Already registered') : tr('Folder found')}</Badge></div><div className="server-import-facts"><div><span>{tr('Software')}</span><strong>{preview.software === 'unknown' ? tr('Unknown') : preview.software[0]!.toUpperCase() + preview.software.slice(1)}</strong></div><div><span>{tr('Version')}</span><strong>{preview.version ?? tr('Not detected')}</strong></div><div><span>{tr('Server JAR')}</span><strong>{preview.jarName ?? tr('Not detected')}</strong></div><div><span>{tr('Port')}</span><strong>{preview.port ?? tr('Not detected')}</strong></div><div><span>{tr('EULA file')}</span><strong>{preview.eula === 'accepted' ? tr('Accepted in file') : preview.eula === 'not-accepted' ? tr('Not accepted') : tr('Not found')}</strong></div><div><span>{tr('World folders')}</span><strong>{preview.worldFolders.length ? preview.worldFolders.join(', ') : tr('Not found')}</strong></div></div></div>
          {!preview.alreadyRegistered && <><Field label={tr('Display name')}><input required minLength={1} maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></Field><div className="server-import-memory"><Field label={tr('Minimum memory (MB)')}><input type="number" min={512} max={131072} step={512} required value={minimum} onChange={(event) => setMinimum(event.target.value)} /></Field><Field label={tr('Maximum memory (MB)')}><input type="number" min={512} max={131072} step={512} required value={maximum} onChange={(event) => setMaximum(event.target.value)} /></Field></div></>}
          <div className="server-import-safety"><ShieldCheck size={15} /><span><strong>{tr('Read only import')}</strong><small>{tr('No files are written. This existing server folder stays unmanaged.')}</small></span></div>
          {error && <p className="server-import-error" role="alert">{error}</p>}
          <footer className="server-import-footer"><Button type="button" onClick={onClose} disabled={busy}>{tr('Cancel')}</Button><Button kind="primary" type="submit" disabled={busy || preview.alreadyRegistered || !name.trim() || Number(maximum) < Number(minimum)}>{busy ? tr('Adding server') : tr('Add to inventory')}</Button></footer>
        </form>}
        {error && !preview && <p className="server-import-error" role="alert">{error}</p>}
      </div>
    </section>
  </div>
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}
