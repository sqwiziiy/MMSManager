import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import type { LocalServerSummary } from '@mmsmanager/shared'
import { getLocalServers } from '../api/servers'
import { apiErrorMessage } from '../api/client'
import { PageHeading } from '../components/ui'
import { LocalServerDetail } from './local-server-detail'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function ServerDetailPage() {
  const { serverId } = useParams()
  const isLocalId = Boolean(serverId && uuidPattern.test(serverId))
  const [server, setServer] = useState<LocalServerSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!serverId || !isLocalId) {
      setServer(null)
      setError(null)
      setLoading(false)
      return
    }
    setServer(null)
    setLoading(true)
    try {
      const items = await getLocalServers(signal)
      setServer(items.find((item) => item.id === serverId) ?? null)
      setError(null)
    } catch (issue) {
      if (!(issue instanceof DOMException && issue.name === 'AbortError')) {
        setError(apiErrorMessage(issue, 'The local server inventory could not be loaded.'))
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [isLocalId, serverId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, reloadKey])

  if (!isLocalId) {
    return <div className="page-stack"><PageHeading title="Server not found" description="Only servers registered on this computer have detail pages." /><Link className="text-link" to="/servers">Return to servers <ArrowRight size={14} /></Link></div>
  }
  if (loading || (!server && !error)) {
    return <div className="page-stack"><PageHeading title="Loading local server" description="Reading the authenticated local registry." /><div className="local-server-empty"><span className="loading-pulse" /><span>Loading registered server details…</span></div></div>
  }
  if (error) {
    return <div className="page-stack"><PageHeading title="Local server unavailable" description={error} actions={<button className="button button-secondary" onClick={() => setReloadKey((key) => key + 1)}><RefreshCw size={14} />Retry</button>} /><Link className="text-link" to="/servers">Return to servers <ArrowRight size={14} /></Link></div>
  }
  if (!server) {
    return <div className="page-stack"><PageHeading title="Server not found" description="This server is not registered in the local inventory." /><Link className="text-link" to="/servers">Return to servers <ArrowRight size={14} /></Link></div>
  }
  return <LocalServerDetail server={server} />
}
