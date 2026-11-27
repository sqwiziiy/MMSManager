import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle, Archive, ArrowDownToLine, Check, Clock3, HardDrive, RefreshCw, RotateCcw, Settings2, ShieldCheck, X,
} from 'lucide-react'
import type { ServerBackup, ServerBackupPreview } from '@mmsmanager/shared'
import { createServerBackup, downloadServerBackup, getServerBackups, previewServerBackup, restoreServerBackup } from '../api/servers'
import { Badge, Button, Card, SectionHeading } from '../components/ui'
import { currentLocale, translateText } from '../i18n/catalog'
import { ApiRequestError } from '../api/client'

type Props = { serverId: string; serverName: string; managed: boolean; canView: boolean; canCreate: boolean; isAdmin: boolean; runtimeStatus: string }

function formatBytes(value: number | null): string {
  const locale = currentLocale()
  if (value === null) return translateText('Unavailable', locale)
  const russian = locale === 'ru'
  const units = russian ? ['Б', 'КБ', 'МБ', 'ГБ'] : ['B', 'KB', 'MB', 'GB']
  if (value < 1024) return `${new Intl.NumberFormat(locale).format(value)} ${units[0]}`
  const divisor = value < 1024 * 1024 ? 1024 : value < 1024 * 1024 * 1024 ? 1024 * 1024 : 1024 * 1024 * 1024
  const unit = value < 1024 * 1024 ? units[1] : value < 1024 * 1024 * 1024 ? units[2] : units[3]
  const digits = value >= 1024 * 1024 * 1024 ? 2 : 1
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value / divisor)} ${unit}`
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function LocalServerBackups({ serverId, serverName, managed, canView, canCreate, isAdmin, runtimeStatus }: Props) {
  const navigate = useNavigate()
  const [items, setItems] = useState<ServerBackup[]>([])
  const [storage, setStorage] = useState<{ used: number; limit: number | null; available: number | null; warning: boolean } | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<ServerBackupPreview | null>(null)
  const [confirmation, setConfirmation] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!canView || !managed) { setLoading(false); return }
    try {
      const response = await getServerBackups(serverId, signal)
      setItems(response.items)
      setStorage({ used: response.storageUsedBytes, limit: response.storageLimitBytes, available: response.storageAvailableBytes, warning: response.quotaWarning })
      setTruncated(response.truncated)
      setError(null)
      setErrorCode(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) { setError(issue instanceof Error ? issue.message : 'Backup inventory is unavailable.'); setErrorCode(issue instanceof ApiRequestError ? issue.code : null) }
    } finally { setLoading(false) }
  }, [canView, managed, serverId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  async function create() {
    setBusy(true); setError(null); setErrorCode(null); setNotice(null)
    try {
      const backup = await createServerBackup(serverId)
      setNotice(`Backup verified and saved · ${formatBytes(backup.archiveSizeBytes)} archive`)
      await refresh()
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The backup could not be created.'); setErrorCode(issue instanceof ApiRequestError ? issue.code : null) }
    finally { setBusy(false) }
  }

  async function openPreview(backupId: string) {
    setBusy(true); setError(null); setErrorCode(null); setNotice(null); setConfirmation('')
    try { setPreview(await previewServerBackup(serverId, backupId)) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'The backup preview could not be verified.'); setErrorCode(issue instanceof ApiRequestError ? issue.code : null) }
    finally { setBusy(false) }
  }

  async function download(backup: ServerBackup) {
    setBusy(true); setError(null); setErrorCode(null); setNotice(null)
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
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The backup download could not be completed.'); setErrorCode(issue instanceof ApiRequestError ? issue.code : null) }
    finally { setBusy(false) }
  }

  async function restore() {
    if (!isAdmin || !preview || !preview.canRestore || confirmation !== preview.confirmationText) return
    setBusy(true); setError(null); setErrorCode(null); setNotice(null)
    try {
      const result = await restoreServerBackup(serverId, preview.backup.id, confirmation)
      setPreview(null); setConfirmation('')
      setNotice(`Restore complete · safety snapshot ${result.safetyBackupId.slice(0, 8)}${result.rollbackCleanupPending ? ' · rollback cleanup needs attention' : ''}`)
      await refresh()
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'The server restore could not be completed.'); setErrorCode(issue instanceof ApiRequestError ? issue.code : null) }
    finally { setBusy(false) }
  }

  if (!canView) return <Card className="local-backups-card"><SectionHeading title="Backup access not granted" description="Ask an Administrator for access to this server's backups." /></Card>
  if (!managed) return <Card className="local-backups-card"><SectionHeading title="Backups unavailable" description="Imported folders remain read only. Only servers created by MMSManager can be backed up or restored." /></Card>

  const stopped = runtimeStatus === 'stopped'
  const usedPercent = storage?.limit ? Math.min(100, Math.round(storage.used / storage.limit * 100)) : 0
  const limitError = ['BACKUP_ARCHIVE_LIMIT', 'BACKUP_ENTRY_LIMIT', 'BACKUP_MANIFEST_LIMIT', 'BACKUP_QUOTA_EXCEEDED', 'BACKUP_DISK_SPACE', 'BACKUP_SPACE_UNAVAILABLE', 'BACKUP_TIMEOUT'].includes(errorCode ?? '')

  return <div className="local-backups-stack">
    <Card className="local-backups-card">
      <div className="local-backups-head">
        <SectionHeading title="Private server snapshots" description="Stopped-server archives stored outside the live server folder." />
        {canCreate && <Button kind="primary" icon={busy ? RefreshCw : Archive} disabled={busy || !stopped} onClick={() => void create()}>
          {busy ? 'Working…' : 'Create backup'}
        </Button>}
      </div>
      <div className="local-backup-summary">
        <div className="local-backup-summary-icon"><HardDrive size={16} /></div>
        <div className="local-backup-summary-copy"><span>{translateText('Backup storage used', currentLocale())}</span><strong>{storage ? <><span data-no-translate>{formatBytes(storage.used)}</span>{storage.limit === null ? ` · ${translateText('No shared quota', currentLocale())}` : <> {translateText('of', currentLocale())} <span data-no-translate>{formatBytes(storage.limit)}</span></>}</> : 'Loading storage usage…'}</strong><small>{translateText('Free space on backup volume', currentLocale())}: <span data-no-translate>{storage ? formatBytes(storage.available) : '—'}</span></small>{storage?.limit !== null && storage && <div className="local-backup-meter" aria-label={translateText(`${usedPercent}% of private backup storage used`, currentLocale())}><span style={{ width: `${usedPercent}%` }} /></div>}</div>
        <Badge tone={storage?.warning ? 'warn' : 'good'}>{storage?.warning ? 'Budget alert' : storage?.limit === null ? 'Quota disabled' : 'No auto-delete'}</Badge>
      </div>
      {!stopped && <div className="local-backup-inline-warning" role="status"><AlertTriangle size={15} /><span>Creation and restore require a confirmed stopped state. Current state: {runtimeStatus}.</span></div>}
      {storage?.warning && <div className="local-backup-inline-warning" role="status"><AlertTriangle size={15} /><span>Backup storage is nearing its configured quota. Existing backups are never deleted automatically.</span></div>}
      <div className="local-backup-policy"><ShieldCheck size={15} /><span>Local-only · private archive and manifest · SHA-256 checked · no scheduled deletion</span></div>
    </Card>

    {(error || notice) && <div className={error ? 'local-backup-message is-error' : 'local-backup-message is-success'} role="status">{error ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{error ?? notice}</span>{error && isAdmin && limitError && <Button icon={Settings2} onClick={() => navigate('/settings?section=backup')}>{translateText('Backup settings', currentLocale())}</Button>}{error && <Button icon={RefreshCw} onClick={() => void refresh()}>{translateText('Retry', currentLocale())}</Button>}</div>}

    <Card className="local-backups-card">
      <SectionHeading title="Backup history" description="Every listed archive has a private manifest and durable checksum ledger." />
      {loading ? <div className="local-backups-empty"><RefreshCw size={16} />Loading real backup inventory…</div>
        : items.length === 0 ? <div className="local-backups-empty"><Archive size={18} /><span>No backups yet. Create one while this server is stopped.</span></div>
          : <div className="local-backup-list">
            {items.map((backup) => <article className="local-backup-row" key={backup.id}>
              <div className="local-backup-icon"><Archive size={15} /></div>
              <div className="local-backup-row-main"><strong data-no-translate>{formatDateTime(backup.createdAt)}</strong><span><span data-no-translate>{formatBytes(backup.archiveSizeBytes)}</span> {translateText('archive ·', currentLocale())} <span data-no-translate>{backup.fileCount.toLocaleString(currentLocale())}</span> {translateText('files ·', currentLocale())} <span data-no-translate>{formatBytes(backup.totalFileBytes)}</span> {translateText('content', currentLocale())}</span><small><span data-no-translate>SHA-256 {backup.archiveSha256.slice(0, 16)}…</span> · {backup.excludedCount ? `${backup.excludedCount} ${translateText('excluded paths', currentLocale())}` : translateText('No excluded paths', currentLocale())}</small></div>
              <Badge tone={backup.kind === 'manual' ? 'good' : 'neutral'}>{translateText(backup.kind === 'manual' ? 'Manual' : 'Pre-restore safety', currentLocale())}</Badge>
              <div className="local-backup-row-actions">
                <Button className="local-row-icon-action" icon={ArrowDownToLine} title={translateText('Download', currentLocale())} aria-label={`${translateText('Download', currentLocale())} ${serverName}`} disabled={busy} onClick={() => void download(backup)} />
                <Button className="local-row-icon-action" icon={RotateCcw} title={translateText(isAdmin ? 'Preview restore' : 'Inspect archive', currentLocale())} aria-label={`${translateText(isAdmin ? 'Preview restore' : 'Inspect archive', currentLocale())} ${serverName}`} disabled={busy} onClick={() => void openPreview(backup.id)} />
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
      {preview.canRestore && isAdmin && <label className="field local-backup-confirmation"><span className="field-label">Type <code>{preview.confirmationText}</code> to continue</span><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
      {error && <div className="local-inline-error" role="alert">{error}</div>}
      <div className="local-file-dialog-actions"><Button disabled={busy} onClick={() => setPreview(null)}>Close</Button>{isAdmin && <Button kind="primary" icon={busy ? RefreshCw : RotateCcw} disabled={busy || !preview.canRestore || !preview.integrityValid || confirmation !== preview.confirmationText} onClick={() => void restore()}>{busy ? 'Restoring…' : `Restore ${serverName}`}</Button>}</div>
    </section></div>}
  </div>
}
