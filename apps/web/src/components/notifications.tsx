import { useCallback, useEffect, useState } from 'react'
import { Bell, Check, CircleAlert, CircleCheck, ExternalLink, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { NotificationsResponse } from '@mmsmanager/shared'
import { ApiRequestError } from '../api/client'
import { getNotifications, markNotificationRead } from '../api/notifications'
import { Badge, Button } from './ui'
import { currentLocale, pluralCount } from '../i18n/catalog'

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function errorMessage(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Notifications could not be loaded from the local API.'
}

export function NotificationsPanel() {
  const [data, setData] = useState<NotificationsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      setData(await getNotifications(signal))
      setError(null)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return
      setError(errorMessage(caught))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const markRead = async (eventId: string) => {
    setBusyId(eventId)
    setError(null)
    try { setData(await markNotificationRead(eventId)) }
    catch (caught) { setError(errorMessage(caught)) }
    finally { setBusyId(null) }
  }

  return <div className="notification-panel" aria-live="polite">
    <div className="notification-toolbar">
      <div><Badge tone={data?.unreadCount ? 'accent' : 'neutral'}>{loading ? 'Updating' : pluralCount(data?.unreadCount ?? 0, currentLocale(), { en: ['unread notification', 'unread notifications'], ru: ['непрочитанное уведомление', 'непрочитанных уведомления', 'непрочитанных уведомлений'] })}</Badge><span>Operational events from this local workspace</span></div>
      <Button icon={RefreshCw} disabled={loading} onClick={() => void refresh()}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
    </div>
    {error && <div className="notification-error" role="alert"><CircleAlert size={16} /><span>{error}</span><Button onClick={() => void refresh()}>Retry</Button></div>}
    {loading && !data ? <div className="notification-empty"><RefreshCw size={18} /><strong>Loading saved alerts</strong><span>Checking operational history for this account.</span></div>
      : data?.items.length ? <div className="notification-list">{data.items.map(({ event, eventId, readAt }) => <article className={`notification-row ${readAt ? 'notification-read' : 'notification-unread'}`} key={eventId}>
        <span className={`notification-icon ${event.outcome === 'failure' ? 'notification-icon-failure' : ''}`}>{event.outcome === 'failure' ? <CircleAlert size={17} /> : <Bell size={17} />}</span>
        <div className="notification-copy">
          <div className="notification-title"><strong>{event.title}</strong>{event.serverName && <Badge>{event.serverName}</Badge>}{!readAt && <span className="notification-unread-dot" aria-label="Unread" />}</div>
          <p>{event.description}</p>
          <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
          {event.serverId && <Link className="notification-server-link" to={`/servers/${event.serverId}`}>Open server <ExternalLink size={12} /></Link>}
        </div>
        <div className="notification-state">{readAt ? <span className="notification-read-label"><CircleCheck size={14} /> Read</span>
          : <Button icon={busyId === eventId ? RefreshCw : Check} disabled={busyId !== null} onClick={() => void markRead(eventId)}>{busyId === eventId ? 'Saving…' : 'Mark read'}</Button>}</div>
      </article>)}</div>
        : !error ? <div className="notification-empty"><CircleCheck size={20} /><strong>You're all caught up</strong><span>Failures, missed backups and pending restarts will appear here when recorded.</span></div> : null}
  </div>
}
