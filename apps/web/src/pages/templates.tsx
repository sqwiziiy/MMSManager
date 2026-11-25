import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AlertTriangle, Check, Copy, Layers3, LoaderCircle, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import type { InstallSoftware, ServerTemplate, ServerTemplateInput } from '@mmsmanager/shared'
import { getInstallCatalog } from '../api/servers'
import { apiErrorMessage } from '../api/client'
import { createServerTemplate, deleteServerTemplate, duplicateServerTemplate, getServerTemplates, updateServerTemplate } from '../api/templates'
import { useAuth } from '../state/use-auth'
import { currentLocale } from '../i18n/catalog'
import { Badge, Button, Card, EmptyNote, PageHeading } from '../components/ui'

type EditorState = 'new' | ServerTemplate | null
type SupportState = 'checking' | 'supported' | 'unsupported' | 'unavailable'
type TemplateDraft = { name: string; software: InstallSoftware; version: string; minMemoryMb: number; maxMemoryMb: number }
const freshDraft: TemplateDraft = { name: '', software: 'vanilla', version: '', minMemoryMb: 1024, maxMemoryMb: 4096 }

export function TemplatesPage({ onCreate }: { onCreate: (template: ServerTemplate) => void }) {
  const { snapshot } = useAuth()
  const isAdmin = snapshot?.user.role === 'administrator'
  const [templates, setTemplates] = useState<ServerTemplate[]>([])
  const [draft, setDraft] = useState<TemplateDraft>(freshDraft)
  const [editor, setEditor] = useState<EditorState>(null)
  const [removeTarget, setRemoveTarget] = useState<ServerTemplate | null>(null)
  const [support, setSupport] = useState<Record<string, SupportState>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try { setTemplates(await getServerTemplates(signal)); setError('') }
    catch (issue) { if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(apiErrorMessage(issue, 'Saved templates could not be loaded.')) }
    finally { if (!signal?.aborted) setLoading(false) }
  }, [])
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load])

  const openCreate = () => { setDraft(freshDraft); setEditor('new'); setNotice(''); setError('') }
  const openEdit = (template: ServerTemplate) => { setDraft({ name: template.name, software: template.software, version: template.version, minMemoryMb: template.minMemoryMb, maxMemoryMb: template.maxMemoryMb }); setEditor(template); setNotice(''); setError('') }
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editor) return
    setBusy(true); setError('')
    const input: ServerTemplateInput = { ...draft, name: draft.name.trim(), version: draft.version.trim() }
    try {
      if (editor === 'new') await createServerTemplate(input)
      else await updateServerTemplate(editor.id, input)
      setEditor(null)
      setNotice(editor === 'new' ? 'Template saved for reuse.' : 'Template changes saved.')
      setSupport({})
      await load()
    } catch (issue) { setError(apiErrorMessage(issue, 'The template could not be saved.')) }
    finally { setBusy(false) }
  }
  const duplicate = async (template: ServerTemplate) => {
    setBusy(true); setError(''); setNotice('')
    try { await duplicateServerTemplate(template.id); setNotice(`A copy of “${template.name}” was created.`); await load() }
    catch (issue) { setError(apiErrorMessage(issue, 'The template could not be duplicated.')) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!removeTarget) return
    setBusy(true); setError('')
    try { await deleteServerTemplate(removeTarget.id); setNotice(`“${removeTarget.name}” was deleted.`); setRemoveTarget(null); await load() }
    catch (issue) { setError(apiErrorMessage(issue, 'The template could not be deleted.')) }
    finally { setBusy(false) }
  }
  const checkSupport = async (template: ServerTemplate) => {
    setSupport((current) => ({ ...current, [template.id]: 'checking' }))
    try {
      const catalog = await getInstallCatalog(template.software)
      setSupport((current) => ({ ...current, [template.id]: catalog.versions.includes(template.version) ? 'supported' : 'unsupported' }))
    } catch {
      setSupport((current) => ({ ...current, [template.id]: 'unavailable' }))
    }
  }
  const supportBadge = (template: ServerTemplate) => {
    const state = support[template.id]
    if (state === 'supported') return <Badge tone="good">Version available</Badge>
    if (state === 'unsupported') return <Badge tone="danger">Version unavailable</Badge>
    if (state === 'checking') return <Badge><LoaderCircle className="spin" size={12} /> Checking</Badge>
    if (state === 'unavailable') return <Badge tone="warn">Could not check</Badge>
    return <Badge tone="neutral">Not checked</Badge>
  }

  return <div className="page-stack">
    <PageHeading title="Templates" description="Saved safe defaults for creating local servers. A template never installs software or starts a server." actions={isAdmin ? <Button kind="primary" icon={Plus} onClick={openCreate}>New template</Button> : undefined} />
    <Card className="template-safety-note"><span><Layers3 size={16} /></span><div><strong>What a template remembers</strong><p>Server name, software version and memory range. Paths, Java choice, game port, EULA, online mode, credentials and world data always stay outside templates.</p><small>Version checks read provider metadata only. This screen does not download server files.</small></div></Card>
    {notice && <div className="notice-banner notice-success" role="status"><Check size={15} /><span>{notice}</span></div>}
    {error && <div className="monitor-offline-banner" role="alert"><span><AlertTriangle size={16} /><strong>Template action needs attention</strong><small>{error}</small></span><Button icon={RefreshCw} onClick={() => void load()}>Retry</Button></div>}
    {loading ? <Card><div className="local-server-empty"><span className="loading-pulse" />Loading saved templates…</div></Card>
      : templates.length ? <div className="template-grid">{templates.map((template) => {
        const versionUnavailable = support[template.id] === 'unsupported'
        return <Card className="template-card" key={template.id}>
          <div className="template-card-heading"><span className="template-icon"><Layers3 size={17} /></span><div><strong>{template.name}</strong><small>{template.software[0]!.toUpperCase() + template.software.slice(1)} · {template.version}</small></div>{supportBadge(template)}</div>
          <div className="template-specs"><div><span>Memory range</span><strong>{template.minMemoryMb.toLocaleString(currentLocale())}–{template.maxMemoryMb.toLocaleString(currentLocale())} MB</strong></div><div><span>Last updated</span><strong>{new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium' }).format(new Date(template.updatedAt))}</strong></div></div>
          <div className="template-card-note">Java, port and EULA are chosen separately in the create wizard.</div>
          <div className="template-actions">
            {isAdmin && <Button kind="primary" icon={Server} disabled={versionUnavailable} title={versionUnavailable ? 'This version is no longer in the available catalog.' : undefined} onClick={() => onCreate(template)}>Use template</Button>}
            {isAdmin && <Button kind="quiet" icon={RefreshCw} disabled={support[template.id] === 'checking'} title="Read the current version catalog; no server binary is downloaded." aria-label={`Check version support for ${template.name}`} onClick={() => void checkSupport(template)} />}
            {isAdmin && <Button kind="quiet" icon={Copy} disabled={busy} aria-label={`Duplicate ${template.name}`} onClick={() => void duplicate(template)} />}
            {isAdmin && <Button kind="quiet" icon={Pencil} disabled={busy} aria-label={`Edit ${template.name}`} onClick={() => openEdit(template)} />}
            {isAdmin && <Button kind="quiet" icon={Trash2} disabled={busy} aria-label={`Delete ${template.name}`} onClick={() => setRemoveTarget(template)} />}
          </div>
        </Card>
      })}</div> : <Card><EmptyNote icon={Layers3} title="No templates saved" detail={isAdmin ? 'Create a reusable preset for the safe server details you choose often.' : 'An administrator has not shared a server template yet.'} />{isAdmin && <div className="empty-state-actions"><Button kind="secondary" icon={Plus} onClick={openCreate}>Create first template</Button></div>}</Card>}

    {editor && <div className="local-file-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setEditor(null) }}><section className="local-file-dialog template-dialog" role="dialog" aria-modal="true" aria-labelledby="template-dialog-title">
      <div className="template-dialog-heading"><span className="template-icon"><Layers3 size={18} /></span><div><h2 id="template-dialog-title">{editor === 'new' ? 'New server template' : 'Edit template'}</h2><p>Safe creation defaults only. You can review them before installation.</p></div></div>
      <form onSubmit={(event) => void save(event)} className="template-form">
        <label>Template name<input required minLength={1} maxLength={60} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <div className="template-form-row"><label>Software<select value={draft.software} onChange={(event) => setDraft({ ...draft, software: event.target.value as InstallSoftware })}><option value="vanilla">Vanilla</option><option value="fabric">Fabric</option><option value="paper">Paper</option></select></label><label>Game version<input required inputMode="decimal" pattern="[0-9]{1,3}(\.[0-9]{1,3}){1,3}" placeholder="1.21.4" value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></label></div>
        <div className="template-form-row"><label>Minimum memory (MB)<input required type="number" min={512} max={131072} step={256} value={draft.minMemoryMb} onChange={(event) => setDraft({ ...draft, minMemoryMb: Number(event.target.value) })} /></label><label>Maximum memory (MB)<input required type="number" min={512} max={131072} step={256} value={draft.maxMemoryMb} onChange={(event) => setDraft({ ...draft, maxMemoryMb: Number(event.target.value) })} /></label></div>
        <div className="template-form-footnote"><AlertTriangle size={14} /><span>Saving a template does not create files, accept the EULA, download a provider artifact or start a Minecraft process.</span></div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="template-dialog-actions"><Button type="button" kind="secondary" disabled={busy} onClick={() => setEditor(null)}>Cancel</Button><Button kind="primary" icon={busy ? LoaderCircle : Check} disabled={busy}>{busy ? 'Saving…' : 'Save template'}</Button></div>
      </form>
    </section></div>}
    {removeTarget && <div className="local-file-dialog-backdrop"><section className="local-file-dialog template-dialog" role="alertdialog" aria-modal="true" aria-labelledby="template-delete-title"><div className="template-dialog-heading"><span className="template-icon warning"><Trash2 size={18} /></span><div><h2 id="template-delete-title">Delete “{removeTarget.name}”?</h2><p>Existing servers and their files are not affected.</p></div></div>{error && <p className="field-error" role="alert">{error}</p>}<div className="template-dialog-actions"><Button kind="secondary" disabled={busy} onClick={() => setRemoveTarget(null)}>Keep template</Button><Button kind="danger" icon={Trash2} disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete template'}</Button></div></section></div>}
  </div>
}
