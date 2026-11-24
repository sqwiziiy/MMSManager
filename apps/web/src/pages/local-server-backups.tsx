import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, Archive, ArrowDownToLine, Check, Clock3, HardDrive, RefreshCw, RotateCcw, ShieldCheck, X,
} from 'lucide-react'
import type { ServerBackup, ServerBackupPreview } from '@mmsmanager/shared'
import { createServerBackup, downloadServerBackup, getServerBackups, previewServerBackup, restoreServerBackup } from '../api/servers'
import { Badge, Button, Card, SectionHeading } from '../components/ui'

type Props = { serverId: string; serverName: string; managed: boolean; isAdmin: boolean; runtimeStatus: string }

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function LocalServerBackups({ serverId, serverName, managed, isAdmin, runtimeStatus }: Props) {
  const [items, setItems] = useState<ServerBackup[]>([])
  const [storage, setStorage] = useState<{ used: number; limit: number; warning: boolean } | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<ServerBackupPreview | null>(null)
  const [confirmation, setConfirmation] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!isAdmin || !managed) { setLoading(false); return }
    try {
      const response = await getServerBackups(serverId, signal)
      setItems(response.items)
      setStorage({ used: response.storageUsedBytes, limit: response.storageLimitBytes, warning: response.quotaWarning })
      setTruncated(response.truncated)
      setError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) setError(issue instanceof Error ? issue.message : 'Backup inventory is unavailable.')
    } finally { setLoading(false) }
  }, [isAdmin, managed, serverId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  async function create() {
    setBusy(true); setError(null); setNotice(null)
    try {
      const backup = await createServerBackup(serverId)
      setNotice(`Backup verified and saved · ${formatBytes(backup.archiveSizeBytes)} archive`)
      await refresh()
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The backup could not be created.') }
    finally { setBusy(false) }
  }

  async function openPreview(backupId: string) {
    setBusy(true); setError(null); setNotice(null); setConfirmation('')
    try { setPreview(await previewServerBackup(serverId, backupId)) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'The backup preview could not be verified.') }
    finally { setBusy(false) }
  }

  async function download(backup: ServerBackup) {
    setBusy(true); setError(null); setNotice(null)
    try {
      const blob = await downloadServerBackup(serverId, backup.id)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `mmsmanager-${serverId}-${backup.id}.mmsbackup`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('Verified backup download started.')
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The backup download could not be completed.') }
    finally { setBusy(false) }
  }

  async function restore() {
    if (!preview || !preview.canRestore || confirmation !== preview.confirmationText) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await restoreServerBackup(serverId, preview.backup.id, confirmation)
      setPreview(null); setConfirmation('')
      setNotice(`Restore complete · safety snapshot ${result.safetyBackupId.slice(0, 8)}${result.rollbackCleanupPending ? ' · rollback cleanup needs attention' : ''}`)
      await refresh()
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The server restore could not be completed.') }
    finally { setBusy(false) }
  }

  if (!isAdmin) return <Card className="local-backups-card"><SectionHeading title="Administrator access required" description="Backups can contain private world and server data." /></Card>
  if (!managed) return <Card className="local-backups-card"><SectionHeading title="Backups unavailable" description="Imported folders remain read only. Only servers created by MMSManager can be backed up or restored." /></Card>

  const stopped = runtimeStatus === 'stopped'
  const usedPercent = storage ? Math.min(100, Math.round(storage.used / storage.limit * 100)) : 0

  return <div className="local-backups-stack">
    <Card className="local-backups-card">
      <div className="local-backups-head">
        <SectionHeading title="Private server snapshots" description="Stopped-server archives stored outside the live server folder." />
        <Button kind="primary" icon={busy ? RefreshCw : Archive} disabled={busy || !stopped} onClick={() => void create()}>
          {busy ? 'Working…' : 'Create backup'}
        </Button>
      </div>
      <div className="local-backup-summary">
        <div className="local-backup-summary-icon"><HardDrive size={16} /></div>
        <div className="local-backup-summary-copy"><span>Private storage budget</span><strong>{storage ? `${formatBytes(storage.used)} of ${formatBytes(storage.limit)}` : 'Loading storage usage…'}</strong><div className="local-backup-meter" aria-label={`${usedPercent}% of private backup storage used`}><span style={{ width: `${usedPercent}%` }} /></div></div>
        <Badge tone={storage?.warning ? 'warn' : 'good'}>{storage?.warning ? 'Budget alert' : 'No auto-delete'}</Badge>
      </div>
      {!stopped && <div className="local-backup-inline-warning" role="status"><AlertTriangle size={15} /><span>Creation and restore require a confirmed stopped state. Current state: {runtimeStatus}.</span></div>}
      {storage?.warning && <div className="local-backup-inline-warning" role="status"><AlertTriangle size={15} /><span>Storage is at least 80% of the 100 GiB budget. Existing backups are never deleted automatically.</span></div>}
      <div className="local-backup-policy"><ShieldCheck size={15} /><span>Local-only · private archive and manifest · SHA-256 checked · no scheduled deletion</span></div>
    </Card>

    {(error || notice) && <div className={error ? 'local-backup-message is-error' : 'local-backup-message is-success'} role="status">{error ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{error ?? notice}</span>{error && <Button icon={RefreshCw} onClick={() => void refresh()}>Retry</Button>}</div>}

    <Card className="local-backups-card">
      <SectionHeading title="Backup history" description="Every listed archive has a private manifest and durable checksum ledger." />
      {loading ? <div className="local-backups-empty"><RefreshCw size={16} />Loading real backup inventory…</div>
        : items.length === 0 ? <div className="local-backups-empty"><Archive size={18} /><span>No real backups yet. Create one while this server is stopped.</span></div>
          : <div className="local-backup-list">
            {items.map((backup) => <article className="local-backup-row" key={backup.id}>
              <div className="local-backup-icon"><Archive size={15} /></div>
              <div className="local-backup-row-main"><strong>{new Date(backup.createdAt).toLocaleString()}</strong><span>{formatBytes(backup.archiveSizeBytes)} archive · {backup.fileCount.toLocaleString()} files · {formatBytes(backup.totalFileBytes)} content</span><small>SHA-256 {backup.archiveSha256.slice(0, 16)}… · {backup.excludedCount ? `${backup.excludedCount} excluded paths` : 'no excluded paths'}</small></div>
              <Badge tone={backup.kind === 'manual' ? 'good' : 'neutral'}>{backup.kind === 'manual' ? 'Manual' : 'Pre-restore safety'}</Badge>
              <div className="local-backup-row-actions">
                <Button icon={ArrowDownToLine} disabled={busy} onClick={() => void download(backup)}>Download</Button>
                <Button icon={RotateCcw} disabled={busy} onClick={() => void openPreview(backup.id)}>Preview restore</Button>
              </div>
            </article>)}
            {truncated && <p className="data-note">Showing the 500 most recent snapshots. Storage usage includes all retained backups.</p>}
          </div>}
    </Card>

    {preview && <div className="local-file-dialog-backdrop"><section className="local-file-dialog local-backup-preview" role="dialog" aria-modal="true" aria-labelledby="backup-preview-title">
      <div className="local-file-dialog-heading"><span className="local-backup-icon"><RotateCcw size={16} /></span><div><h3 id="backup-preview-title">Preview server restore</h3><p>{new Date(preview.backup.createdAt).toLocaleString()} · {formatBytes(preview.backup.totalFileBytes)} content</p></div><button className="local-backup-close" aria-label="Close restore preview" onClick={() => setPreview(null)}><X size={16} /></button></div>
      <div className={preview.integrityValid ? 'local-backup-integrity is-good' : 'local-backup-integrity is-error'}>{preview.integrityValid ? <Check size={15} /> : <AlertTriangle size={15} />}<span>{preview.integrityValid ? 'Archive, manifest and per-file checksums verified.' : preview.issue ?? 'Integrity check failed. Restore is disabled.'}</span></div>
      {preview.integrityValid && <>
        <div className="local-backup-preview-stats"><div><span>Entries</span><strong>{preview.backup.entryCount.toLocaleString()}</strong></div><div><span>Files</span><strong>{preview.backup.fileCount.toLocaleString()}</strong></div><div><span>Archive</span><strong>{formatBytes(preview.backup.archiveSizeBytes)}</strong></div></div>
        {preview.excludedPaths.length > 0 && <div className="local-backup-inline-warning"><AlertTriangle size={15} /><span>{preview.backup.excludedCount} unsafe, credential-like, private-system or linked paths were skipped. The paths listed below are excluded from this snapshot.</span></div>}
        <div className="local-backup-path-list" aria-label="Sample of archived paths">{preview.entries.map((entry) => <div key={entry.path}><span>{entry.kind === 'directory' ? 'Folder' : 'File'}</span><code>{entry.path}</code><small>{entry.kind === 'file' ? formatBytes(entry.sizeBytes) : '—'}</small></div>)}{preview.entriesTruncated && <p className="data-note">Showing first 100 archive entries.</p>}</div>
        {preview.excludedPaths.length > 0 && <details className="local-backup-exclusions"><summary>Excluded paths ({preview.backup.excludedCount})</summary>{preview.excludedPaths.map((entry, index) => <div key={`${entry.path}-${index}`}><code>{entry.path}</code><small>{entry.reason}</small></div>)}{preview.excludedPathsTruncated && <small>Additional excluded paths are summarized in the manifest.</small>}</details>}
      </>}
      <div className="local-backup-inline-warning"><AlertTriangle size={15} /><span>Restoring replaces this managed server folder. MMSManager first saves and verifies a pre-restore safety snapshot. Restore is refused unless the server is stopped.</span></div>
      {!preview.serverStopped && <div className="local-backup-inline-warning"><Clock3 size={15} /><span>{preview.issue ?? 'Stop this server before restoring.'}</span></div>}
      {preview.canRestore && <label className="field local-backup-confirmation"><span className="field-label">Type <code>{preview.confirmationText}</code> to continue</span><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
      {error && <div className="local-inline-error" role="alert">{error}</div>}
      <div className="local-file-dialog-actions"><Button disabled={busy} onClick={() => setPreview(null)}>Cancel</Button><Button kind="primary" icon={busy ? RefreshCw : RotateCcw} disabled={busy || !preview.canRestore || !preview.integrityValid || confirmation !== preview.confirmationText} onClick={() => void restore()}>{busy ? 'Restoring…' : `Restore ${serverName}`}</Button></div>
    </section></div>}
  </div>
}
