import { currentLocale } from "../i18n/catalog"
import { useEffect, useState } from 'react'
import { AlertTriangle, BellRing, CalendarClock, Check, Clock3, LoaderCircle, Save, ShieldCheck } from 'lucide-react'
import type { ServerAutomation, ServerAutomationJob, ServerAutomationUpdate } from '@mmsmanager/shared'
import { acknowledgeServerAutomationJob, getServerAutomation, updateServerAutomation } from '../api/servers'
import { Badge, Button, Card, SectionHeading } from '../components/ui'

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function localDateTime(value: string | null, timeZone: string): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(currentLocale(), { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function jobLabel(job: ServerAutomationJob): string {
  if (job.status === 'completed') return 'Completed'
  if (job.status === 'running') return 'Running'
  if (job.status === 'missed') return job.acknowledgedAt ? 'Missed · acknowledged' : 'Missed'
  return 'Failed'
}

export function LocalServerAutomation({ serverId, managed, isAdmin }: { serverId: string; managed: boolean; isAdmin: boolean }) {
  const [automation, setAutomation] = useState<ServerAutomation | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily')
  const [localTime, setLocalTime] = useState('03:00')
  const [weekday, setWeekday] = useState('1')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!isAdmin || !managed) { setLoading(false); return }
    const controller = new AbortController()
    void getServerAutomation(serverId, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setAutomation(value)
      setEnabled(value.enabled)
      setFrequency(value.frequency)
      setLocalTime(value.localTime)
      setWeekday(String(value.weekday ?? 1))
      setError(null)
    }).catch((issue: unknown) => {
      if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : 'Automation settings could not be loaded.')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [serverId, isAdmin, managed])

  async function save() {
    const input: ServerAutomationUpdate = { enabled, frequency, localTime, weekday: frequency === 'weekly' ? Number(weekday) : null }
    setBusy(true); setError(null); setNotice(null)
    try {
      const updated = await updateServerAutomation(serverId, input)
      setAutomation(updated)
      setNotice(updated.enabled ? `Schedule saved in ${updated.timeZone}. The next backup will run only if the managed server is stopped.` : 'The backup schedule is disabled.')
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The backup schedule could not be saved.')
    } finally { setBusy(false) }
  }

  async function acknowledge(jobId: string) {
    setBusy(true); setError(null); setNotice(null)
    try {
      setAutomation(await acknowledgeServerAutomationJob(serverId, jobId))
      setNotice('Missed backup acknowledged. No backup was created for that time.')
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The missed backup could not be acknowledged.')
    } finally { setBusy(false) }
  }

  if (!isAdmin) return <Card className="local-lock-card"><span><ShieldCheck size={18} /></span><h3>Administrator access required</h3><p>Backup schedules and task history are available only to workspace administrators.</p></Card>
  if (!managed) return <Card className="local-lock-card"><span><ShieldCheck size={18} /></span><h3>Imported server is read only</h3><p>Automation is available only for servers created and managed by MMSManager.</p></Card>
  if (loading) return <Card><div className="local-properties-loading"><LoaderCircle size={15} className="spinner" /> Loading scheduled tasks…</div></Card>

  return <div className="local-automation-page">
    {(error || notice) && <div className={error ? 'local-runtime-alert' : 'local-saved-note'} role="status">{error ? <AlertTriangle size={15} /> : <Check size={14} />}<span>{error ?? notice}</span></div>}
    {automation?.unacknowledgedCount ? <div className="local-automation-alert" role="status"><BellRing size={15} /><span><strong>{automation.unacknowledgedCount} missed schedule{automation.unacknowledgedCount === 1 ? '' : 's'} need review.</strong><small>MMSManager does not create a delayed backup after the 10 minute catch-up window.</small></span></div> : null}
    <div className="local-automation-grid">
      <Card className="local-automation-settings-card">
        <SectionHeading title="Scheduled backups" description="A durable local schedule creates a regular snapshot while this server is stopped." action={<Badge tone={enabled ? 'good' : 'neutral'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>} />
        <label className="local-automation-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>Enable automatic backup</strong><small>No files are removed automatically. Snapshots count toward the shared storage quota.</small></span></label>
        <div className="local-automation-form-grid">
          <label className="local-runtime-field"><span>Frequency</span><select aria-label="Backup frequency" value={frequency} onChange={(event) => setFrequency(event.target.value as 'daily' | 'weekly')}><option value="daily">Every day</option><option value="weekly">Every week</option></select></label>
          {frequency === 'weekly' && <label className="local-runtime-field"><span>Day</span><select aria-label="Backup weekday" value={weekday} onChange={(event) => setWeekday(event.target.value)}>{weekdays.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
          <label className="local-runtime-field"><span>Local time</span><input aria-label="Backup local time" type="time" value={localTime} onChange={(event) => setLocalTime(event.target.value)} /></label>
        </div>
        <div className="local-automation-timezone"><CalendarClock size={15} /><span><strong>{automation?.timeZone ?? 'Local timezone'}</strong><small>Wall-clock schedule follows this configured timezone, including daylight-saving changes.</small></span></div>
        <div className="local-automation-facts"><div><span>Next run</span><strong>{automation?.enabled ? localDateTime(automation.nextRunAt, automation.timeZone) : 'Not scheduled'}</strong></div><div><span>Last run</span><strong>{localDateTime(automation?.lastRunAt ?? null, automation?.timeZone ?? 'UTC')}</strong></div><div><span>Last result</span><strong>{automation?.lastStatus ? automation.lastStatus : 'No scheduled run yet'}</strong></div></div>
        {automation?.lastError && <p className="local-inline-error" role="status">{automation.lastError}</p>}
        <div className="local-runtime-controls"><Button kind="primary" icon={busy ? LoaderCircle : Save} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save schedule'}</Button><small>A running, unmanaged, or unresolved-restore server will be reported as a failed task.</small></div>
      </Card>
      <Card className="local-automation-history-card">
        <SectionHeading title="Task history" description="Actual scheduler attempts from the local service." action={<Badge tone="neutral">{automation?.jobs.length ?? 0} recent</Badge>} />
        {automation?.jobs.length ? <div className="local-automation-job-list">{automation.jobs.map((job) => <div className={`local-automation-job ${job.status}`} key={job.id}>
          <span className="local-automation-job-icon">{job.status === 'completed' ? <Check size={15} /> : job.status === 'running' ? <LoaderCircle size={15} className="spinner" /> : job.status === 'missed' ? <Clock3 size={15} /> : <AlertTriangle size={15} />}</span>
          <span className="local-automation-job-main"><strong>{jobLabel(job)}</strong><small>Scheduled {localDateTime(job.scheduledFor, automation.timeZone)}</small>{job.errorMessage && <small className="local-automation-error-text">{job.errorMessage}</small>}</span>
          {job.status === 'missed' && !job.acknowledgedAt && <Button disabled={busy} onClick={() => void acknowledge(job.id)}>Acknowledge</Button>}
        </div>)}</div> : <div className="local-automation-empty"><CalendarClock size={18} /><strong>No scheduled task history</strong><span>When the enabled schedule reaches its next local time, its actual result will appear here.</span></div>}
      </Card>
    </div>
    <div className="local-detail-callout"><ShieldCheck size={15} /><span>Automation never stops or starts a server. Backups run only after the existing stopped-server and recovery checks pass. Missed or failed tasks are recorded; automatic retry is disabled.</span></div>
  </div>
}
