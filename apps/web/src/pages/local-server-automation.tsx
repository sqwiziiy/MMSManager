import { currentLocale } from "../i18n/catalog"
import { translateText } from '../i18n/catalog'
import { useEffect, useState } from 'react'
import { AlertTriangle, BellRing, CalendarClock, Check, Clock3, LoaderCircle, Save, ShieldCheck } from 'lucide-react'
import type { ServerAutomation, ServerAutomationJob, ServerRestartScheduleUpdate } from '@mmsmanager/shared'
import { acknowledgeServerAutomationJob, getServerAutomation, updateServerAutomation, updateServerRestartSchedule } from '../api/servers'
import { Badge, Button, Card, SectionHeading } from '../components/ui'

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const restartOutcomes: Record<string, string> = {
  pending: 'In progress', completed: 'Restart completed', 'players-online': 'Players are online', 'player-count-unknown': 'Player count could not be confirmed',
  'server-offline': 'Server is stopped or not ready', unmanaged: 'Server is not managed by MMSManager', conflict: 'Another operation is in progress',
  'pending-restore': 'Restore recovery is pending', 'pending-removal': 'Server removal is pending', 'deadline-reached': 'Wait window ended',
  missed: 'Missed schedule', interrupted: 'Interrupted after the app restarted; it was not replayed', 'restart-failed': 'Restart did not complete',
  'schedule-changed': 'Deferred attempt canceled after the schedule changed',
}

function tr(value: string): string { return translateText(value, currentLocale()) }

function localDateTime(value: string | null, timeZone: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(currentLocale(), { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function jobLabel(job: ServerAutomationJob): string {
  if (job.status === 'completed') return tr('Completed')
  if (job.status === 'running') return tr('Running')
  if (job.status === 'missed') return tr(job.acknowledgedAt ? 'Missed · acknowledged' : 'Missed')
  return tr('Failed')
}

function restartJobLabel(job: NonNullable<ServerAutomation['restartJobs']>[number]): string {
  if (job.status === 'deferred') return tr('Waiting to retry')
  if (job.status === 'executed') return tr('Restart completed')
  if (job.status === 'skipped') return tr('Skipped')
  if (job.status === 'failed') return tr('Restart failed')
  if (job.status === 'interrupted') return tr('Interrupted')
  if (job.status === 'missed') return tr('Missed')
  return tr('Running')
}

function outcomeLabel(outcome: string): string { return tr(restartOutcomes[outcome] ?? 'Restart did not complete') }
function restartStatusLabel(status: NonNullable<ServerAutomation['restartSchedule']['lastStatus']>): string {
  if (status === 'executed') return tr('Restart completed')
  if (status === 'skipped') return tr('Skipped')
  if (status === 'deferred') return tr('Waiting to retry')
  if (status === 'failed') return tr('Restart failed')
  if (status === 'interrupted') return tr('Interrupted')
  return tr('Missed')
}

export function LocalServerAutomation({ serverId, managed, isAdmin }: { serverId: string; managed: boolean; isAdmin: boolean }) {
  const [automation, setAutomation] = useState<ServerAutomation | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily')
  const [localTime, setLocalTime] = useState('03:00')
  const [weekday, setWeekday] = useState('1')
  const [restartEnabled, setRestartEnabled] = useState(false)
  const [restartFrequency, setRestartFrequency] = useState<'daily' | 'weekly'>('daily')
  const [restartLocalTime, setRestartLocalTime] = useState('03:00')
  const [restartWeekday, setRestartWeekday] = useState('1')
  const [onlyWhenEmpty, setOnlyWhenEmpty] = useState(true)
  const [waitPolicy, setWaitPolicy] = useState<'skip' | 'retry'>('skip')
  const [retryIntervalMinutes, setRetryIntervalMinutes] = useState(5)
  const [waitDeadlineMinutes, setWaitDeadlineMinutes] = useState(30)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  function applyAutomation(value: ServerAutomation) {
    setAutomation(value)
    setEnabled(value.enabled)
    setFrequency(value.frequency)
    setLocalTime(value.localTime)
    setWeekday(String(value.weekday ?? 1))
    setRestartEnabled(value.restartSchedule.enabled)
    setRestartFrequency(value.restartSchedule.frequency)
    setRestartLocalTime(value.restartSchedule.localTime)
    setRestartWeekday(String(value.restartSchedule.weekday ?? 1))
    setOnlyWhenEmpty(value.restartSchedule.onlyWhenEmpty)
    setWaitPolicy(value.restartSchedule.waitPolicy)
    setRetryIntervalMinutes(value.restartSchedule.retryIntervalMinutes)
    setWaitDeadlineMinutes(value.restartSchedule.waitDeadlineMinutes)
  }

  useEffect(() => {
    if (!isAdmin || !managed) { setLoading(false); return }
    const controller = new AbortController()
    void getServerAutomation(serverId, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      applyAutomation(value)
      setError(null)
    }).catch((issue: unknown) => {
      if (!controller.signal.aborted) setError(issue instanceof Error ? tr(issue.message) : tr('Automation settings could not be loaded.'))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [serverId, isAdmin, managed])

  async function saveBackups() {
    const input = { enabled, frequency, localTime, weekday: frequency === 'weekly' ? Number(weekday) : null }
    setBusy(true); setError(null); setNotice(null)
    try {
      setAutomation(await updateServerAutomation(serverId, input))
      setNotice(tr(enabled ? `Schedule saved in ${automation?.timeZone ?? 'the configured timezone'}. The next backup will run only if the managed server is stopped.` : 'The backup schedule is disabled.'))
    } catch (issue) {
      setError(issue instanceof Error ? tr(issue.message) : tr('The backup schedule could not be saved.'))
    } finally { setBusy(false) }
  }

  async function saveRestarts() {
    const input: ServerRestartScheduleUpdate = {
      enabled: restartEnabled,
      frequency: restartFrequency,
      localTime: restartLocalTime,
      weekday: restartFrequency === 'weekly' ? Number(restartWeekday) : null,
      onlyWhenEmpty,
      waitPolicy,
      retryIntervalMinutes,
      waitDeadlineMinutes,
    }
    setBusy(true); setError(null); setNotice(null)
    try {
      const updated = await updateServerRestartSchedule(serverId, input)
      setAutomation(updated)
      setNotice(tr(restartEnabled ? 'Restart schedule saved. It remains limited to a running server managed by MMSManager.' : 'The restart schedule is disabled.'))
    } catch (issue) {
      setError(issue instanceof Error ? tr(issue.message) : tr('The restart schedule could not be saved.'))
    } finally { setBusy(false) }
  }

  async function acknowledge(jobId: string) {
    setBusy(true); setError(null); setNotice(null)
    try {
      setAutomation(await acknowledgeServerAutomationJob(serverId, jobId))
      setNotice(tr('Missed backup acknowledged. No backup was created for that time.'))
    } catch (issue) {
      setError(issue instanceof Error ? tr(issue.message) : tr('The missed backup could not be acknowledged.'))
    } finally { setBusy(false) }
  }

  if (!isAdmin) return <Card className="local-lock-card"><span><ShieldCheck size={18} /></span><h3>{tr('Administrator access required')}</h3><p>{tr('Backup schedules and task history are available only to workspace administrators.')}</p></Card>
  if (!managed) return <Card className="local-lock-card"><span><ShieldCheck size={18} /></span><h3>{tr('Imported server is read only')}</h3><p>{tr('Automation is available only for servers created and managed by MMSManager.')}</p></Card>
  if (loading) return <Card><div className="local-properties-loading"><LoaderCircle size={15} className="spinner" /> {tr('Loading scheduled tasks…')}</div></Card>

  const restartSchedule = automation?.restartSchedule
  return <div className="local-automation-page">
    {(error || notice) && <div className={error ? 'local-runtime-alert' : 'local-saved-note'} role="status">{error ? <AlertTriangle size={15} /> : <Check size={14} />}<span>{error ?? notice}</span></div>}
    {automation?.unacknowledgedCount ? <div className="local-automation-alert" role="status"><BellRing size={15} /><span><strong>{automation.unacknowledgedCount} {tr(automation.unacknowledgedCount === 1 ? 'missed backup needs review.' : 'missed backups need review.')}</strong><small>{tr('MMSManager does not create a delayed backup after the 10 minute catch-up window.')}</small></span></div> : null}
    <div className="local-automation-grid">
      <Card className="local-automation-settings-card">
        <SectionHeading title={tr('Scheduled backups')} description={tr('A durable local schedule creates a regular snapshot while this server is stopped.')} action={<Badge tone={enabled ? 'good' : 'neutral'}>{tr(enabled ? 'Enabled' : 'Disabled')}</Badge>} />
        <label className="local-automation-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>{tr('Enable automatic backup')}</strong><small>{tr('No files are removed automatically. Snapshots count toward the shared storage quota.')}</small></span></label>
        <div className="local-automation-form-grid">
          <label className="local-runtime-field"><span>{tr('Frequency')}</span><select aria-label={tr('Backup frequency')} value={frequency} onChange={(event) => setFrequency(event.target.value as 'daily' | 'weekly')}><option value="daily">{tr('Every day')}</option><option value="weekly">{tr('Every week')}</option></select></label>
          {frequency === 'weekly' && <label className="local-runtime-field"><span>{tr('Day')}</span><select aria-label={tr('Backup weekday')} value={weekday} onChange={(event) => setWeekday(event.target.value)}>{weekdays.map((day, index) => <option key={day} value={index}>{tr(day)}</option>)}</select></label>}
          <label className="local-runtime-field"><span>{tr('Local time')}</span><input aria-label={tr('Backup local time')} type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></label>
        </div>
        <div className="local-automation-timezone"><CalendarClock size={15} /><span><strong>{automation?.timeZone ? <span data-no-translate>{automation.timeZone}</span> : tr('Local timezone')}</strong><small>{tr('Wall-clock schedule follows this configured timezone, including daylight-saving changes.')}</small></span></div>
        <div className="local-automation-facts"><div><span>{tr('Next backup')}</span><strong>{automation?.enabled ? localDateTime(automation.nextRunAt, automation.timeZone) : tr('Not scheduled')}</strong></div><div><span>{tr('Last backup')}</span><strong>{localDateTime(automation?.lastRunAt ?? null, automation?.timeZone ?? 'UTC')}</strong></div><div><span>{tr('Last result')}</span><strong>{automation?.lastStatus ? tr(automation.lastStatus) : tr('No scheduled run yet')}</strong></div></div>
        {automation?.lastError && <p className="local-inline-error" role="status">{tr(automation.lastError)}</p>}
        <div className="local-runtime-controls"><Button kind="primary" icon={busy ? LoaderCircle : Save} disabled={busy} onClick={() => void saveBackups()}>{busy ? tr('Saving…') : tr('Save backup schedule')}</Button><small>{tr('A running, unmanaged, or unresolved-restore server will be reported as a failed task.')}</small></div>
      </Card>

      <Card className="local-automation-settings-card">
        <SectionHeading title={tr('Scheduled restarts')} description={tr('Restart only a ready, running server managed by MMSManager. This schedule starts disabled.')} action={<Badge tone={restartEnabled ? 'good' : 'neutral'}>{tr(restartEnabled ? 'Enabled' : 'Disabled')}</Badge>} />
        <label className="local-automation-toggle"><input type="checkbox" checked={restartEnabled} onChange={(event) => setRestartEnabled(event.target.checked)} /><span><strong>{tr('Enable scheduled restart')}</strong><small>{tr('The server will never be started if it is offline, stopped, or unmanaged.')}</small></span></label>
        <div className="local-automation-form-grid">
          <label className="local-runtime-field"><span>{tr('Frequency')}</span><select aria-label={tr('Restart frequency')} value={restartFrequency} onChange={(event) => setRestartFrequency(event.target.value as 'daily' | 'weekly')}><option value="daily">{tr('Every day')}</option><option value="weekly">{tr('Every week')}</option></select></label>
          {restartFrequency === 'weekly' && <label className="local-runtime-field"><span>{tr('Day')}</span><select aria-label={tr('Restart weekday')} value={restartWeekday} onChange={(event) => setRestartWeekday(event.target.value)}>{weekdays.map((day, index) => <option key={day} value={index}>{tr(day)}</option>)}</select></label>}
          <label className="local-runtime-field"><span>{tr('Local time')}</span><input aria-label={tr('Restart local time')} type="time" value={restartLocalTime} onChange={(event) => setRestartLocalTime(event.target.value)} /></label>
        </div>
        <label className="local-automation-toggle"><input type="checkbox" checked={onlyWhenEmpty} onChange={(event) => setOnlyWhenEmpty(event.target.checked)} /><span><strong>{tr('Only when no players are online')}</strong><small>{tr('Uses a fresh player list from the owned server console. Unknown counts never mean zero.')}</small></span></label>
        {!onlyWhenEmpty && <p className="local-automation-warning" role="note"><AlertTriangle size={14} />{tr('Online players will not block this restart. Use this only when it is intentional.')}</p>}
        <div className="local-automation-form-grid local-automation-wait-grid">
          <label className="local-runtime-field"><span>{tr('When restart conditions are not met')}</span><select aria-label={tr('Restart wait policy')} value={waitPolicy} onChange={(event) => setWaitPolicy(event.target.value as 'skip' | 'retry')}><option value="skip">{tr('Skip at scheduled time')}</option><option value="retry">{tr('Wait and retry')}</option></select></label>
          {waitPolicy === 'retry' && <label className="local-runtime-field"><span>{tr('Retry interval, minutes')}</span><input aria-label={tr('Retry interval, minutes')} type="number" min={1} max={30} value={retryIntervalMinutes} onChange={(event) => setRetryIntervalMinutes(Math.min(30, Math.max(1, Number(event.target.value) || 1)))} />
            <small>{tr('Retry until this deadline')}</small><input aria-label={tr('Wait deadline, minutes')} type="number" min={1} max={180} value={waitDeadlineMinutes} onChange={(event) => setWaitDeadlineMinutes(Math.min(180, Math.max(1, Number(event.target.value) || 1)))} /></label>}
        </div>
        <div className="local-automation-timezone"><CalendarClock size={15} /><span><strong>{automation?.timeZone ? <span data-no-translate>{automation.timeZone}</span> : tr('Local timezone')}</strong><small>{tr('The local-time schedule follows daylight-saving changes.')}</small></span></div>
        <div className="local-automation-facts"><div><span>{tr('Next restart')}</span><strong>{restartSchedule?.enabled ? localDateTime(restartSchedule.nextRunAt, restartSchedule.timeZone) : tr('Not scheduled')}</strong></div><div><span>{tr('Last restart')}</span><strong>{localDateTime(restartSchedule?.lastRunAt ?? null, restartSchedule?.timeZone ?? 'UTC')}</strong></div><div><span>{tr('Last result')}</span><strong>{restartSchedule?.lastStatus ? `${restartStatusLabel(restartSchedule.lastStatus)}${restartSchedule.lastOutcome ? ` · ${outcomeLabel(restartSchedule.lastOutcome)}` : ''}` : tr('No scheduled run yet')}</strong></div></div>
        <div className="local-runtime-controls"><Button kind="primary" icon={busy ? LoaderCircle : Save} disabled={busy} onClick={() => void saveRestarts()}>{busy ? tr('Saving…') : tr('Save restart schedule')}</Button><small>{tr('A missed or deferred slot is recorded; an interrupted restart is never replayed.')}</small></div>
      </Card>

      <Card className="local-automation-history-card">
        <SectionHeading title={tr('Backup history')} description={tr('Actual scheduled backup attempts.')} action={<Badge tone="neutral">{automation?.jobs.length ?? 0} {tr('recent')}</Badge>} />
        {automation?.jobs.length ? <div className="local-automation-job-list">{automation.jobs.map((job) => <div className={`local-automation-job ${job.status}`} key={job.id}>
          <span className="local-automation-job-icon">{job.status === 'completed' ? <Check size={15} /> : job.status === 'running' ? <LoaderCircle size={15} className="spinner" /> : job.status === 'missed' ? <Clock3 size={15} /> : <AlertTriangle size={15} />}</span>
          <span className="local-automation-job-main"><strong>{jobLabel(job)}</strong><small>{tr('Scheduled')} {localDateTime(job.scheduledFor, automation.timeZone)}</small>{job.errorMessage && <small className="local-automation-error-text">{tr(job.errorMessage)}</small>}</span>
          {job.status === 'missed' && !job.acknowledgedAt && <Button disabled={busy} onClick={() => void acknowledge(job.id)}>{tr('Acknowledge')}</Button>}
        </div>)}</div> : <div className="local-automation-empty"><CalendarClock size={18} /><strong>{tr('No scheduled backup history')}</strong><span>{tr('Backup attempts appear here after the enabled schedule runs.')}</span></div>}
      </Card>

      <Card className="local-automation-history-card">
        <SectionHeading title={tr('Restart history')} description={tr('Each scheduled slot is recorded once, including safe skips.')} action={<Badge tone="neutral">{automation?.restartJobs.length ?? 0} {tr('recent')}</Badge>} />
        {automation?.restartJobs.length ? <div className="local-automation-job-list">{automation.restartJobs.map((job) => <div className={`local-automation-job ${job.status}`} key={job.id}>
          <span className="local-automation-job-icon">{job.status === 'executed' ? <Check size={15} /> : job.status === 'running' || job.status === 'deferred' ? <LoaderCircle size={15} className="spinner" /> : job.status === 'missed' ? <Clock3 size={15} /> : <AlertTriangle size={15} />}</span>
          <span className="local-automation-job-main"><strong>{restartJobLabel(job)}</strong><small>{tr('Scheduled')} {localDateTime(job.scheduledFor, restartSchedule?.timeZone ?? 'UTC')}</small><small>{outcomeLabel(job.outcome)}{job.status === 'deferred' && job.nextAttemptAt ? ` · ${tr('Next attempt')} ${localDateTime(job.nextAttemptAt, restartSchedule?.timeZone ?? 'UTC')}` : ''}</small></span>
        </div>)}</div> : <div className="local-automation-empty"><CalendarClock size={18} /><strong>{tr('No scheduled restart history')}</strong><span>{tr('Restart attempts, deferrals, and skips appear here.')}</span></div>}
      </Card>
    </div>
    <div className="local-detail-callout"><ShieldCheck size={15} /><span>{tr('Backups run only while the server is stopped. Scheduled restarts require an already-running owned process and use graceful stop/start checks. A player can join after the final count check, so that check cannot prevent every last-second join.')}</span></div>
  </div>
}
