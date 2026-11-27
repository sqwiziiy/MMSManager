import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ChevronLeft, ChevronRight, CircleAlert, Cpu, Download, Folder, HardDrive, Layers3, LoaderCircle, MemoryStick, Server, ShieldCheck, X } from 'lucide-react'
import type { InstallCatalog, InstallOperation, InstallSoftware, JavaRuntime, ServerInstallRequest, ServerTemplate } from '@mmsmanager/shared'
import { cancelServerInstall, createServerInstall, getInstallCatalog, getServerInstall, getJavaRuntimes, scanJavaRuntimes } from '../api/servers'
import { useAuth } from '../state/use-auth'
import { Button, IconButton } from './ui'
import { javaRuntimeLabel } from '../lib/java-runtime'
import { SoftwareIdentity, SoftwareLogo } from './software-identity'
import { currentLocale, translateApiError } from '../i18n/catalog'

type WizardStep = 'details' | 'software' | 'resources' | 'review'
const steps: { id: WizardStep; label: string }[] = [
  { id: 'details', label: 'Details' }, { id: 'software', label: 'Software' },
  { id: 'resources', label: 'Resources' }, { id: 'review', label: 'Review' },
]
const softwareOptions: { id: InstallSoftware; title: string; description: string }[] = [
  { id: 'vanilla', title: 'Vanilla', description: 'Official Minecraft Java server' },
  { id: 'fabric', title: 'Fabric', description: 'Lightweight modding platform' },
  { id: 'forge', title: 'Forge', description: 'Official Forge mod loader' },
  { id: 'neoforge', title: 'NeoForge', description: 'Community-led Forge successor' },
  { id: 'paper', title: 'Paper', description: 'Plugin-ready server software' },
]

export function CreateServerWizard({ onClose, preset }: { onClose: () => void; preset?: ServerTemplate }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const isAdmin = auth.snapshot?.user.role === 'administrator'
  const [step, setStep] = useState<WizardStep>('details')
  const [name, setName] = useState(preset?.name ?? 'Local community server')
  const [directoryName, setDirectoryName] = useState(() => {
    const safe = (preset?.name ?? 'community-server').toLowerCase().replace(/[^a-z0-9._ -]+/g, '-').replace(/^[^a-z0-9]+/, '').trim().replace(/\s+/g, '-').slice(0, 64)
    return safe && safe !== '.' && safe !== '..' ? safe : 'server-from-template'
  })
  const [software, setSoftware] = useState<InstallSoftware>(preset?.software ?? 'vanilla')
  const [version, setVersion] = useState(preset?.version ?? '')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [installerVersion, setInstallerVersion] = useState('')
  const [paperBuild, setPaperBuild] = useState<number | undefined>()
  const [catalog, setCatalog] = useState<InstallCatalog | null>(null)
  const [versionCatalog, setVersionCatalog] = useState<InstallCatalog | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [runtimes, setRuntimes] = useState<JavaRuntime[]>([])
  const [javaPath, setJavaPath] = useState('')
  const [javaLoading, setJavaLoading] = useState(false)
  const [javaError, setJavaError] = useState('')
  const [minMemoryMb, setMinMemoryMb] = useState(preset?.minMemoryMb ?? 1024)
  const [maxMemoryMb, setMaxMemoryMb] = useState(preset?.maxMemoryMb ?? 4096)
  const [port, setPort] = useState(25565)
  const [eulaAccepted, setEulaAccepted] = useState(false)
  const [operation, setOperation] = useState<InstallOperation | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState('')
  const [presetNotice, setPresetNotice] = useState('')
  const currentIndex = steps.findIndex((item) => item.id === step)
  const selectedRuntime = runtimes.find((runtime) => runtime.path === javaPath) ?? null
  const requiredJavaMajor = versionCatalog?.requiredJavaMajor ?? null
  const softwareTitle = softwareOptions.find((option) => option.id === software)?.title ?? software
  const selectedArtifactBuild = software === 'paper' ? paperBuild : undefined
  const presetSoftware = preset?.software
  const presetVersion = preset?.version
  const needsLoader = software === 'fabric' || software === 'forge' || software === 'neoforge'
  const canContinue = step !== 'software' || Boolean(catalog && version && !catalogLoading && !catalogError && (!needsLoader || loaderVersion) && (software !== 'paper' || paperBuild))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !operation && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, operation])

  useEffect(() => {
    if (!isAdmin) return
    const controller = new AbortController()
    void getJavaRuntimes(controller.signal)
      .then((found) => {
        setRuntimes(found)
        setJavaPath((current) => current || found[0]?.path || '')
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setJavaError(message(error)) })
    return () => controller.abort()
  }, [isAdmin])

  useEffect(() => {
    if (!isAdmin) return
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError('')
    setCatalog(null)
    setVersionCatalog(null)
    void getInstallCatalog(software, undefined, controller.signal).then((next) => {
      setCatalog(next)
      if (presetSoftware === software && presetVersion && !next.versions.includes(presetVersion)) setPresetNotice(`The saved ${presetSoftware} ${presetVersion} version is no longer listed. Choose an available version below.`)
      setVersion((current) => next.versions.includes(current) ? current : next.versions[0] ?? '')
      if (software === 'fabric') setInstallerVersion(next.installerVersion ?? '')
    }).catch((error: unknown) => { if (!controller.signal.aborted) setCatalogError(message(error)) })
      .finally(() => { if (!controller.signal.aborted) setCatalogLoading(false) })
    return () => controller.abort()
  }, [software, isAdmin, presetSoftware, presetVersion])

  useEffect(() => {
    if (!isAdmin || !version) return
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError('')
    setVersionCatalog(null)
    void getInstallCatalog(software, version, controller.signal).then((next) => {
      setVersionCatalog(next)
      if (software === 'fabric' || software === 'forge' || software === 'neoforge') {
        const availableLoaders = [...next.loaders, ...next.experimentalLoaders]
        setLoaderVersion((current) => availableLoaders.includes(current) ? current : next.loaders[0] ?? next.experimentalLoaders[0] ?? '')
      }
      if (software === 'fabric') {
        setInstallerVersion(next.installerVersion ?? '')
      }
      if (software === 'paper') setPaperBuild((current) => current && next.builds.includes(current) ? current : next.builds[0])
    }).catch((error: unknown) => { if (!controller.signal.aborted) setCatalogError(message(error)) })
      .finally(() => { if (!controller.signal.aborted) setCatalogLoading(false) })
    return () => controller.abort()
  }, [software, version, isAdmin])

  const operationId = operation?.id
  const operationStatus = operation?.status
  useEffect(() => {
    if (!operationId || operationStatus === 'completed' || operationStatus === 'failed') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const latest = await getServerInstall(operationId)
        if (cancelled) return
        setOperation(latest)
        if (latest.status === 'completed') window.dispatchEvent(new Event('mmsmanager:server-lifecycle'))
        if (latest.status !== 'completed' && latest.status !== 'failed') timer = setTimeout(() => void poll(), 700)
      } catch (error) {
        if (!cancelled) { setActionError(message(error)); timer = setTimeout(() => void poll(), 1500) }
      }
    }
    timer = setTimeout(() => void poll(), 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [operationId, operationStatus])

  const normalizedDirectory = useMemo(() => directoryName.trim(), [directoryName])

  const refreshJava = async () => {
    setJavaLoading(true)
    setJavaError('')
    try {
      const found = await scanJavaRuntimes()
      setRuntimes(found)
      setJavaPath((current) => found.some((runtime) => runtime.path === current) ? current : found[0]?.path ?? '')
    } catch (error) { setJavaError(message(error)) } finally { setJavaLoading(false) }
  }

  const chooseSoftware = (next: InstallSoftware) => {
    if (software === next) return
    setSoftware(next)
    setPresetNotice('')
    setVersion('')
    setLoaderVersion('')
    setPaperBuild(undefined)
  }

  const submit = async () => {
    if (!isAdmin || !javaPath || !version || submitting) return
    setSubmitting(true)
    setActionError('')
    const input: ServerInstallRequest = {
      name: name.trim(), directoryName: normalizedDirectory, software, version,
      javaPath, minMemoryMb, maxMemoryMb, port, eulaAccepted,
      ...(software === 'fabric' ? { loaderVersion, installerVersion } : software === 'forge' || software === 'neoforge' ? { loaderVersion } : {}),
      ...(selectedArtifactBuild ? { paperBuild: selectedArtifactBuild } : {}),
    }
    try {
      const started = await createServerInstall(input)
      setOperation(started)
    } catch (error) { setActionError(message(error)) } finally { setSubmitting(false) }
  }

  const next = () => setStep(steps[currentIndex + 1]!.id)
  const installDone = operation?.status === 'completed'
  const installing = Boolean(operation && ['pending', 'downloading', 'validating'].includes(operation.status))
  const installCancelled = operation?.error?.code === 'INSTALL_CANCELLED'
  const cancelInstallation = async () => {
    if (!operation || !window.confirm('Cancel this installation? Any files already created will remain in the managed folder for review.')) return
    setCancelling(true)
    setActionError('')
    try { setOperation(await cancelServerInstall(operation.id)) }
    catch (error) { setActionError(message(error)) }
    finally { setCancelling(false) }
  }

  return <div className="overlay-scrim wizard-scrim" onMouseDown={(event) => event.target === event.currentTarget && !operation && onClose()}>
    <section className="wizard-dialog install-wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="wizard-header install-wizard-header"><div><div className="wizard-kicker"><span className="wizard-kicker-icon"><Server size={14} /></span> Server setup</div><h2 id="wizard-title">Create server</h2><p>Downloads from official providers into a new managed directory.</p></div><IconButton icon={X} label="Close server setup" onClick={onClose} disabled={installing || cancelling} /></div>
      {!operation && <div className="wizard-steps" aria-label="Creation steps">{steps.map((item, index) => <div className={`wizard-step ${step === item.id ? 'active' : ''} ${index < currentIndex ? 'complete' : ''}`} key={item.id}><span>{index < currentIndex ? <Check size={13} /> : `0${index + 1}`}</span><small>{item.label}</small>{index < steps.length - 1 && <i />}</div>)}</div>}

      {operation ? <div className="install-progress-view" aria-live="polite">
        <div className={`install-result-icon ${installDone ? 'success' : operation.status === 'failed' ? 'failure' : ''}`}>{operation.status === 'failed' ? <CircleAlert size={23} /> : installDone ? <Check size={24} /> : <LoaderCircle className="spin" size={22} />}</div>
        <p className="eyebrow">{installDone ? 'Installation complete' : installCancelled ? 'Installation cancelled' : operation.status === 'failed' ? 'Installation stopped' : 'Installation in progress'}</p>
        <h3>{installDone ? `${operation.name} is installed` : installCancelled ? 'Setup was cancelled' : operation.status === 'failed' ? 'Could not finish setup' : operation.phase.replaceAll('-', ' ')}</h3>
        <p>{installDone ? 'The server is registered locally and is currently stopped.' : operation.error ? translateApiError(operation.error.message, operation.error.code, currentLocale()) : `Installing ${operation.software} ${operation.version} into a new managed folder.`}</p>
        {installing && <div className="install-progress-track" role="progressbar" aria-label="Installation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={operation.progress}><span style={{ width: `${operation.progress}%` }} /></div>}
        <div className="install-progress-meta"><span>{operation.status === 'completed' ? 'Complete' : `${operation.progress}%`}</span><span>{operation.directoryName}</span></div>
        {operation.error && <div className="install-error-card">{operation.partialDirectory && <span>Partial files were preserved for review under the managed root.</span>}</div>}
        {operation.installerLog && <details className="install-log-panel"><summary>Installer output</summary><pre>{operation.installerLog}</pre></details>}
        {installDone && <div className="install-summary-list"><div><span>Software</span><strong><SoftwareIdentity software={operation.software} version={operation.version} /></strong></div>{operation.loaderVersion && <div><span>Loader build</span><strong data-no-translate>{operation.loaderVersion}</strong></div>}<div><span>Java</span><strong>{selectedRuntime ? `Java ${selectedRuntime.major}` : 'Selected runtime'}</strong></div><div><span>Memory</span><strong>{minMemoryMb}–{maxMemoryMb} MB</strong></div><div><span>EULA</span><strong>{eulaAccepted ? 'Accepted explicitly' : 'Not accepted'}</strong></div>{operation.checksumType && <div><span>Provider checksum</span><strong>{operation.checksumType.toUpperCase()} verified</strong></div>}</div>}
        <div className="install-progress-actions">
          {installing && <Button kind="danger" icon={CircleAlert} disabled={cancelling} onClick={() => void cancelInstallation()}>{cancelling ? 'Cancelling…' : 'Cancel installation'}</Button>}
          {operation.status === 'failed' && <Button kind="secondary" onClick={() => {
            if (operation.partialDirectory) {
              const suffix = `-retry-${String(Date.now()).slice(-5)}`
              setDirectoryName(`${operation.directoryName.slice(0, 64 - suffix.length)}${suffix}`)
            }
            setActionError('')
            setOperation(null)
            setStep('details')
          }}>Review and retry</Button>}
          {installDone && operation.serverId && <Button kind="primary" onClick={() => { onClose(); navigate(`/servers/${operation.serverId}/overview`) }}>Open server</Button>}
          <Button kind={installDone ? 'quiet' : 'secondary'} disabled={installing} onClick={onClose}>{installing ? 'Installing…' : 'Close'}</Button>
        </div>
      </div> : <>
        {!isAdmin ? <div className="install-locked"><ShieldCheck size={26} /><strong>Administrator access required</strong><p>Members can view the local inventory but cannot install servers.</p></div> : <>
          <div className="wizard-body install-wizard-body">
            {step === 'details' && <div className="wizard-step-content"><div className="wizard-step-intro"><span className="wizard-content-icon"><Folder size={18} /></span><div><h3>Choose a name and folder</h3><p>Every install uses a new, dedicated directory.</p></div></div>
              <FieldWizard label="Server name"><input autoFocus value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="e.g. Alder community" /></FieldWizard>
              <FieldWizard label="New directory name" hint="Created in a new managed server folder."><input value={directoryName} maxLength={64} onChange={(event) => setDirectoryName(event.target.value)} placeholder="alder-community" /></FieldWizard>
              <div className="install-info-row"><HardDrive size={15} /><span>Existing files and worlds are never overwritten. Failed partial installs are preserved for review.</span></div>
            </div>}
            {step === 'software' && <div className="wizard-step-content"><div className="wizard-step-intro"><span className="wizard-content-icon"><Download size={18} /></span><div><h3>Select official server software</h3><p>Stable releases are recommended; experimental builds are labeled.</p></div></div>
              <section className="software-category"><h4>Vanilla</h4><div className="software-options">{softwareOptions.filter((option) => option.id === 'vanilla').map((option) => <SoftwareOption key={option.id} option={option} selected={software === option.id} onSelect={chooseSoftware} />)}</div></section>
              <section className="software-category"><h4>Mod loaders</h4><div className="software-options">{softwareOptions.filter((option) => ['fabric', 'forge', 'neoforge'].includes(option.id)).map((option) => <SoftwareOption key={option.id} option={option} selected={software === option.id} onSelect={chooseSoftware} />)}</div></section>
              <section className="software-category"><h4>Plugin loaders</h4><div className="software-options">{softwareOptions.filter((option) => option.id === 'paper').map((option) => <SoftwareOption key={option.id} option={option} selected={software === option.id} onSelect={chooseSoftware} />)}{(['Purpur', 'Spigot', 'Bukkit'] as const).map((name) => <div key={name} className="software-option unsupported" aria-disabled="true"><span className="software-logo software-logo-unsupported"><Layers3 size={18} /></span><span><strong>{name}</strong><small>Plugin-ready server software</small></span><span className="coming-soon">Coming soon</span></div>)}</div></section>
              <div className="install-select-grid"><FieldWizard label="Minecraft release"><select aria-label="Minecraft release" value={version} onChange={(event) => setVersion(event.target.value)} disabled={catalogLoading || !catalog?.versions.length}><option value="">{catalogLoading ? 'Loading official versions…' : 'Choose a version'}</option>{catalog?.versions.map((item) => <option key={item} value={item}>{item}</option>)}</select></FieldWizard>
                {needsLoader && <FieldWizard label={`${softwareTitle} version`}><select aria-label={`${softwareTitle} version`} value={loaderVersion} onChange={(event) => setLoaderVersion(event.target.value)} disabled={catalogLoading || !(versionCatalog?.loaders.length || versionCatalog?.experimentalLoaders.length)}><option value="">Choose loader version</option>{versionCatalog?.loaders.length ? <optgroup label={software === 'forge' ? 'Recommended' : 'Stable'}>{versionCatalog.loaders.map((item) => <option key={item} value={item}>{item}</option>)}</optgroup> : null}{versionCatalog?.experimentalLoaders.length ? <optgroup label="Latest / experimental">{versionCatalog.experimentalLoaders.map((item) => <option key={item} value={item}>{item}</option>)}</optgroup> : null}</select></FieldWizard>}
                {software === 'fabric' && <FieldWizard label="Fabric installer"><input value={installerVersion} readOnly aria-label="Fabric installer version" /></FieldWizard>}
                {software === 'paper' && <FieldWizard label="Paper stable build"><select aria-label="Paper stable build" value={paperBuild ?? ''} onChange={(event) => setPaperBuild(Number(event.target.value))} disabled={catalogLoading || !versionCatalog?.builds.length}><option value="">Choose stable build</option>{versionCatalog?.builds.map((item) => <option key={item} value={item}>{item}</option>)}</select></FieldWizard>}
              </div>
              {(software === 'forge' || software === 'neoforge') && <div className="install-info-row"><ShieldCheck size={15} /><span>The installer runs from its official provider in a private, resource-limited folder. The provider-published SHA-256 is checked; SHA-1 is used only when it is the strongest checksum the official source publishes.</span></div>}
              {requiredJavaMajor && <div className="install-info-row"><Cpu size={15} /><span>Mojang metadata requires Java {requiredJavaMajor} or newer for this Minecraft release.</span></div>}
              {catalogLoading && <div className="install-inline-status"><LoaderCircle className="spin" size={14} /> Contacting official version metadata…</div>}
              {catalogError && <div className="install-error-inline"><CircleAlert size={15} /><span>{catalogError}</span></div>}
              {presetNotice && <div className="install-error-inline"><CircleAlert size={15} /><span>{presetNotice}</span></div>}
            </div>}
            {step === 'resources' && <div className="wizard-step-content"><div className="wizard-step-intro"><span className="wizard-content-icon"><MemoryStick size={18} /></span><div><h3>Assign Java and resources</h3><p>Java is selected for this server only.</p></div></div>
              <div className="install-java-row"><FieldWizard label="Java runtime"><select aria-label="Java runtime" value={javaPath} onChange={(event) => setJavaPath(event.target.value)} disabled={!runtimes.length}>{runtimes.map((runtime) => <option key={runtime.path} value={runtime.path}>{javaRuntimeLabel(runtime, runtimes)}</option>)}</select></FieldWizard><Button kind="secondary" onClick={() => void refreshJava()} disabled={javaLoading}><LoaderCircle className={javaLoading ? 'spin' : ''} size={14} />{javaLoading ? 'Scanning…' : runtimes.length ? 'Rescan Java' : 'Scan Java'}</Button></div>
              {javaError && <div className="install-error-inline"><CircleAlert size={15} /><span>{javaError}</span></div>}
              {!runtimes.length && <div className="install-info-row"><Cpu size={15} /><span>Java is not scanned automatically. Scan or probe a runtime before installation.</span></div>}
              {requiredJavaMajor && selectedRuntime && selectedRuntime.major < requiredJavaMajor && <div className="install-error-inline"><CircleAlert size={15} /><span>Java {selectedRuntime.major} is too old for this release. Choose Java {requiredJavaMajor} or newer.</span></div>}
              <div className="install-select-grid"><FieldWizard label="Minimum memory (MB)"><input type="number" min={512} max={131072} step={512} value={minMemoryMb} onChange={(event) => setMinMemoryMb(Number(event.target.value))} /></FieldWizard><FieldWizard label="Maximum memory (MB)"><input type="number" min={512} max={131072} step={512} value={maxMemoryMb} onChange={(event) => setMaxMemoryMb(Number(event.target.value))} /></FieldWizard><FieldWizard label="Server port"><input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} /></FieldWizard></div>
              <div className="install-info-row"><ShieldCheck size={15} /><span>New servers bind to loopback initially. A local port check runs before download.</span></div>
            </div>}
            {step === 'review' && <div className="wizard-step-content"><div className="wizard-step-intro"><span className="wizard-content-icon"><Check size={18} /></span><div><h3>Review installation</h3><p>Confirm the provider, directory and startup settings.</p></div></div>
              <div className="wizard-review-card"><div className="wizard-review-banner"><span className="wizard-review-mark"><Server size={18} /></span><div><strong>{name || 'Untitled server'}</strong><small>New server · stopped after install</small></div></div><div className="wizard-review-grid"><div><span>Software</span><strong>{softwareTitle} {version}{needsLoader && loaderVersion ? ` · ${loaderVersion}` : software === 'paper' && paperBuild ? ` · build ${paperBuild}` : ''}</strong></div><div><span>Java</span><strong>{selectedRuntime ? `${selectedRuntime.vendor ?? 'Java'} ${selectedRuntime.major}` : 'Not selected'}</strong></div><div><span>Memory</span><strong>{minMemoryMb}–{maxMemoryMb} MB</strong></div><div><span>Port</span><strong>{port}</strong></div><div><span>Folder</span><strong>{normalizedDirectory || 'Not selected'}</strong></div><div><span>Network</span><strong>Loopback only</strong></div></div></div>
              <label className="install-eula-check"><input type="checkbox" checked={eulaAccepted} onChange={(event) => setEulaAccepted(event.target.checked)} /><span>I have read and accept the <a href="https://www.minecraft.net/en-us/eula" target="_blank" rel="noreferrer">Minecraft EULA</a>.</span></label>
              <div className="install-info-row"><ShieldCheck size={15} /><span>The install records <code>eula=true</code> only if you check this box. Otherwise it writes <code>eula=false</code> and the server cannot start.</span></div>
              {actionError && <div className="install-error-inline"><CircleAlert size={15} /><span>{actionError}</span></div>}
            </div>}
          </div>
          <div className="wizard-footer"><Button kind="quiet" icon={ChevronLeft} onClick={() => currentIndex === 0 ? onClose() : setStep(steps[currentIndex - 1]!.id)}>{currentIndex === 0 ? 'Cancel' : 'Back'}</Button><span className="wizard-footer-note">Step {currentIndex + 1} of {steps.length}</span>{step === 'review' ? <Button kind="primary" icon={Download} iconSide="right" onClick={() => void submit()} disabled={submitting || !javaPath || !requiredJavaMajor || !canContinue || !name.trim() || !normalizedDirectory || !Number.isInteger(port) || port < 1 || port > 65535 || maxMemoryMb < minMemoryMb}>{submitting ? 'Starting…' : 'Install server'}</Button> : <Button kind="primary" icon={ChevronRight} iconSide="right" onClick={next} disabled={!canContinue || step === 'details' && (!name.trim() || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(normalizedDirectory) || normalizedDirectory === '.' || normalizedDirectory === '..')}>{currentIndex === steps.length - 1 ? 'Review' : 'Continue'}</Button>}</div>
        </>}
      </>}
    </section>
  </div>
}

function FieldWizard({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="field wizard-field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>
}

function SoftwareOption({
  option, selected, onSelect,
}: { option: (typeof softwareOptions)[number]; selected: boolean; onSelect: (software: InstallSoftware) => void }) {
  return <button type="button" className={`software-option ${selected ? 'selected' : ''}`} onClick={() => onSelect(option.id)}>
    <SoftwareLogo software={option.id} />
    <span><strong>{option.title}</strong><small>{option.description}</small></span>
    <span className="software-radio" />
  </button>
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'The local server request could not be completed.' }
