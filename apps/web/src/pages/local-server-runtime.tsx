import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Cpu, LoaderCircle, RefreshCw, Save, ShieldCheck } from 'lucide-react'
import type { JvmOptions, JavaRuntime, ServerRuntimeSettings, ServerRuntimeSettingsUpdate } from '@mmsmanager/shared'
import { getJavaRuntimes, scanJavaRuntimes, getServerRuntimeSettings, updateServerRuntimeSettings } from '../api/servers'
import { Badge, Button, Card, SectionHeading } from '../components/ui'
import { javaRuntimeLabel } from '../lib/java-runtime'
import { currentLocale, translateText } from '../i18n/catalog'

const defaultOptions: JvmOptions = { collector: 'default', maxGCPauseMs: null, parallelGcThreads: null, alwaysPreTouch: false, disableExplicitGc: false }
const tr = (value: string) => translateText(value, currentLocale())

function selectionReason(reason: ServerRuntimeSettings['javaSelectionReason'] | undefined): string {
  const labels: Record<ServerRuntimeSettings['javaSelectionReason'], string> = {
    'manual-selection': 'Manual runtime selection',
    'automatic-exact-minimum': 'Auto selected the exact declared minimum.',
    'automatic-lowest-meeting-minimum': 'Auto selected the lowest installed Java meeting the declared minimum.',
    'automatic-requirement-unknown': 'No declared Java minimum is available. Auto will not choose a runtime.',
    'automatic-no-runtime': 'No checked installed Java meets the declared minimum. Auto will not choose a runtime.',
    'automatic-scan-unavailable': 'Installed Java runtimes could not be checked. Auto will not choose a runtime.',
  }
  return reason ? tr(labels[reason]) : tr('Checking runtime selection…')
}

export function LocalServerRuntime({ serverId, managed, isAdmin }: { serverId: string; managed: boolean; isAdmin: boolean }) {
  const [settings, setSettings] = useState<ServerRuntimeSettings | null>(null)
  const [runtimes, setRuntimes] = useState<JavaRuntime[]>([])
  const [javaPath, setJavaPath] = useState('')
  const [javaSelectionMode, setJavaSelectionMode] = useState<'auto' | 'manual'>('manual')
  const [confirmCompatibilityOverride, setConfirmCompatibilityOverride] = useState(false)
  const [minMemoryMb, setMinMemoryMb] = useState('')
  const [maxMemoryMb, setMaxMemoryMb] = useState('')
  const [options, setOptions] = useState<JvmOptions>(defaultOptions)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin || !managed) { setLoading(false); return }
    const controller = new AbortController()
    void Promise.all([getServerRuntimeSettings(serverId, controller.signal), getJavaRuntimes(controller.signal)])
      .then(([current, checked]) => {
        if (controller.signal.aborted) return
        setSettings(current)
        setRuntimes(checked)
        setJavaSelectionMode(current.javaSelectionMode)
        setJavaPath(current.javaPath ?? checked[0]?.path ?? '')
        setConfirmCompatibilityOverride(current.javaCompatibilityOverrideConfirmed)
        setMinMemoryMb(String(current.minMemoryMb))
        setMaxMemoryMb(String(current.maxMemoryMb))
        setOptions(current.jvmOptions)
        setError(null)
      }).catch((issue: unknown) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : 'Runtime settings could not be loaded.')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [serverId, isAdmin, managed])

  useEffect(() => {
    const controller = new AbortController()
    const refreshAfterRestart = () => {
      void getServerRuntimeSettings(serverId, controller.signal).then(setSettings).catch((issue: unknown) => {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : 'Runtime settings could not be refreshed.')
      })
    }
    window.addEventListener('mmsmanager:server-restarted', refreshAfterRestart)
    return () => {
      controller.abort()
      window.removeEventListener('mmsmanager:server-restarted', refreshAfterRestart)
    }
  }, [serverId])

  const selectedRuntime = useMemo(() => runtimes.find((item) => item.path === javaPath) ?? null, [runtimes, javaPath])
  const selectedMajor = javaSelectionMode === 'auto' ? settings?.javaMajor ?? null : selectedRuntime?.major ?? (settings?.javaPath === javaPath ? settings.javaMajor : null)
  const compatibility = settings?.requiredJavaMajor === null || settings?.requiredJavaMajor === undefined || selectedMajor === null
    ? 'unknown'
    : selectedMajor < settings.requiredJavaMajor ? 'below-minimum' : 'meets-minimum'
  const needsOverride = javaSelectionMode === 'manual' && compatibility !== 'meets-minimum'

  async function refreshRuntimes() {
    setBusy(true); setError(null); setNotice(null)
    try {
      const found = await scanJavaRuntimes()
      setRuntimes(found)
      if (!javaPath && found[0]) setJavaPath(found[0].path)
      if (!found.length) setNotice('No Java runtime was found in the standard local locations. Use the Machine page to check a custom executable path.')
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Java runtime checks could not be completed.')
    } finally { setBusy(false) }
  }

  async function save() {
    const min = Number(minMemoryMb)
    const max = Number(maxMemoryMb)
    if ((javaSelectionMode === 'manual' && !javaPath) || (needsOverride && !confirmCompatibilityOverride) || !Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      setError(needsOverride && !confirmCompatibilityOverride ? 'Confirm the manual Java compatibility exception before saving.' : 'Choose a checked Java runtime and enter valid minimum and maximum memory values.')
      return
    }
    const input: ServerRuntimeSettingsUpdate = { javaSelectionMode, javaPath: javaSelectionMode === 'manual' ? javaPath : null, confirmCompatibilityOverride, minMemoryMb: min, maxMemoryMb: max, jvmOptions: options }
    setBusy(true); setError(null); setNotice(null)
    try {
      const updated = await updateServerRuntimeSettings(serverId, input)
      setSettings(updated)
      setJavaSelectionMode(updated.javaSelectionMode)
      setJavaPath(updated.javaPath ?? '')
      setConfirmCompatibilityOverride(false)
      setNotice(updated.restartRequired ? 'Settings saved. Restart required before the running process uses them.' : 'Settings saved for the next panel launch.')
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Runtime settings could not be saved.')
    } finally { setBusy(false) }
  }

  if (!isAdmin) return <Card className="local-lock-card"><span><ShieldCheck size={18} /></span><h3>{tr('Administrator access required')}</h3><p>{tr('Java runtime paths and JVM settings are visible only to workspace administrators.')}</p></Card>
  if (!managed) return <Card className="local-lock-card"><span><ShieldCheck size={18} /></span><h3>{tr('Imported server is read only')}</h3><p>{tr('Runtime changes are available only for servers created and managed by MMSManager.')}</p></Card>
  if (loading) return <Card><div className="local-properties-loading"><LoaderCircle size={15} className="spinner" /> {tr('Loading local runtime settings…')}</div></Card>

  return <div className="local-runtime-page">
    {(error || notice) && <div className={error ? 'local-runtime-alert' : 'local-saved-note'} role="status">{error ? <AlertTriangle size={15} /> : <Check size={14} />}<span>{error ?? notice}</span></div>}
    {settings?.restartRequired && <div className="local-restart-banner" role="status"><RefreshCw size={15} /><span><strong>{tr('Restart required')}</strong><small>{tr('Saved JVM settings apply after the next successful panel restart.')}</small></span></div>}
    <div className="local-runtime-grid">
      <Card className="local-runtime-settings-card">
        <SectionHeading title={tr('Java runtime')} description={tr('Choose how this server selects an installed, checked Java executable.')} action={<Badge tone={settings?.runtimeStatus === 'running' ? 'warn' : 'neutral'}>{tr(settings?.runtimeStatus ?? 'Unavailable')}</Badge>} />
        <label className="local-runtime-field"><span>{tr('Java selection')}</span><select aria-label={tr('Java selection')} value={javaSelectionMode} onChange={(event) => { setJavaSelectionMode(event.target.value as 'auto' | 'manual'); setConfirmCompatibilityOverride(false) }}><option value="auto">{tr('Auto')}</option><option value="manual">{tr('Manual')}</option></select></label>
        {javaSelectionMode === 'auto' ? <div className="local-runtime-selection" role="status"><div><span>{tr('Effective runtime')}</span><strong>{settings?.javaPath && selectedMajor ? <span data-no-translate>Java {selectedMajor}</span> : tr('No runtime selected')}</strong></div><p>{selectionReason(settings?.javaSelectionReason)}</p></div> : <>
          <label className="local-runtime-field"><span>{tr('Selected Java executable')}</span><select aria-label={tr('Selected Java executable')} value={javaPath} onChange={(event) => { setJavaPath(event.target.value); setConfirmCompatibilityOverride(false) }}>
            {!runtimes.some((item) => item.path === settings?.javaPath) && settings?.javaPath && <option value={settings.javaPath}>{translateText(`Saved Java ${settings.javaMajor ?? 'version unknown'} · recheck on save`, currentLocale())}</option>}
            {runtimes.map((runtime) => <option key={runtime.path} value={runtime.path} data-no-translate>{javaRuntimeLabel(runtime, runtimes)}</option>)}
          </select></label>
          <div className="local-runtime-inline-facts"><div><span>{tr('Selected version')}</span><strong>{selectedMajor ? <span data-no-translate>Java {selectedMajor}</span> : tr('Not verified')}</strong></div><div><span>{tr('Declared minimum')}</span><strong>{settings?.requiredJavaMajor ? <span data-no-translate>Java {settings.requiredJavaMajor}+</span> : tr('Unknown')}</strong></div></div>
          {compatibility === 'below-minimum' && <p className="local-inline-error" role="status">{tr('This runtime is below the declared Java minimum.')}</p>}
          {compatibility === 'unknown' && <p className="local-runtime-hint">{tr('The declared Java minimum is unknown. Manual selection requires explicit confirmation.')}</p>}
          {compatibility === 'meets-minimum' && <p className="local-runtime-hint">{tr('The declared minimum is met. This does not confirm compatibility with this server build.')}</p>}
          {needsOverride && <label className="local-runtime-override"><input type="checkbox" checked={confirmCompatibilityOverride} onChange={(event) => setConfirmCompatibilityOverride(event.target.checked)} /><span><strong>{tr('Confirm manual compatibility exception')}</strong><small>{tr('MMSManager will recheck this Java and require confirmation again if its version or the server requirement changes.')}</small></span></label>}
        </>}
        {javaSelectionMode === 'auto' && compatibility === 'meets-minimum' && settings?.requiredJavaMajor && selectedMajor && <p className="local-runtime-hint">{tr('The declared minimum is met. This does not confirm compatibility with this server build.')}</p>}
        <div className="local-runtime-controls"><Button icon={busy ? LoaderCircle : RefreshCw} disabled={busy} onClick={() => void refreshRuntimes()}>{busy ? tr('Checking…') : runtimes.length ? tr('Rescan Java') : tr('Check local Java')}</Button><small>{tr('Scanning runs only after this administrator request.')}</small></div>
      </Card>
      <Card className="local-runtime-settings-card">
        <SectionHeading title={tr('Memory allocation')} description={tr('Typed bounds used by panel launches. Maximum is limited to 128 GiB.')} />
        <div className="local-runtime-memory-grid">
          <label className="local-runtime-field"><span>{tr('Minimum memory')}</span><div className="local-runtime-number"><input aria-label={tr('Minimum memory')} type="number" min={512} max={131072} step={256} value={minMemoryMb} onChange={(event) => setMinMemoryMb(event.target.value)} /><i>{tr('MB')}</i></div></label>
          <label className="local-runtime-field"><span>{tr('Maximum memory')}</span><div className="local-runtime-number"><input aria-label={tr('Maximum memory')} type="number" min={512} max={131072} step={256} value={maxMemoryMb} onChange={(event) => setMaxMemoryMb(event.target.value)} /><i>{tr('MB')}</i></div></label>
        </div>
        <div className="local-runtime-memory-note"><Cpu size={14} /><span>{tr('Minecraft memory')}</span></div>
      </Card>
      <Card className="local-runtime-settings-card local-jvm-options-card">
        <SectionHeading title={tr('JVM tuning')} description={tr('Only supported, validated switches are available; arbitrary arguments are not accepted.')} />
        <div className="local-runtime-options-grid">
          <label className="local-runtime-field"><span>Garbage collector</span><select aria-label="Garbage collector" value={options.collector} onChange={(event) => setOptions((current) => ({ ...current, collector: event.target.value as JvmOptions['collector'], ...(event.target.value === 'default' ? { maxGCPauseMs: null, parallelGcThreads: null } : {}) }))}><option value="default">Java default</option><option value="g1">G1</option><option value="zgc">ZGC · Java 17+</option></select></label>
          <label className="local-runtime-field"><span>Maximum GC pause</span><div className="local-runtime-number"><input aria-label="Maximum GC pause" type="number" min={50} max={1000} step={10} disabled={options.collector === 'default'} value={options.maxGCPauseMs ?? ''} onChange={(event) => setOptions((current) => ({ ...current, maxGCPauseMs: event.target.value === '' ? null : Number(event.target.value) }))} /><i>{translateText('ms', currentLocale())}</i></div></label>
          <label className="local-runtime-field"><span>Parallel GC threads</span><div className="local-runtime-number"><input aria-label="Parallel GC threads" type="number" min={1} max={64} disabled={options.collector === 'default'} value={options.parallelGcThreads ?? ''} onChange={(event) => setOptions((current) => ({ ...current, parallelGcThreads: event.target.value === '' ? null : Number(event.target.value) }))} /><i>threads</i></div></label>
        </div>
        <div className="local-runtime-switches">
          <label><input type="checkbox" checked={options.alwaysPreTouch} onChange={(event) => setOptions((current) => ({ ...current, alwaysPreTouch: event.target.checked }))} /><span><strong>Pre-touch allocated memory</strong><small>Commit the configured heap before gameplay begins.</small></span></label>
          <label><input type="checkbox" checked={options.disableExplicitGc} onChange={(event) => setOptions((current) => ({ ...current, disableExplicitGc: event.target.checked }))} /><span><strong>Disable explicit GC calls</strong><small>Ignore application-triggered garbage collection requests.</small></span></label>
        </div>
        <div className="local-runtime-controls"><Button kind="primary" icon={busy ? LoaderCircle : Save} disabled={busy || (javaSelectionMode === 'manual' && !javaPath) || (needsOverride && !confirmCompatibilityOverride) || (options.collector === 'zgc' && (selectedMajor ?? 0) < 17)} onClick={() => void save()}>{busy ? tr('Saving…') : tr('Save runtime settings')}</Button><small>{tr('Changes never start or restart the server automatically.')}</small></div>
      </Card>
      <Card className="local-runtime-script-card"><SectionHeading title={tr('Manual launch script')} description={tr('MMSManager checks ownership before updating the generated convenience script.')} /><Badge tone={settings?.startScript === 'synchronized' ? 'good' : 'warn'}>{tr(settings?.startScript ?? 'Unavailable')}</Badge><p>{tr(settings?.startScript === 'synchronized' ? 'The generated start.sh matches the saved runtime profile.' : settings?.startScript === 'customized' ? 'The script was changed outside MMSManager. It was left untouched; panel launches still use saved settings.' : settings?.startScript === 'missing' ? 'No start.sh exists. Panel launches are unaffected.' : 'This existing script is not tracked, so MMSManager leaves it unchanged.')}</p></Card>
    </div>
  </div>
}
