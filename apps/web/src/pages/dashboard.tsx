import { ArrowRight, ArrowUpRight, Cpu, HardDrive, MemoryStick, Server, Users, Wifi } from 'lucide-react'
import { Link } from 'react-router-dom'
import { activities, formatMemory, getServerSummary, servers } from '../data'
import { MetricTrack, ResourceTimeline, WorldBlocks } from '../components/charts'
import { Badge, Card, PageHeading, PreviewFlag, StatusDot } from '../components/ui'

export function DashboardPage({ onCreate }: { onCreate: () => void }) {
  const summary = getServerSummary()
  return <div className="page-stack dashboard-page">
    <PageHeading eyebrow="Sunday, November 23" title="Dashboard" description="A clear view of the sample fleet and this local-node preview." />

    <div className="overview-strip" aria-label="Mock workspace summary">
      <div className="overview-number"><span className="overview-icon"><Server size={17} /></span><div><span>Servers online</span><strong>{summary.online}<small> / {summary.total}</small></strong></div></div>
      <div className="overview-number"><span className="overview-icon"><Users size={17} /></span><div><span>Players online</span><strong>{summary.players}<small> across the fleet</small></strong></div></div>
      <div className="overview-number"><span className="overview-icon"><MemoryStick size={17} /></span><div><span>Allocated memory</span><strong>{summary.allocatedMemory}<small> GB total</small></strong></div></div>
      <div className="overview-number overview-demo"><span className="overview-icon"><Cpu size={17} /></span><div><span>Local node load</span><strong>36<small>% mock</small></strong></div><PreviewFlag />
      </div>
    </div>

    <div className="dashboard-grid">
      <Card className="resource-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Cpu size={15} /> Local node resources</div><h2>Resource activity</h2></div><PreviewFlag /></div>
        <div className="resource-card-body"><ResourceTimeline /><div className="resource-breakdown"><div className="breakdown-title">Current sample</div><MetricTrack label="CPU" value={36} detail="8 cores · mock host" tone="accent" /><MetricTrack label="Memory" value={62} detail="9.9 / 16 GB" tone="blue" /><MetricTrack label="Storage" value={48} detail="240 / 500 GB" tone="amber" /></div></div>
        <div className="resource-card-foot"><span><span className="legend-dot accent" />CPU utilization</span><span><span className="legend-dot muted" />Last 24 hours</span><span className="source-note"><HardDrive size={13} /> Values are examples</span></div>
      </Card>

      <Card className="fleet-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Server size={15} /> Server fleet</div><h2>Server status</h2></div><Link className="text-link" to="/servers">View all <ArrowRight size={14} /></Link></div>
        <div className="fleet-list">{servers.map((server) => <Link className="fleet-row" to={`/servers/${server.id}`} key={server.id}>
          <WorldBlocks server={server} compact />
          <span className="fleet-row-main"><strong>{server.name}</strong><small>{server.software} · {server.version}</small></span>
          <span className="fleet-row-right"><span className="fleet-status"><StatusDot status={server.status} />{server.status}</span><small>{server.players}/{server.capacity} players</small></span>
        </Link>)}</div>
        <button className="fleet-create" onClick={onCreate}><span className="fleet-create-plus">+</span><span>Create a server preview</span><ArrowUpRight size={14} /></button>
      </Card>

      <Card className="activity-card">
        <div className="card-heading-row"><div><div className="card-kicker"><Wifi size={15} /> Recent activity</div><h2>Latest events</h2></div><Link className="text-link" to="/activity">Activity log <ArrowRight size={14} /></Link></div>
        <div className="activity-list">{activities.slice(0, 3).map((activity) => <div className="activity-row" key={activity.id}>
          <span className={`activity-marker marker-${activity.tone}`} />
          <div className="activity-copy"><strong>{activity.event}</strong><span>{activity.server} <span className="activity-dot-sep">·</span> {activity.detail}</span></div>
          <time>{activity.time}</time>
        </div>)}</div>
      </Card>

      <Card className="machine-card">
        <div className="card-heading-row"><div><div className="card-kicker"><HardDrive size={15} /> Node profile</div><h2>Local machine</h2></div><Badge tone="neutral">Preview</Badge></div>
        <div className="machine-card-body"><div className="machine-name"><span className="machine-icon"><Cpu size={20} /></span><div><strong>minepanel-node</strong><span>Linux host · sample profile</span></div><span className="machine-connection"><i /> Mock</span></div>
          <div className="machine-specs"><div><span>Processor</span><strong>8 cores</strong></div><div><span>Memory</span><strong>16 GB</strong></div><div><span>Storage</span><strong>500 GB</strong></div></div>
          <Link to="/machine" className="machine-link">View machine overview <ArrowRight size={14} /></Link>
        </div>
      </Card>
    </div>
  </div>
}

export function ServerTile({ server }: { server: (typeof servers)[number] }) {
  return <Link to={`/servers/${server.id}`} className="server-tile">
    <div className="server-tile-top"><WorldBlocks server={server} /><div><div className="server-tile-title"><strong>{server.name}</strong><Badge tone={server.status === 'Online' ? 'good' : 'neutral'}><StatusDot status={server.status} />{server.status}</Badge></div><p>{server.software} {server.version} <span>·</span> {server.world}</p></div></div>
    <div className="server-tile-metrics"><div><span>Players</span><strong>{server.players}<small> / {server.capacity}</small></strong></div><div><span>Memory</span><strong>{formatMemory(server.memoryUsed)}<small> / {server.memoryTotal} GB</small></strong></div><div><span>Uptime</span><strong>{server.uptime}</strong></div></div>
    <div className="server-tile-footer"><span>{server.address}</span><span>Open overview <ArrowRight size={13} /></span></div>
  </Link>
}
