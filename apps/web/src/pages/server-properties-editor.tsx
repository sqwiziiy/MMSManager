import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertTriangle, Archive, Check, Plus, RotateCcw, Search, Settings2 } from 'lucide-react'
import { serverPropertiesCatalog, serverPropertyAvailable } from '@mmsmanager/shared'
import type { ServerPropertiesResponse, ServerPropertiesRestorePreview, ServerPropertyCatalogEntry, ServerPropertySettings } from '@mmsmanager/shared'
import { Badge, Button, Card, SectionHeading } from '../components/ui'
import { currentLocale, translateText } from '../i18n/catalog'
import { getServerProperties, previewServerPropertiesRestore, restoreServerProperties, updateServerProperties } from '../api/servers'

type BasicField = { key: keyof ServerPropertySettings; property: string; label: string; kind: 'text' | 'number' | 'select' | 'switch'; options?: string[]; min?: number; max?: number; suffix?: string }

const basicFields: BasicField[] = [
  { key: 'onlineMode', property: 'online-mode', label: 'Online mode', kind: 'switch' },
  { key: 'motd', property: 'motd', label: 'Message of the day', kind: 'text' },
  { key: 'gameMode', property: 'gamemode', label: 'Default game mode', kind: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', property: 'difficulty', label: 'Difficulty', kind: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'maxPlayers', property: 'max-players', label: 'Player limit', kind: 'number', min: 1, max: 500, suffix: 'players' },
  { key: 'viewDistance', property: 'view-distance', label: 'View distance', kind: 'number', min: 3, max: 32, suffix: 'chunks' },
  { key: 'simulationDistance', property: 'simulation-distance', label: 'Simulation distance', kind: 'number', min: 3, max: 32, suffix: 'chunks' },
  { key: 'spawnProtection', property: 'spawn-protection', label: 'Spawn protection', kind: 'number', min: 0, max: 128, suffix: 'blocks' },
  { key: 'pvp', property: 'pvp', label: 'Player versus player', kind: 'switch' },
  { key: 'whiteList', property: 'white-list', label: 'Whitelist', kind: 'switch' },
  { key: 'allowNether', property: 'allow-nether', label: 'Nether dimension', kind: 'switch' },
]

const categoryLabels: Record<string, string> = {
  gameplay: 'Gameplay', world: 'World and generation', limits: 'Limits', status: 'Status and listing', resources: 'Resource pack', network: 'Network',
}
const catalog: readonly ServerPropertyCatalogEntry[] = serverPropertiesCatalog
const riskKey = (key: string) => key === 'level-name' ? 'levelName' : ['generate-structures', 'level-seed', 'level-type', 'generator-settings', 'region-file-compression'].includes(key) ? 'worldGeneration' : ['resource-pack', 'resource-pack-sha1', 'resource-pack-prompt', 'require-resource-pack'].includes(key) ? 'resourcePack' : key === 'server-port' ? 'gamePort' : null

function t(value: string): string { return translateText(value, currentLocale()) }
function labelTitle(value: string): string { return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }

export function ServerPropertiesEditor({ serverId, managed, runtimeStatus, serverPort, canEdit = true, canRestore = false }: { serverId: string; managed: boolean; runtimeStatus: string; serverPort: number | null; canEdit?: boolean; canRestore?: boolean }) {
  const [properties, setProperties] = useState<ServerPropertiesResponse | null>(null)
  const [draft, setDraft] = useState<ServerPropertySettings | null>(null)
  const [advancedDraft, setAdvancedDraft] = useState<Record<string, string>>({})
  const [section, setSection] = useState<'basic' | 'advanced'>('basic')
  const [search, setSearch] = useState('')
  const [extraKey, setExtraKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirmations, setConfirmations] = useState({ onlineMode: false, levelName: false, worldGeneration: false, resourcePack: false, gamePort: false })
  const [restorePreview, setRestorePreview] = useState<ServerPropertiesRestorePreview | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await getServerProperties(serverId, signal)
      setProperties(result); setDraft(result.settings); setAdvancedDraft({}); setError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(issue instanceof Error ? issue.message : 'Properties could not be loaded.')
    } finally { setLoading(false) }
  }, [serverId])
  useEffect(() => { const controller = new AbortController(); void reload(controller.signal); return () => controller.abort() }, [reload])

  const basicChanges = useMemo(() => Boolean(properties && draft && JSON.stringify(properties.settings) !== JSON.stringify(draft)), [draft, properties])
  const advancedChanges = useMemo(() => Boolean(properties && Object.entries(advancedDraft).some(([key, value]) => properties.advancedProperties[key] !== value)), [advancedDraft, properties])
  const dirty = basicChanges || advancedChanges
  const onlineModeChanged = Boolean(properties && draft && properties.settings.onlineMode !== draft.onlineMode)
  const advancedChangedKeys = useMemo(() => properties ? Object.entries(advancedDraft).filter(([key, value]) => properties.advancedProperties[key] !== value).map(([key]) => key) : [], [advancedDraft, properties])
  const risky = useMemo(() => ({
    levelName: advancedChangedKeys.includes('level-name'),
    worldGeneration: advancedChangedKeys.some((key) => riskKey(key) === 'worldGeneration'),
    resourcePack: advancedChangedKeys.some((key) => riskKey(key) === 'resourcePack'),
    gamePort: advancedChangedKeys.includes('server-port'),
  }), [advancedChangedKeys])
  const effectivePort = Number(properties?.advancedProperties['server-port'] ?? serverPort ?? 25565)
  const pendingPort = Number(advancedDraft['server-port'] ?? properties?.advancedProperties['server-port'] ?? serverPort ?? 25565)
  const offline = runtimeStatus === 'stopped'
  const temporarilyLocked = ['starting', 'stopping', 'external/unmanaged'].includes(runtimeStatus)
  const query = search.trim().toLocaleLowerCase(currentLocale())
  const filteredBasic = basicFields.filter((field) => !query || `${field.label} ${field.property} ${field.suffix ?? ''}`.toLocaleLowerCase(currentLocale()).includes(query))
  const filteredCatalog = catalog.filter((item) => !query || `${t(item.label)} ${t(item.description)} ${item.key} ${t(categoryLabels[item.category] ?? item.category)}`.toLocaleLowerCase(currentLocale()).includes(query))
  const addable = catalog.filter((item) => serverPropertyAvailable(item, properties?.serverSoftware ?? 'unknown', properties?.serverVersion ?? 'unknown') && !properties?.presentKeys.includes(item.key) && advancedDraft[item.key] === undefined)

  function setBasic(key: keyof ServerPropertySettings, value: string | number | boolean) {
    if (!canEdit) return
    setDraft((current) => current ? { ...current, [key]: value } as ServerPropertySettings : current)
    if (key === 'onlineMode') setConfirmations((state) => ({ ...state, onlineMode: false }))
    setSaved(false)
  }
  function setAdvanced(key: string, value: string) {
    if (!canEdit) return
    setAdvancedDraft((current) => ({ ...current, [key]: value }))
    const risk = riskKey(key)
    if (risk) setConfirmations((state) => ({ ...state, [risk]: false }))
    setSaved(false)
  }
  function addCatalogProperty() {
    if (!extraKey) return
    const item = serverPropertiesCatalog.find((entry) => entry.key === extraKey)
    if (item) { setAdvanced(item.key, item.defaultValue); setExtraKey('') }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!canEdit || !draft || !properties || !dirty) return
    setSaving(true); setError(null); setSaved(false)
    const basic = Object.fromEntries(Object.entries(draft).filter(([key, value]) => properties.settings[key as keyof ServerPropertySettings] !== value)) as Partial<ServerPropertySettings>
    const advanced = Object.fromEntries(Object.entries(advancedDraft).filter(([key, value]) => properties.advancedProperties[key] !== value))
    try {
      const result = await updateServerProperties(serverId, basic, properties.sha256, advanced, {
        confirmOnlineModeChange: onlineModeChanged && confirmations.onlineMode,
        confirmLevelNameChange: risky.levelName && confirmations.levelName,
        confirmWorldGenerationChange: risky.worldGeneration && confirmations.worldGeneration,
        confirmResourcePackChange: risky.resourcePack && confirmations.resourcePack,
        confirmGamePortChange: risky.gamePort && confirmations.gamePort,
      })
      setProperties(result); setDraft(result.settings); setAdvancedDraft({}); setSaved(true)
      setConfirmations({ onlineMode: false, levelName: false, worldGeneration: false, resourcePack: false, gamePort: false })
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Properties could not be saved.') }
    finally { setSaving(false) }
  }
  async function previewBackup(backupId: string) {
    if (!canRestore) return
    setError(null)
    try { setRestorePreview(await previewServerPropertiesRestore(serverId, backupId)) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'The recovery preview could not be loaded.') }
  }
  async function restoreBackup() {
    if (!canRestore || !restorePreview?.checksumValid) return
    setRestoreBusy(true); setError(null)
    try {
      const result = await restoreServerProperties(serverId, restorePreview.backupId, restorePreview.currentSha256)
      setProperties(result.properties); setDraft(result.properties.settings); setAdvancedDraft({}); setRestorePreview(null)
      setSaved(false)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The selected properties version could not be restored.') }
    finally { setRestoreBusy(false) }
  }

  if (!managed) return <Card><div className="empty-list"><strong>{t('Read only folder')}</strong><span>{t('Only a new server created by MMSManager can have managed properties. Imported folders are never edited.')}</span></div></Card>
  if (loading) return <div className="local-properties-loading"><span className="loading-pulse" /> {t('Reading the managed server.properties file…')}</div>
  if (!draft || !properties) return <Card className="local-properties-card"><div className="empty-list"><strong>{t('Properties unavailable')}</strong><span>{error ?? t('A safe managed properties file was not found.')}</span><Button onClick={() => void reload()}>{t('Retry')}</Button></div></Card>

  const configuredProtected = properties.protectedProperties.filter((item) => item.configured)
  const categories = [...new Set(filteredCatalog.map((item) => item.category))]
  const confirmationRows = [
    { key: 'onlineMode' as const, show: onlineModeChanged, title: 'Online-mode change', body: 'Changing this may create different player UUIDs and disconnect existing player data from those identities. Disabling it weakens Minecraft account verification. No player data is migrated, and this does not change MMSManager sign-in.', saved: properties.settings.onlineMode ? 'Enabled' : 'Disabled', pending: draft.onlineMode ? 'Enabled' : 'Disabled' },
    { key: 'levelName' as const, show: risky.levelName, title: 'World folder change', body: 'This selects another world folder. MMSManager will not rename, move or delete either folder.', saved: properties.advancedProperties['level-name'] ?? 'world', pending: advancedDraft['level-name'] ?? 'world' },
    { key: 'worldGeneration' as const, show: risky.worldGeneration, title: 'World generation change', body: 'This affects newly generated worlds or chunks. Existing terrain is not rewritten.', saved: 'Saved configuration', pending: 'Pending configuration' },
    { key: 'resourcePack' as const, show: risky.resourcePack, title: 'External resource pack', body: 'Players may be asked to download a pack from the configured external address. MMSManager does not fetch or verify it.', saved: 'Saved configuration', pending: 'Pending configuration' },
    { key: 'gamePort' as const, show: risky.gamePort, title: 'Game port change', body: 'This changes the Minecraft player connection port. The server must be stopped and the port must be free.', saved: String(effectivePort), pending: String(pendingPort) },
  ]

  return <div className="local-properties-layout"><Card className="local-properties-card">
    <div className="local-properties-header"><div><div className="card-kicker"><Settings2 size={15} /> {t('Safe editor')}</div><h3>{t('Server properties')}</h3><p>{t('Comments and unsupported keys are kept as they are.')}</p></div><Badge tone="good">{t('Managed file')}</Badge></div>
    {error && <div className="local-inline-error" role="status">{t(error)}</div>}{saved && <div className="local-saved-note" role="status"><Check size={15} /> {t('Saved with a recovery copy.')}</div>}
    {properties.restartRequired && <div className="local-restart-banner"><AlertTriangle size={15} /><span><strong>{t('Restart required')}</strong><small>{t('Saved configuration will take effect after the next server start.')}</small></span></div>}
    <div className="properties-controls"><div className="properties-tabs" role="tablist" aria-label={t('Property sections')}>
      <button type="button" role="tab" aria-selected={section === 'basic'} className={section === 'basic' ? 'active' : ''} onClick={() => setSection('basic')}>{t('Basic properties')}<span>{basicFields.length}</span></button>
      <button type="button" role="tab" aria-selected={section === 'advanced'} className={section === 'advanced' ? 'active' : ''} onClick={() => setSection('advanced')}>{t('Advanced properties')}<span>{serverPropertiesCatalog.length}</span></button>
    </div><label className="properties-search"><Search size={15} /><input aria-label={t('Search properties')} placeholder={t('Search by name, explanation or key')} value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
    <form onSubmit={(event) => void save(event)}>
      {section === 'basic' && <div className="properties-section"><div className="properties-section-heading"><div><h4>{t('Basic properties')}</h4><p>{t('Common server settings. Values marked inherited use the server default.')}</p></div><Badge><span data-no-translate>{properties.serverSoftware} · {properties.serverVersion}</span></Badge></div>
        {filteredBasic.length ? <div className="local-properties-grid">{filteredBasic.map((item) => {
          const present = properties.presentKeys.includes(item.property)
          const value = draft[item.key]
          const pending = value !== properties.settings[item.key]
          return <div className="field properties-field" key={item.key}><div className="properties-field-heading"><label className="field-label" htmlFor={'property-' + item.key}>{t(item.label)}</label><small>{pending ? t('Pending edit') : present ? t('Saved in file') : t('Inherited default')}</small></div>
            <code className="property-key">{item.property}</code>
            {item.kind === 'text' && <input id={'property-' + item.key} value={String(value)} maxLength={120} disabled={!canEdit || temporarilyLocked} onChange={(event) => setBasic(item.key, event.target.value)} />}
            {item.kind === 'number' && <div className="property-number-input"><input id={'property-' + item.key} type="number" value={Number(value)} min={item.min} max={item.max} disabled={!canEdit || temporarilyLocked} onChange={(event) => setBasic(item.key, event.target.value === '' ? item.min ?? 0 : Number(event.target.value))} /><span>{t(item.suffix ?? '')}</span></div>}
            {item.kind === 'select' && <select id={'property-' + item.key} value={String(value)} disabled={!canEdit || temporarilyLocked} onChange={(event) => setBasic(item.key, event.target.value)}>{item.options?.map((option) => <option key={option} value={option} data-no-translate>{labelTitle(option)}</option>)}</select>}
            {item.kind === 'switch' && <label className="property-toggle"><input type="checkbox" aria-label={t(item.label)} checked={Boolean(value)} disabled={!canEdit || temporarilyLocked || (item.key === 'onlineMode' && !offline)} onChange={(event) => setBasic(item.key, event.target.checked)} /><span /><strong>{t(value ? 'Enabled' : 'Disabled')}</strong></label>}
            {item.key === 'onlineMode' && <small className="field-hint">{t('Changes require a stopped server.')}</small>}
            {item.kind === 'number' && <small className="field-hint">{item.min}–{item.max} {t(item.suffix ?? '')}</small>}
            {item.key === 'motd' && <small className="field-hint">{t('Up to 120 characters')}</small>}
          </div>
        })}</div> : <div className="local-files-empty">{t('No basic settings match this search.')}</div>}
      </div>}
      {section === 'advanced' && <div className="properties-section"><div className="properties-section-heading"><div><h4>{t('Advanced properties')}</h4><p>{t('Typed settings supported by the detected server software and version.')}</p></div><Badge>{t('Catalog')} · <span data-no-translate>{properties.serverSoftware} {properties.serverVersion}</span></Badge></div>
        {canEdit && <div className="properties-add-row"><label><span>{t('Add catalog setting')}</span><select aria-label={t('Add catalog setting')} value={extraKey} disabled={temporarilyLocked} onChange={(event) => setExtraKey(event.target.value)}><option value="">{t('Choose a supported property')}</option>{addable.map((item) => <option key={item.key} value={item.key}>{t(item.label)} · {item.key}</option>)}</select></label><Button type="button" icon={Plus} disabled={!extraKey || temporarilyLocked} onClick={addCatalogProperty}>{t('Add setting')}</Button></div>}
        {categories.map((category) => <section className="properties-category" key={category}><h5>{t(categoryLabels[category] ?? category)}</h5><div className="local-properties-grid">{filteredCatalog.filter((item) => item.category === category).map((item) => {
          const supported = serverPropertyAvailable(item, properties.serverSoftware, properties.serverVersion)
          const present = properties.presentKeys.includes(item.key)
          const value = advancedDraft[item.key] ?? properties.advancedProperties[item.key] ?? item.defaultValue
          const disabled = !canEdit || !supported || temporarilyLocked
          const pending = advancedDraft[item.key] !== undefined && advancedDraft[item.key] !== properties.advancedProperties[item.key]
          return <div className={'field properties-field' + (!supported ? ' unsupported' : '')} key={item.key}><div className="properties-field-heading"><label className="field-label" htmlFor={'catalog-' + item.key}>{t(item.label)}</label><small>{!supported ? t('Unsupported here') : pending ? t('Pending edit') : present ? t('Saved in file') : t('Inherited default')}</small></div>
            <code className="property-key">{item.key}</code><span className="field-hint properties-description">{t(item.description)}</span>
            {item.kind === 'integer' && <small className="field-hint properties-range">{item.minimum}–{item.maximum} {t(item.suffix ?? '')}</small>}
            {item.kind === 'boolean' && <label className="property-toggle"><input id={'catalog-' + item.key} type="checkbox" checked={value === 'true'} disabled={disabled} onChange={(event) => setAdvanced(item.key, event.target.checked ? 'true' : 'false')} /><span /><strong>{t(value === 'true' ? 'Enabled' : 'Disabled')}</strong></label>}
            {item.kind === 'integer' && <div className="property-number-input"><input id={'catalog-' + item.key} type="number" value={value} min={item.minimum} max={item.maximum} disabled={disabled} onChange={(event) => setAdvanced(item.key, event.target.value)} /><span>{t(item.suffix ?? '')}</span></div>}
            {item.kind === 'enum' && <select id={'catalog-' + item.key} value={value} disabled={disabled} onChange={(event) => setAdvanced(item.key, event.target.value)}>{[...(item.options ?? []), ...(properties.serverSoftware === 'unknown' ? [] : item.softwareOptions?.[properties.serverSoftware] ?? [])].map((option) => <option key={option} value={option} data-no-translate>{option}</option>)}</select>}
            {item.kind === 'text' && <input id={'catalog-' + item.key} value={value} maxLength={item.key === 'resource-pack' ? 2048 : 4096} disabled={disabled} onChange={(event) => setAdvanced(item.key, event.target.value)} />}
            {item.kind === 'json' && <textarea id={'catalog-' + item.key} className="properties-json" spellCheck={false} rows={3} value={value} disabled={disabled} onChange={(event) => setAdvanced(item.key, event.target.value)} />}
          </div>
        })}</div></section>)}
        {properties.unsupportedKeys.length > 0 && <div className="properties-unsupported"><strong>{t('Unavailable for this server version')}</strong><span>{properties.unsupportedKeys.join(' · ')}</span></div>}
      </div>}
      {canEdit && confirmationRows.filter((row) => row.show).map((row) => <div className="online-mode-confirmation properties-risk-confirmation" role="group" aria-label={t(row.title)} key={row.key}><div><AlertTriangle size={16} /><div><strong>{t(row.title)}</strong><p>{t(row.body)} {t('Saved')}: <code className="property-value">{row.saved}</code> · {t('Pending')}: <code className="property-value">{row.pending}</code></p>{(row.key === 'onlineMode' || row.key === 'gamePort') && !offline && <small>{t('The server must be confirmed stopped before this setting can change.')}</small>}</div></div><label><input type="checkbox" checked={confirmations[row.key]} disabled={(row.key === 'onlineMode' || row.key === 'gamePort') && !offline} onChange={(event) => setConfirmations((state) => ({ ...state, [row.key]: event.target.checked }))} /> {t('I understand and confirm this change')}</label></div>)}
      <div className="local-properties-footer"><span>{canEdit ? dirty ? t('Unsaved changes') : t('All changes are saved') : t('Read only access')}</span>{canEdit && <div><Button type="button" disabled={!dirty || saving} onClick={() => { setDraft(properties.settings); setAdvancedDraft({}); setConfirmations({ onlineMode: false, levelName: false, worldGeneration: false, resourcePack: false, gamePort: false }) }}>{t('Discard')}</Button><Button kind="primary" icon={saving ? RotateCcw : Check} disabled={!dirty || saving || temporarilyLocked || (onlineModeChanged && (!offline || !confirmations.onlineMode)) || (risky.levelName && !confirmations.levelName) || (risky.worldGeneration && !confirmations.worldGeneration) || (risky.resourcePack && !confirmations.resourcePack) || (risky.gamePort && (!offline || !confirmations.gamePort))} type="submit">{saving ? t('Saving…') : t('Save properties')}</Button></div>}</div>
    </form>
  </Card><div className="local-properties-side">
    <Card><SectionHeading title={t('Configuration state')} description={t('Values in the form are pending until they are saved to server.properties.')} /><div className="properties-state-grid"><div><span>{t('Saved file')}</span><strong>{dirty ? t('Pending edits') : t('Up to date')}</strong></div><div><span>{t('Current process')}</span><strong>{properties.restartRequired ? t('Previous loaded settings') : runtimeStatus === 'running' ? t('Saved settings loaded') : runtimeStatus === 'stopped' ? t('Next server start') : t('Unavailable')}</strong></div><div><span>{t('Detected version')}</span><strong data-no-translate>{properties.serverSoftware} {properties.serverVersion}</strong></div><div><span>{t('Game port')}</span><strong>{pendingPort}{pendingPort !== effectivePort ? ' · ' + t('Pending') : ''}</strong></div><div><span>{t('Unrecognized keys')}</span><strong>{properties.unknownKeys.length}</strong></div><div><span>{t('Protected settings')}</span><strong>{configuredProtected.length}</strong></div></div>{temporarilyLocked && <p className="data-note">{t('Properties are temporarily read only while the process state is being confirmed.')}</p>}{configuredProtected.length > 0 && <div className="properties-protected-list">{configuredProtected.map((item) => <div key={item.key}><code className="property-key">{item.key}</code><small>{t(item.reason)}</small></div>)}</div>}{properties.unknownKeys.length > 0 && <p className="data-note">{t('Unrecognized keys remain unchanged. Values are hidden.')}</p>}</Card>
    <Card><SectionHeading title={t('Recovery copies')} description={t('Private snapshots made before each property change.')} /><div className="local-backup-list">{properties.backups.length ? properties.backups.map((backup) => <div key={backup.id}><span className="local-backup-icon"><Archive size={15} /></span><span><strong>{new Date(backup.createdAt).toLocaleString(currentLocale())}</strong><small data-no-translate>SHA-256 {backup.sha256.slice(0, 12)}…</small></span>{canRestore && <Button icon={RotateCcw} onClick={() => void previewBackup(backup.id)}>{t('Preview restore')}</Button>}</div>) : <span className="local-no-backups">{t('No property changes saved yet.')}</span>}</div><p className="data-note">{t('Preview compares supported settings. Secrets and unrecognized values are never shown.')}</p></Card>
  </div>{restorePreview && <div className="local-file-dialog-backdrop"><section className="local-file-dialog" role="dialog" aria-modal="true" aria-labelledby="property-restore-title"><div className="local-file-dialog-heading"><span className="local-backup-icon"><RotateCcw size={16} /></span><div><h3 id="property-restore-title">{t('Restore properties')}</h3><p>{t('Recovery copy from')} {new Date(restorePreview.createdAt).toLocaleString(currentLocale())}</p></div></div>{!restorePreview.checksumValid ? <div className="local-inline-error">{t('This recovery copy failed checksum validation. It cannot be restored.')}</div> : restorePreview.changedSettings.length ? <div className="local-property-diff"><div className="local-property-diff-head"><span>{t('Setting')}</span><span>{t('Current')}</span><span>{t('Restored')}</span></div>{restorePreview.changedSettings.map((change) => <div key={change.key}><strong className="property-key">{change.key}</strong><span className="property-value">{t(change.current)}</span><span className="property-value">{t(change.restored)}</span></div>)}</div> : <div className="local-files-empty">{t('No supported setting values differ.')}</div>}{restorePreview.otherContentDiffers && <p className="data-note">{t('Comments and unrecognized properties also differ. Their values stay hidden in this preview and will be restored exactly.')}</p>}{restorePreview.running && <div className="local-file-warning">{t('The server is running. Restored values apply after its next restart.')}</div>}{restorePreview.restartRequiredAfterRestore && !restorePreview.running && <div className="local-file-warning">{t('A restart is already required. Restoring settings will keep that state.')}</div>}<div className="local-file-dialog-actions"><Button disabled={restoreBusy} onClick={() => setRestorePreview(null)}>{t('Cancel')}</Button><Button kind="primary" icon={restoreBusy ? RotateCcw : Check} disabled={restoreBusy || !restorePreview.checksumValid || (restorePreview.changedSettings.length === 0 && !restorePreview.otherContentDiffers)} onClick={() => void restoreBackup()}>{restoreBusy ? t('Restoring…') : t('Restore this version')}</Button></div></section></div>}</div>
}
